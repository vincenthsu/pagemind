// Content script injected on claude.ai.
// Claude uses a ProseMirror contenteditable div.

(function () {
  'use strict';

  const POLL_INTERVAL = 300;
  const MAX_POLLS = 50;

  function getInputEl() {
    return (
      document.querySelector('.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][data-placeholder]') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function getSubmitEl() {
    return (
      document.querySelector('button[aria-label="Send Message"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[type="submit"]')
    );
  }

  function setContentEditableValue(el, text) {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  async function waitForInputEl() {
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      const inputEl = getInputEl();
      if (inputEl) return inputEl;
      if (polls + 1 < MAX_POLLS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }
    }
    throw new Error('Claude prompt editor is not available');
  }

  async function injectPayload(payload) {
    if (!payload || typeof payload.text !== 'string') {
      throw new TypeError('Claude payload text must be a string');
    }

    const inputEl = await waitForInputEl();
    setContentEditableValue(inputEl, payload.text);

    if (payload.autoSubmit !== false) {
      await new Promise((resolve) => setTimeout(resolve, 700));
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
  }

  globalThis.PageMindBridge.register('claude', injectPayload);
})();
