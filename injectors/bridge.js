(function () {
  'use strict';

  const RETRY_DELAY = 400;
  const MAX_RETRIES = 120;
  const isTopLevel = window.top === window;
  const isDirectPanelChild = !isTopLevel && window.parent === window.top;

  let provider;
  let handler;
  let deliveredPayloadIds = new Set();
  let registrationId = 0;
  let extensionOrigin;
  let panelMessageListener;
  let readyRegistrationId = 0;

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

  async function deliverPayload(activeRegistrationId, payloadId, payload, payloadHandler) {
    if (registrationId !== activeRegistrationId || deliveredPayloadIds.has(payloadId)) return;
    deliveredPayloadIds.add(payloadId);
    try {
      await payloadHandler(payload);
    } catch (error) {
      console.error('PageMind payload handler failed', error);
    }
  }

  function isValidDelivery(payloadId, payload) {
    return typeof payloadId === 'string'
      && payloadId.length > 0
      && payload !== null
      && typeof payload === 'object';
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
        if (!isValidDelivery(response?.payloadId, response?.payload)) {
          retryForRegistration(activeRegistrationId, retries, (remaining) => {
            requestTabPayload(activeRegistrationId, remaining);
          });
          return;
        }
        void deliverPayload(
          activeRegistrationId,
          response.payloadId,
          response.payload,
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
    panelMessageListener = (event) => {
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

      void deliverPayload(activeRegistrationId, data.payloadId, data.payload, payloadHandler);
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
    deliveredPayloadIds = new Set();
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
