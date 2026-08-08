// Content script injected on grok.com in the ISOLATED world.
// Relays bridge payloads to the MAIN-world editor adapter over document events.

(function () {
  'use strict';

  const REQUEST_EVENT = '__PAGE_MIND_GROK_DELIVER__';
  const RESULT_EVENT = '__PAGE_MIND_GROK_RESULT__';
  const RETRY_DELAY = 300;
  const RESULT_TIMEOUT = 30000;

  function hasExactKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object') return false;
    const keys = Object.keys(value).sort();
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index]);
  }

  function injectPayload(payload) {
    if (!payload || typeof payload.text !== 'string') {
      return Promise.reject(new TypeError('Grok payload text must be a string'));
    }

    const requestId = crypto.randomUUID();
    const detail = {
      requestId,
      text: payload.text,
      autoSubmit: payload.autoSubmit !== false,
    };

    return new Promise((resolve, reject) => {
      let retryTimer;
      let timeoutTimer;
      let settled = false;

      function cleanup() {
        document.removeEventListener(RESULT_EVENT, handleResult);
        clearTimeout(retryTimer);
        clearTimeout(timeoutTimer);
      }

      function handleResult(event) {
        if (
          event.target !== document
          || !hasExactKeys(event.detail, ['ok', 'requestId'])
          || event.detail.requestId !== requestId
          || typeof event.detail.ok !== 'boolean'
        ) return;

        settled = true;
        cleanup();
        if (event.detail.ok) resolve();
        else reject(new Error('Grok MAIN-world injection failed'));
      }

      function dispatchRequest() {
        if (settled) return;
        document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail }));
        if (!settled) retryTimer = setTimeout(dispatchRequest, RETRY_DELAY);
      }

      document.addEventListener(RESULT_EVENT, handleResult);
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Grok MAIN-world injection timed out'));
      }, RESULT_TIMEOUT);
      dispatchRequest();
    });
  }

  globalThis.PageMindBridge.register('grok', injectPayload);
})();
