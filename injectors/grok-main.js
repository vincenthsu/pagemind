// Content script injected on grok.com (MAIN world)
// Runs in the page's JS context so that execCommand / DOM events are
// received by whatever editor framework Grok uses.

(function () {
  const MSG_TYPE = '__AI_PAGE_SUMMARIZER_INJECT__';
  const POLL_INTERVAL = 400;
  const MAX_POLLS = 50;

  let injected = false;

  console.log('[AI-Summarizer][MAIN] grok-main.js loaded');

  function getInputEl() {
    // Try multiple selectors — Grok may use textarea or contenteditable
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
      // Icon-based fallback — look for SVG arrow buttons near the input
      document.querySelector('button:has(svg[viewBox] path)')
    );
  }

  function isTextarea(el) {
    return el && el.tagName === 'TEXTAREA';
  }

  function setInputValue(el, text) {
    if (isTextarea(el)) {
      console.log('[AI-Summarizer][MAIN] injecting via textarea setter');
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
    } else {
      console.log('[AI-Summarizer][MAIN] injecting via execCommand (contenteditable)');
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
  }

  async function handleMessage(event) {
    if (event.source !== window) return;
    if (event.data?.type !== MSG_TYPE) return;
    if (injected) return;

    const text = event.data.text;
    if (!text) return;

    injected = true;
    console.log('[AI-Summarizer][MAIN] received payload, text length:', text.length);

    // Poll until the input element appears
    let polls = 0;
    while (polls < MAX_POLLS) {
      const inputEl = getInputEl();
      if (inputEl) {
        console.log('[AI-Summarizer][MAIN] found input:', inputEl.tagName, inputEl.id || inputEl.className);
        setInputValue(inputEl, text);

        // Wait for the UI framework to process and enable the submit button
        await new Promise((r) => setTimeout(r, 800));

        const submitEl = getSubmitEl();
        console.log('[AI-Summarizer][MAIN] submit:', submitEl ? 'found' : 'NOT FOUND');
        if (submitEl && !submitEl.disabled) {
          submitEl.click();
          console.log('[AI-Summarizer][MAIN] submit clicked');
        } else {
          console.log('[AI-Summarizer][MAIN] fallback: pressing Enter');
          inputEl.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter',
              bubbles: true, cancelable: true,
            })
          );
        }
        return;
      }
      polls++;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
    console.error('[AI-Summarizer][MAIN] input element never appeared');
  }

  window.addEventListener('message', handleMessage);
  console.log('[AI-Summarizer][MAIN] message listener registered');
})();
