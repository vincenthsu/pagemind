// Content script injected on gemini.google.com.
// Gemini uses a Quill-based rich-text editor (contenteditable .ql-editor).

(function () {
  'use strict';

  const POLL_INTERVAL = 400;
  const MAX_POLLS = 60;

  function getInputEl() {
    return (
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('rich-textarea .ql-editor') ||
      document.querySelector('[contenteditable="true"][aria-label]') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function getSubmitEl() {
    return (
      document.querySelector('button.send-button') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[aria-label="送出訊息"]') ||
      document.querySelector('mat-icon[data-mat-icon-name="send"]')?.closest('button')
    );
  }

  function setContentEditableValue(el, text) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
  }

  async function waitForInputEl() {
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      const inputEl = getInputEl();
      if (inputEl) return inputEl;
      if (polls + 1 < MAX_POLLS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }
    }
    throw new Error('Gemini prompt editor is not available');
  }

  async function injectPayload(payload) {
    if (!payload || typeof payload.text !== 'string') {
      throw new TypeError('Gemini payload text must be a string');
    }

    const inputEl = await waitForInputEl();
    setContentEditableValue(inputEl, payload.text);

    if (payload.autoSubmit !== false) {
      await new Promise((resolve) => setTimeout(resolve, 900));
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

  globalThis.PageMindBridge.register('gemini', injectPayload);
})();
