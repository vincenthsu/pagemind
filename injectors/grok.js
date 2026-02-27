// Content script injected on grok.com (ISOLATED world)
// Fetches the payload from the extension background and relays it
// to the MAIN world script via window.postMessage.

(function () {
  const PROVIDER_ID = 'grok';
  const POLL_INTERVAL = 400;
  const MAX_POLLS = 50;
  const PAYLOAD_TTL = 60000;
  const MSG_TYPE = '__AI_PAGE_SUMMARIZER_INJECT__';

  let polls = 0;
  let delivered = false;
  let cachedPayload = null;

  console.log('[AI-Summarizer][isolated] grok.js loaded');

  async function tryDeliver() {
    if (delivered) return;
    if (polls >= MAX_POLLS) return;
    polls++;

    if (!cachedPayload) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_PAYLOAD' });
        cachedPayload = response?.payload ?? null;
        console.log('[AI-Summarizer][isolated] GET_PAYLOAD:', cachedPayload ? 'HAS PAYLOAD' : 'null');
      } catch (e) {
        console.error('[AI-Summarizer][isolated] sendMessage error:', e);
        return;
      }
    }
    const payload = cachedPayload;

    if (!payload) {
      setTimeout(tryDeliver, POLL_INTERVAL);
      return;
    }

    if (payload.provider !== PROVIDER_ID) {
      console.log('[AI-Summarizer][isolated] wrong provider:', payload.provider);
      return;
    }
    if (Date.now() - payload.createdAt > PAYLOAD_TTL) return;

    delivered = true;
    console.log('[AI-Summarizer][isolated] relaying payload to MAIN world');

    // Retry several times in case MAIN world listener isn't registered yet
    for (let i = 0; i < 8; i++) {
      setTimeout(() => {
        window.postMessage({ type: MSG_TYPE, text: payload.text }, '*');
      }, i * 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryDeliver);
  } else {
    tryDeliver();
  }
})();
