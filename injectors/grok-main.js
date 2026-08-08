// Content script injected on grok.com in the MAIN world.
// MAIN-world execution is required for Grok's framework-owned editor events.

(function () {
  'use strict';

  const REQUEST_EVENT = '__PAGE_MIND_GROK_DELIVER__';
  const RESULT_EVENT = '__PAGE_MIND_GROK_RESULT__';
  const POLL_INTERVAL = 400;
  const MAX_POLLS = 50;
  const inFlightRequestIds = new Set();
  const deliveredRequestIds = new Set();

  function hasExactKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object') return false;
    const keys = Object.keys(value).sort();
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index]);
  }

  function getInputEl() {
    return (
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[data-lexical-editor="true"]') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function getSubmitEl() {
    return (
      document.querySelector('button[aria-label="Send"]') ||
      document.querySelector('button[aria-label="Submit"]') ||
      document.querySelector('button[aria-label="送出"]') ||
      document.querySelector('button[aria-label="提交"]') ||
      document.querySelector('button[aria-label="傳送"]') ||
      document.querySelector('button[type="submit"]') ||
      document.querySelector('button:has(svg[viewBox] path)')
    );
  }

  function setInputValue(el, text) {
    if (el.tagName === 'TEXTAREA') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return;
    }

    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  function reportResult(requestId, ok) {
    document.dispatchEvent(new CustomEvent(RESULT_EVENT, {
      detail: { requestId, ok },
    }));
  }

  async function findInputEl() {
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      const inputEl = getInputEl();
      if (inputEl) return inputEl;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
    throw new Error('Grok prompt editor is not available');
  }

  async function injectRequest(detail) {
    const { requestId, text, autoSubmit } = detail;
    try {
      const inputEl = await findInputEl();
      setInputValue(inputEl, text);

      if (autoSubmit) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const submitEl = getSubmitEl();
        if (submitEl && !submitEl.disabled) {
          submitEl.click();
        } else {
          inputEl.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          }));
        }
      }

      deliveredRequestIds.add(requestId);
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
      || !hasExactKeys(detail, ['autoSubmit', 'requestId', 'text'])
      || typeof detail.requestId !== 'string'
      || detail.requestId.length === 0
      || typeof detail.text !== 'string'
      || typeof detail.autoSubmit !== 'boolean'
    ) return;

    if (deliveredRequestIds.has(detail.requestId)) {
      reportResult(detail.requestId, true);
      return;
    }
    if (inFlightRequestIds.has(detail.requestId)) return;
    inFlightRequestIds.add(detail.requestId);
    void injectRequest(detail);
  }

  document.addEventListener(REQUEST_EVENT, handleRequest);
})();
