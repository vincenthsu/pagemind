// Content script injected on www.perplexity.ai
// Perplexity uses a standard <textarea> — easiest injection target

(function () {
  const PROVIDER_ID = 'perplexity';
  const POLL_INTERVAL = 300;
  const MAX_POLLS = 50; // ~15 seconds
  const PAYLOAD_TTL = 60000; // 60 seconds

  let polls = 0;
  let injected = false;
  let cachedPayload = null; // cache after first fetch — storage clears on first GET_PAYLOAD

  function getInputEl() {
    // Perplexity main search textarea
    return (
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('textarea')
    );
  }

  function getSubmitEl() {
    return (
      document.querySelector('button[aria-label="Submit"]') ||
      document.querySelector('button[type="submit"]')
    );
  }

  function setTextareaValue(el, text) {
    // Use native setter to bypass React's synthetic event interception
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  async function tryInject() {
    if (injected) return;
    if (polls >= MAX_POLLS) return;
    polls++;

    if (!cachedPayload) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_PAYLOAD' });
        cachedPayload = response?.payload ?? null;
      } catch (e) {
        // Extension context may be invalidated; stop polling
        return;
      }
    }
    const payload = cachedPayload;

    if (!payload) {
      setTimeout(tryInject, POLL_INTERVAL);
      return;
    }

    if (payload.provider !== PROVIDER_ID) return;
    if (Date.now() - payload.createdAt > PAYLOAD_TTL) return;

    const inputEl = getInputEl();
    if (!inputEl) {
      polls--; // retry without counting this as a real poll
      setTimeout(tryInject, POLL_INTERVAL);
      return;
    }

    injected = true;
    inputEl.focus();
    setTextareaValue(inputEl, payload.text);

    // Wait for React to process the input event and enable the submit button
    await new Promise((r) => setTimeout(r, 600));

    const submitEl = getSubmitEl();
    if (submitEl && !submitEl.disabled) {
      submitEl.click();
    } else {
      // Fallback: simulate Enter key
      inputEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInject);
  } else {
    tryInject();
  }
})();
