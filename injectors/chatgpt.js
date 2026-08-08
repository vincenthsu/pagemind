// Content script injected on chat.openai.com and chatgpt.com.
// ChatGPT uses a contenteditable div (#prompt-textarea).

(function () {
  'use strict';

  const POLL_INTERVAL = 300;
  const MAX_POLLS = 50;

  function ensureCurrent(delivery) {
    if (delivery && !delivery.isCurrent()) throw new Error('ChatGPT payload expired');
  }

  function getInputEl() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('[data-id="root"] [contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][tabindex="0"]')
    );
  }

  function getSubmitEl() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label="Send message"]')
    );
  }

  function setContentEditableValue(el, text) {
    el.focus();
    document.execCommand('selectAll', false, null);
    if (document.execCommand('insertText', false, text) === false) {
      throw new Error('ChatGPT prompt insertion was rejected');
    }
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  async function waitForInputEl(delivery) {
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      ensureCurrent(delivery);
      const inputEl = getInputEl();
      if (inputEl) return inputEl;
      if (polls + 1 < MAX_POLLS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }
    }
    throw new Error('ChatGPT prompt editor is not available');
  }

  async function injectPayload(payload, delivery) {
    if (!payload || typeof payload.text !== 'string') {
      throw new TypeError('ChatGPT payload text must be a string');
    }

    const inputEl = await waitForInputEl(delivery);
    ensureCurrent(delivery);
    setContentEditableValue(inputEl, payload.text);

    if (payload.autoSubmit !== false) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      ensureCurrent(delivery);
      const submitEl = getSubmitEl();
      if (submitEl && !submitEl.disabled) {
        submitEl.click();
      } else {
        inputEl.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          shiftKey: false,
        }));
      }
    }
  }

  globalThis.PageMindBridge.register('chatgpt', injectPayload);
})();
