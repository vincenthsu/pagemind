(function () {
  'use strict';

  const RETRY_DELAY = 400;
  const MAX_RETRIES = 120;
  const PAYLOAD_TTL_MS = 60_000;
  const MAX_COMPLETED_PAYLOAD_IDS = 256;
  const isTopLevel = window.top === window;
  const isDirectPanelChild = !isTopLevel && window.parent === window.top;

  let provider;
  let handler;
  let deliveryState = createDeliveryState();
  let registrationId = 0;
  let extensionOrigin;
  let panelMessageListener;
  let readyRegistrationId = 0;

  function createDeliveryState() {
    return {
      deliveredPayloadIds: new Set(),
      inFlightPayloadIds: new Set(),
    };
  }

  function getRuntime() {
    const runtime = globalThis.chrome?.runtime;
    return runtime && typeof runtime === 'object' ? runtime : null;
  }

  function retryForRegistration(activeRegistrationId, retries, callback) {
    if (retries <= 0) return;
    setTimeout(() => {
      if (registrationId === activeRegistrationId) {
        callback(retries - 1);
      }
    }, RETRY_DELAY);
  }

  function isPayloadCurrent(payload) {
    const now = Date.now();
    const createdAt = payload?.createdAt;
    const age = now - createdAt;
    return Number.isFinite(now)
      && Number.isFinite(createdAt)
      && Number.isFinite(age)
      && age >= 0
      && age <= PAYLOAD_TTL_MS;
  }

  function rememberCompleted(activeDeliveryState, payloadId) {
    activeDeliveryState.deliveredPayloadIds.add(payloadId);
    if (activeDeliveryState.deliveredPayloadIds.size > MAX_COMPLETED_PAYLOAD_IDS) {
      const oldestPayloadId = activeDeliveryState.deliveredPayloadIds.values().next().value;
      activeDeliveryState.deliveredPayloadIds.delete(oldestPayloadId);
    }
  }

  async function deliverPayload(activeRegistrationId, payloadId, payload, payloadHandler) {
    const activeDeliveryState = deliveryState;
    if (registrationId !== activeRegistrationId) return 'ignored';
    if (activeDeliveryState.deliveredPayloadIds.has(payloadId)) return 'completed';
    if (activeDeliveryState.inFlightPayloadIds.has(payloadId)) return 'in-flight';
    if (!isPayloadCurrent(payload)) return 'expired';
    activeDeliveryState.inFlightPayloadIds.add(payloadId);
    const deliveryContext = Object.freeze({
      isCurrent: () => (
        registrationId === activeRegistrationId && isPayloadCurrent(payload)
      ),
    });
    try {
      await payloadHandler(payload, deliveryContext);
      if (registrationId !== activeRegistrationId) return 'ignored';
      if (!isPayloadCurrent(payload)) return 'expired';
      rememberCompleted(activeDeliveryState, payloadId);
      return 'delivered';
    } catch (error) {
      console.error('PageMind payload handler failed', error);
      return 'failed';
    } finally {
      activeDeliveryState.inFlightPayloadIds.delete(payloadId);
    }
  }

  function isValidDelivery(payloadId, payload) {
    return typeof payloadId === 'string'
      && payloadId.length > 0
      && payload !== null
      && typeof payload === 'object';
  }

  async function deliverTabPayload(
    activeRegistrationId,
    retries,
    payload,
    payloadHandler,
  ) {
    const result = await deliverPayload(
      activeRegistrationId,
      payload.id,
      payload,
      payloadHandler,
    );
    if (result !== 'failed' || registrationId !== activeRegistrationId) return;
    retryForRegistration(activeRegistrationId, retries, (remaining) => {
      void deliverTabPayload(activeRegistrationId, remaining, payload, payloadHandler);
    });
  }

  function requestTabPayload(activeRegistrationId, retries = MAX_RETRIES) {
    if (!isTopLevel || registrationId !== activeRegistrationId) return;
    const runtime = getRuntime();
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      retryForRegistration(activeRegistrationId, retries, (remaining) => {
        requestTabPayload(activeRegistrationId, remaining);
      });
      return;
    }

    const requestProvider = provider;
    const payloadHandler = handler;
    try {
      runtime.sendMessage({
        type: 'GET_PAYLOAD',
        provider: requestProvider,
        context: 'tab',
      }, (response) => {
        void runtime.lastError;
        if (registrationId !== activeRegistrationId) return;
        const payload = response?.payload;
        if (!isValidDelivery(payload?.id, payload)) {
          retryForRegistration(activeRegistrationId, retries, (remaining) => {
            requestTabPayload(activeRegistrationId, remaining);
          });
          return;
        }
        void deliverTabPayload(
          activeRegistrationId,
          retries,
          payload,
          payloadHandler,
        );
      });
    } catch (_error) {
      retryForRegistration(activeRegistrationId, retries, (remaining) => {
        requestTabPayload(activeRegistrationId, remaining);
      });
    }
  }

  function announcePanelReady(activeRegistrationId) {
    if (
      registrationId !== activeRegistrationId
      || readyRegistrationId === activeRegistrationId
      || !extensionOrigin
    ) return;
    readyRegistrationId = activeRegistrationId;
    window.parent.postMessage({ type: 'PANEL_READY', provider }, extensionOrigin);
  }

  function installPanelMessageListener(activeRegistrationId) {
    if (panelMessageListener) {
      window.removeEventListener('message', panelMessageListener);
    }
    const registeredProvider = provider;
    const payloadHandler = handler;
    const registeredOrigin = extensionOrigin;
    panelMessageListener = async (event) => {
      const data = event.data;
      if (
        registrationId !== activeRegistrationId
        || event.source !== window.parent
        || event.origin !== registeredOrigin
        || data?.type !== 'PAGE_MIND_DELIVER'
        || data.provider !== registeredProvider
        || !Number.isInteger(data.windowId)
        || !isValidDelivery(data.payloadId, data.payload)
      ) return;

      const result = await deliverPayload(
        activeRegistrationId,
        data.payloadId,
        data.payload,
        payloadHandler,
      );
      if (
        (result !== 'delivered' && result !== 'completed')
        || registrationId !== activeRegistrationId
      ) return;
      window.parent.postMessage({
        type: 'PAGE_MIND_DELIVERED',
        provider: registeredProvider,
        windowId: data.windowId,
        payloadId: data.payloadId,
      }, registeredOrigin);
    };
    window.addEventListener('message', panelMessageListener);
  }

  function initializePanel(activeRegistrationId, retries = MAX_RETRIES) {
    if (!isDirectPanelChild || registrationId !== activeRegistrationId) return;
    const runtime = getRuntime();
    if (!runtime || typeof runtime.getURL !== 'function') {
      retryForRegistration(activeRegistrationId, retries, (remaining) => {
        initializePanel(activeRegistrationId, remaining);
      });
      return;
    }

    try {
      extensionOrigin = runtime.getURL('').replace(/\/$/, '');
    } catch (_error) {
      retryForRegistration(activeRegistrationId, retries, (remaining) => {
        initializePanel(activeRegistrationId, remaining);
      });
      return;
    }
    installPanelMessageListener(activeRegistrationId);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        announcePanelReady(activeRegistrationId);
      }, { once: true });
    } else {
      announcePanelReady(activeRegistrationId);
    }
  }

  function register(providerId, payloadHandler) {
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throw new TypeError('providerId must be a nonempty string');
    }
    if (typeof payloadHandler !== 'function') {
      throw new TypeError('payloadHandler must be a function');
    }

    provider = providerId;
    handler = payloadHandler;
    deliveryState = createDeliveryState();
    registrationId += 1;
    const activeRegistrationId = registrationId;

    if (isTopLevel) {
      requestTabPayload(activeRegistrationId);
    } else if (isDirectPanelChild) {
      initializePanel(activeRegistrationId);
    }
  }

  globalThis.PageMindBridge = Object.freeze({ register });
})();
