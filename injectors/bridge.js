(function () {
  'use strict';

  const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
  const isTopLevel = window.top === window;
  const isDirectPanelChild = !isTopLevel && window.parent === window.top;

  let provider;
  let handler;
  let lastPayloadId;
  let registrationId = 0;

  function requestPayload(windowId, retries = 120) {
    if (!provider || !handler || (!isTopLevel && !isDirectPanelChild)) return;
    const requestRegistration = registrationId;
    const requestProvider = provider;
    const requestHandler = handler;

    const retry = () => {
      if (retries > 0) {
        setTimeout(() => {
          if (registrationId === requestRegistration) {
            requestPayload(windowId, retries - 1);
          }
        }, 500);
      }
    };

    try {
      chrome.runtime.sendMessage({
        type: 'GET_PAYLOAD',
        provider: requestProvider,
        context: isTopLevel ? 'tab' : 'sidepanel',
        windowId,
      }, async (response) => {
        void chrome.runtime.lastError;
        if (registrationId !== requestRegistration) return;
        const payload = response?.payload;
        if (!payload) {
          retry();
          return;
        }
        if (payload.id === lastPayloadId) return;

        lastPayloadId = payload.id;
        try {
          await requestHandler(payload);
        } catch (error) {
          console.error('PageMind payload handler failed', error);
        }
      });
    } catch (_error) {
      retry();
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
    lastPayloadId = undefined;
    registrationId += 1;

    if (isTopLevel) {
      requestPayload();
    } else if (isDirectPanelChild) {
      window.parent.postMessage({
        type: 'PAGEMIND_PROVIDER_READY',
        provider,
      }, EXTENSION_ORIGIN);
    }
  }

  if (isDirectPanelChild) {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (
        event.source !== window.parent
        || event.origin !== EXTENSION_ORIGIN
        || data?.type !== 'PAGEMIND_DELIVER'
        || data.provider !== provider
        || !Number.isInteger(data.windowId)
      ) return;

      requestPayload(data.windowId, 20);
    });
  }

  globalThis.PageMindBridge = Object.freeze({ register });
})();
