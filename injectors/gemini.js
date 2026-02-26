// Content script injected on gemini.google.com
// Gemini uses a Quill-based rich-text editor (contenteditable .ql-editor)

(function () {
  const PROVIDER_ID = 'gemini';
  const POLL_INTERVAL = 400; // Gemini loads slower, give extra time
  const MAX_POLLS = 60;
  const PAYLOAD_TTL = 60000;

  let polls = 0;
  let injected = false;

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
      document.querySelector('button[aria-label="送出訊息"]') || // Traditional Chinese
      document.querySelector('mat-icon[data-mat-icon-name="send"]')?.closest('button')
    );
  }

  function setContentEditableValue(el, text) {
    el.focus();

    // For Quill editors, execCommand('insertText') works and triggers Quill's change events
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);

    // Also dispatch standard events
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));

    // Quill sometimes needs a mutation to detect changes
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
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

    // Gemini needs extra time before the send button becomes active
    await new Promise((r) => setTimeout(r, 900));

    const submitEl = getSubmitEl();
    if (submitEl && !submitEl.disabled) {
      submitEl.click();
    } else {
      // Try Enter key as fallback
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
