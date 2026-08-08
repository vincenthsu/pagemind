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

  function getEditorText() {
    const inputEl = (
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[data-lexical-editor="true"]') ||
      document.querySelector('[contenteditable="true"]')
    );
    if (!inputEl) return '';
    return inputEl.tagName === 'TEXTAREA'
      ? String(inputEl.value ?? '')
      : String(inputEl.textContent ?? '');
  }

  function ensureCurrent(delivery) {
    if (delivery && !delivery.isCurrent()) throw new Error('Grok payload expired');
  }

  function injectPayload(payload, delivery) {
    if (!payload || typeof payload.text !== 'string') {
      return Promise.reject(new TypeError('Grok payload text must be a string'));
    }

    const requestId = crypto.randomUUID();
    const detail = {
      requestId,
      text: payload.text,
      autoSubmit: payload.autoSubmit !== false,
      expiresAt: payload.createdAt + 60_000,
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

        if (event.detail.ok && !getEditorText().includes(payload.text)) return;
        settled = true;
        cleanup();
        if (!event.detail.ok) {
          reject(new Error('Grok MAIN-world injection failed'));
          return;
        }
        try {
          ensureCurrent(delivery);
          resolve();
        } catch (error) {
          reject(error);
        }
      }

      function dispatchRequest() {
        if (settled) return;
        try {
          ensureCurrent(delivery);
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
          return;
        }
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
