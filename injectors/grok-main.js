// Content script injected on grok.com in the MAIN world.
// MAIN-world execution is required for Grok's framework-owned editor events.

(function () {
  'use strict';

  const BOOTSTRAP_REQUEST_EVENT = '__PAGE_MIND_GROK_CHANNEL_REQUEST__';
  const BOOTSTRAP_READY_EVENT = '__PAGE_MIND_GROK_CHANNEL_READY__';
  const BOOTSTRAP_ACCEPTED_EVENT = '__PAGE_MIND_GROK_CHANNEL_ACCEPTED__';
  const BOOTSTRAP_TIMEOUT = 5000;
  const POLL_INTERVAL = 400;
  const MAX_POLLS = 50;
  const MAX_COMPLETED_REQUEST_IDS = 256;
  const inFlightRequestIds = new Set();
  const deliveredRequestIds = new Set();
  const LocalCustomEvent = CustomEvent;
  const LocalEvent = Event;
  const LocalInputEvent = InputEvent;
  const LocalKeyboardEvent = KeyboardEvent;
  const dispatchTargetEvent = EventTarget.prototype.dispatchEvent;
  const addDocumentListener = document.addEventListener.bind(document);
  const removeDocumentListener = document.removeEventListener.bind(document);
  const dispatchDocumentEvent = document.dispatchEvent.bind(document);
  const queryDocument = document.querySelector.bind(document);
  const execDocumentCommand = document.execCommand.bind(document);
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  const now = Date.now.bind(Date);
  const scheduleTimeout = setTimeout.bind(globalThis);
  const cancelTimeout = clearTimeout.bind(globalThis);
  const bootstrapId = crypto.randomUUID();
  const requestEvent = crypto.randomUUID();
  const resultEvent = crypto.randomUUID();

  function hasExactKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object') return false;
    const keys = Object.keys(value).sort();
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index]);
  }

  function getInputEl() {
    return (
      queryDocument('textarea[placeholder]') ||
      queryDocument('textarea') ||
      queryDocument('[contenteditable="true"][role="textbox"]') ||
      queryDocument('[data-lexical-editor="true"]') ||
      queryDocument('[contenteditable="true"]')
    );
  }

  function getSubmitEl() {
    return (
      queryDocument('button[aria-label="Send"]') ||
      queryDocument('button[aria-label="Submit"]') ||
      queryDocument('button[aria-label="送出"]') ||
      queryDocument('button[aria-label="提交"]') ||
      queryDocument('button[aria-label="傳送"]') ||
      queryDocument('button[type="submit"]') ||
      queryDocument('button:has(svg[viewBox] path)')
    );
  }

  function setInputValue(el, text) {
    if (el.tagName === 'TEXTAREA') {
      if (nativeTextAreaValueSetter) nativeTextAreaValueSetter.call(el, text);
      else el.value = text;
      dispatchTargetEvent.call(el, new LocalEvent('input', { bubbles: true, cancelable: true }));
      dispatchTargetEvent.call(el, new LocalEvent('change', { bubbles: true, cancelable: true }));
      return;
    }

    el.focus();
    execDocumentCommand('selectAll', false, null);
    if (execDocumentCommand('insertText', false, text) === false) {
      throw new Error('Grok prompt insertion was rejected');
    }
    dispatchTargetEvent.call(el, new LocalInputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  function reportResult(requestId, ok) {
    dispatchDocumentEvent(new LocalCustomEvent(resultEvent, {
      detail: { requestId, ok },
    }));
  }

  function rememberCompleted(requestId) {
    deliveredRequestIds.add(requestId);
    if (deliveredRequestIds.size > MAX_COMPLETED_REQUEST_IDS) {
      const oldestRequestId = deliveredRequestIds.values().next().value;
      deliveredRequestIds.delete(oldestRequestId);
    }
  }

  function ensureNotExpired(expiresAt) {
    if (!Number.isFinite(expiresAt) || now() > expiresAt) {
      throw new Error('Grok payload expired');
    }
  }

  async function findInputEl(expiresAt) {
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      ensureNotExpired(expiresAt);
      const inputEl = getInputEl();
      if (inputEl) return inputEl;
      await new Promise((resolve) => scheduleTimeout(resolve, POLL_INTERVAL));
    }
    throw new Error('Grok prompt editor is not available');
  }

  async function injectRequest(detail) {
    const { requestId, text, autoSubmit, expiresAt } = detail;
    try {
      const inputEl = await findInputEl(expiresAt);
      ensureNotExpired(expiresAt);
      setInputValue(inputEl, text);

      if (autoSubmit) {
        await new Promise((resolve) => scheduleTimeout(resolve, 800));
        ensureNotExpired(expiresAt);
        const submitEl = getSubmitEl();
        if (submitEl && !submitEl.disabled) {
          submitEl.click();
        } else {
          dispatchTargetEvent.call(inputEl, new LocalKeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          }));
        }
      }

      rememberCompleted(requestId);
      reportResult(requestId, true);
    } catch (error) {
      console.error('PageMind Grok MAIN-world injection failed', error);
      reportResult(requestId, false);
    } finally {
      inFlightRequestIds.delete(requestId);
    }
  }

  function handleRequest(event) {
    const detail = event.detail;
    if (
      event.target !== document
      || !hasExactKeys(detail, ['autoSubmit', 'expiresAt', 'requestId', 'text'])
      || typeof detail.requestId !== 'string'
      || detail.requestId.length === 0
      || typeof detail.text !== 'string'
      || typeof detail.autoSubmit !== 'boolean'
      || !Number.isFinite(detail.expiresAt)
    ) return;

    if (deliveredRequestIds.has(detail.requestId)) {
      reportResult(detail.requestId, true);
      return;
    }
    if (inFlightRequestIds.has(detail.requestId)) return;
    inFlightRequestIds.add(detail.requestId);
    void injectRequest(detail);
  }

  addDocumentListener(requestEvent, handleRequest);

  let bootstrapTimer;

  function cleanupBootstrap() {
    removeDocumentListener(BOOTSTRAP_REQUEST_EVENT, handleBootstrapRequest);
    removeDocumentListener(BOOTSTRAP_ACCEPTED_EVENT, handleBootstrapAccepted);
    cancelTimeout(bootstrapTimer);
  }

  function announceChannel() {
    dispatchDocumentEvent(new LocalCustomEvent(BOOTSTRAP_READY_EVENT, {
      detail: { bootstrapId, requestEvent, resultEvent },
    }));
  }

  function handleBootstrapRequest(event) {
    if (event.target === document) announceChannel();
  }

  function handleBootstrapAccepted(event) {
    if (
      event.target !== document
      || !hasExactKeys(event.detail, ['bootstrapId'])
      || event.detail.bootstrapId !== bootstrapId
    ) return;
    cleanupBootstrap();
  }

  addDocumentListener(BOOTSTRAP_REQUEST_EVENT, handleBootstrapRequest);
  addDocumentListener(BOOTSTRAP_ACCEPTED_EVENT, handleBootstrapAccepted);
  bootstrapTimer = scheduleTimeout(cleanupBootstrap, BOOTSTRAP_TIMEOUT);
  announceChannel();
})();
