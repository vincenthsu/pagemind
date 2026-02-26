// Content script injected on chat.openai.com and chatgpt.com
// ChatGPT uses a contenteditable div (#prompt-textarea)

(function () {
  const PROVIDER_ID = 'chatgpt';
  const POLL_INTERVAL = 300;
  const MAX_POLLS = 50;
  const PAYLOAD_TTL = 60000;

  let polls = 0;
  let injected = false;

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

    // ChatGPT's #prompt-textarea is a contenteditable div managed by React
    // execCommand('insertText') triggers React's synthetic onInput handler correctly
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);

    // Dispatch events to ensure React updates its internal state
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
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

    // Give React time to update state and enable the send button
    await new Promise((r) => setTimeout(r, 700));

    const submitEl = getSubmitEl();
    if (submitEl && !submitEl.disabled) {
      submitEl.click();
    } else {
      // ChatGPT also submits on Enter (without Shift)
      inputEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          shiftKey: false,
        })
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInject);
  } else {
    tryInject();
  }
})();
