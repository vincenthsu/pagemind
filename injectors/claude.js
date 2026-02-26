// Content script injected on claude.ai
// Claude uses ProseMirror (contenteditable div)

(function () {
  const PROVIDER_ID = 'claude';
  const POLL_INTERVAL = 300;
  const MAX_POLLS = 50;
  const PAYLOAD_TTL = 60000;

  let polls = 0;
  let injected = false;

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

    // Select all existing content and replace it
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    // insertText via execCommand works with ProseMirror and fires the correct events
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);

    // Fire additional events for React/framework compatibility
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  }

  async function tryInject() {
    if (injected) return;
    if (polls >= MAX_POLLS) return;
    polls++;

    let payload = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_PAYLOAD' });
      payload = response?.payload;
    } catch (e) {
      return;
    }

    if (!payload) {
      setTimeout(tryInject, POLL_INTERVAL);
      return;
    }

    if (payload.provider !== PROVIDER_ID) return;
    if (Date.now() - payload.createdAt > PAYLOAD_TTL) return;

    const inputEl = getInputEl();
    if (!inputEl) {
      polls--;
      setTimeout(tryInject, POLL_INTERVAL);
      return;
    }

    injected = true;
    setContentEditableValue(inputEl, payload.text);

    await new Promise((r) => setTimeout(r, 700));

    const submitEl = getSubmitEl();
    if (submitEl && !submitEl.disabled) {
      submitEl.click();
    } else {
      // Claude also responds to Enter key in ProseMirror
      inputEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInject);
  } else {
    tryInject();
  }
})();
