// Content script injected on grok.com in the ISOLATED world.
// Bootstraps private document-event channels before host page scripts run.

(function () {
  'use strict';

  const BOOTSTRAP_REQUEST_EVENT = '__PAGE_MIND_GROK_CHANNEL_REQUEST__';
  const BOOTSTRAP_READY_EVENT = '__PAGE_MIND_GROK_CHANNEL_READY__';
  const BOOTSTRAP_ACCEPTED_EVENT = '__PAGE_MIND_GROK_CHANNEL_ACCEPTED__';
  const BOOTSTRAP_TIMEOUT = 5000;
  const RETRY_DELAY = 300;
  const RESULT_TIMEOUT = 30000;
  const LocalCustomEvent = CustomEvent;
  const addDocumentListener = document.addEventListener.bind(document);
  const removeDocumentListener = document.removeEventListener.bind(document);
  const dispatchDocumentEvent = document.dispatchEvent.bind(document);

  function hasExactKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object') return false;
    const keys = Object.keys(value).sort();
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index]);
  }

  const channelPromise = new Promise((resolve) => {
    let settled = false;
    let timeoutTimer;

    function finish(channel) {
      if (settled) return;
      settled = true;
      removeDocumentListener(BOOTSTRAP_READY_EVENT, handleReady);
      clearTimeout(timeoutTimer);
      resolve(channel);
    }

    function handleReady(event) {
      const detail = event.detail;
      if (
        event.target !== document
        || !hasExactKeys(detail, ['bootstrapId', 'requestEvent', 'resultEvent'])
        || typeof detail.bootstrapId !== 'string'
        || detail.bootstrapId.length === 0
        || typeof detail.requestEvent !== 'string'
        || detail.requestEvent.length === 0
        || typeof detail.resultEvent !== 'string'
        || detail.resultEvent.length === 0
        || detail.requestEvent === detail.resultEvent
      ) return;

      const channel = Object.freeze({
        requestEvent: detail.requestEvent,
        resultEvent: detail.resultEvent,
      });
      dispatchDocumentEvent(new LocalCustomEvent(BOOTSTRAP_ACCEPTED_EVENT, {
        detail: { bootstrapId: detail.bootstrapId },
      }));
      finish(channel);
    }

    addDocumentListener(BOOTSTRAP_READY_EVENT, handleReady);
    timeoutTimer = setTimeout(() => finish(null), BOOTSTRAP_TIMEOUT);
    dispatchDocumentEvent(new LocalCustomEvent(BOOTSTRAP_REQUEST_EVENT));
  });

  function getEditorEl() {
    return (
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[data-lexical-editor="true"]') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function getEditorText(inputEl = getEditorEl()) {
    if (!inputEl) return '';
    return inputEl.tagName === 'TEXTAREA'
      ? String(inputEl.value ?? '')
      : String(inputEl.textContent ?? '');
  }

  function ensureCurrent(delivery) {
    if (delivery && !delivery.isCurrent()) throw new Error('Grok payload expired');
  }

  async function injectPayload(payload, delivery) {
    if (!payload || typeof payload.text !== 'string' || payload.text.length === 0) {
      throw new TypeError('Grok payload text must be a nonempty string');
    }

    const channel = await channelPromise;
    if (!channel) throw new Error('Grok MAIN-world channel is not available');
    ensureCurrent(delivery);

    const initialEditorText = getEditorText();
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
      let observedExactMutation = false;

      function handleEditorMutation(event) {
        const editorEl = getEditorEl();
        if (!editorEl || event.target !== editorEl) return;
        const currentEditorText = getEditorText(editorEl);
        if (
          currentEditorText === payload.text
          && currentEditorText !== initialEditorText
        ) observedExactMutation = true;
      }

      function cleanup() {
        removeDocumentListener(channel.resultEvent, handleResult);
        removeDocumentListener('input', handleEditorMutation, true);
        removeDocumentListener('change', handleEditorMutation, true);
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

        if (event.detail.ok && !observedExactMutation) return;
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
        dispatchDocumentEvent(new LocalCustomEvent(channel.requestEvent, { detail }));
        if (!settled) retryTimer = setTimeout(dispatchRequest, RETRY_DELAY);
      }

      addDocumentListener(channel.resultEvent, handleResult);
      addDocumentListener('input', handleEditorMutation, true);
      addDocumentListener('change', handleEditorMutation, true);
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
