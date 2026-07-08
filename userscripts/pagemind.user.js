// ==UserScript==
// @name         PageMind
// @namespace    https://github.com/pagemind
// @version      1.3.0
// @description  Send web page content or YouTube transcripts to ChatGPT, Gemini, Claude, or Grok for summarization. Userscript port of the PageMind Chrome extension.
// @author       PageMind
// @license      MIT
// @match        *://*/*
// @require      https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-idle
// @connect      youtube.com
// @noframes
// ==/UserScript==

/*
 * PageMind userscript
 * -------------------
 * Single-file port of the PageMind MV3 Chrome extension.
 *
 * How it maps to the extension:
 *   - chrome.storage.session  ->  GM_setValue / GM_getValue (shared across all
 *                                 tabs/origins, so a source page can hand a
 *                                 payload to an AI provider tab).
 *   - popup / context menus    ->  GM_registerMenuCommand entries.
 *   - background service worker + content scripts  ->  one script that branches
 *                                 on hostname: source pages EXTRACT + DISPATCH,
 *                                 provider pages POLL + INJECT.
 *   - lib/readability.js       ->  @require'd from CDN.
 *
 * Intentionally NOT ported (rely on extension-only Chrome APIs):
 *   - Companion window resize/snap (chrome.windows.update) -> always opens a tab.
 *   - Research-collection side panel (chrome.sidePanel).
 *   - Offscreen-document clipboard -> uses GM_setClipboard directly (optional).
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config (mirrors lib/providers.js)
  // ---------------------------------------------------------------------------
  const PROVIDERS = {
    chatgpt: {
      id: 'chatgpt',
      label: 'ChatGPT',
      url: 'https://chatgpt.com/',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      inputType: 'contenteditable',
      getInput: () =>
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-id="root"] [contenteditable="true"]') ||
        document.querySelector('div[contenteditable="true"][tabindex="0"]'),
      getSubmit: () =>
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[aria-label="Send prompt"]') ||
        document.querySelector('button[aria-label="Send message"]'),
    },
    gemini: {
      id: 'gemini',
      label: 'Gemini',
      url: 'https://gemini.google.com/app',
      hosts: ['gemini.google.com'],
      inputType: 'contenteditable',
      getInput: () =>
        document.querySelector('.ql-editor[contenteditable="true"]') ||
        document.querySelector('rich-textarea .ql-editor') ||
        document.querySelector('[contenteditable="true"][aria-label]') ||
        document.querySelector('[contenteditable="true"]'),
      getSubmit: () =>
        document.querySelector('button.send-button') ||
        document.querySelector('button[aria-label="Send message"]') ||
        document.querySelector('button[aria-label="送出訊息"]') ||
        (document.querySelector('mat-icon[data-mat-icon-name="send"]') || {}).closest?.('button'),
    },
    claude: {
      id: 'claude',
      label: 'Claude',
      url: 'https://claude.ai/new',
      hosts: ['claude.ai'],
      inputType: 'contenteditable',
      getInput: () =>
        document.querySelector('.ProseMirror[contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"][data-placeholder]') ||
        document.querySelector('[contenteditable="true"]'),
      getSubmit: () =>
        document.querySelector('button[aria-label="Send Message"]') ||
        document.querySelector('button[aria-label="Send message"]') ||
        document.querySelector('button[type="submit"]'),
    },
    grok: {
      id: 'grok',
      label: 'Grok',
      url: 'https://grok.com/',
      hosts: ['grok.com'],
      inputType: 'auto',
      getInput: () =>
        document.querySelector('textarea[placeholder]') ||
        document.querySelector('textarea') ||
        document.querySelector('[contenteditable="true"][role="textbox"]') ||
        document.querySelector('[data-lexical-editor="true"]') ||
        document.querySelector('[contenteditable="true"]'),
      getSubmit: () =>
        document.querySelector('button[aria-label="Send"]') ||
        document.querySelector('button[aria-label="Submit"]') ||
        document.querySelector('button[aria-label="送出"]') ||
        document.querySelector('button[aria-label="提交"]') ||
        document.querySelector('button[aria-label="傳送"]') ||
        document.querySelector('button[type="submit"]') ||
        document.querySelector('button:has(svg[viewBox] path)'),
    },
  };

  const DEFAULT_PROMPTS = [
    'Summarize the following content:',
    'What are the key takeaways from this content?',
    'Explain this to me like I\'m 5 years old:',
    'Extract all action items and decisions from this content:',
    'Write a critical analysis of:',
    '用條列式總結，依主題分段、僅頂層標題加Emoji、若為影片於句末標註時間戳記',
  ];

  const DEFAULT_MAX_CONTENT_CHARS = 12000;
  const PAYLOAD_KEY = 'pendingPayload';
  const PAYLOAD_TTL = 60000;
  const PROMPTS_KEY = 'prompts';
  const LOG = '[PageMind]';

  // ---------------------------------------------------------------------------
  // Settings (GM storage, replaces chrome.storage.sync)
  // ---------------------------------------------------------------------------
  function getSettings() {
    return {
      defaultProvider: GM_getValue('defaultProvider', 'chatgpt'),
      defaultPromptIndex: GM_getValue('defaultPromptIndex', 0),
      autoSubmit: GM_getValue('autoSubmit', true),
      includeUrl: GM_getValue('includeUrl', true),
      maxContentChars: GM_getValue('maxContentChars', DEFAULT_MAX_CONTENT_CHARS),
      copyToClipboard: GM_getValue('copyToClipboard', false),
      showBall: GM_getValue('showBall', true),
      ballClickSends: GM_getValue('ballClickSends', false),
      shortcut: GM_getValue('shortcut', 'Alt+KeyS'),
    };
  }

  // Prompts are user-editable and persisted; seeded from DEFAULT_PROMPTS.
  function getPrompts() {
    const stored = GM_getValue(PROMPTS_KEY, null);
    if (Array.isArray(stored) && stored.length) return stored.slice();
    return DEFAULT_PROMPTS.slice();
  }

  function savePrompts(arr) {
    const clean = (arr || []).map((p) => String(p)).filter((p) => p.trim() !== '');
    GM_setValue(PROMPTS_KEY, clean.length ? clean : DEFAULT_PROMPTS.slice());
  }

  function getPrompt(index) {
    const prompts = getPrompts();
    return prompts[index] ?? prompts[0];
  }

  // ---------------------------------------------------------------------------
  // Provider detection: which page are we on?
  // ---------------------------------------------------------------------------
  function detectProvider() {
    const host = location.hostname;
    for (const p of Object.values(PROVIDERS)) {
      if (p.hosts.some((h) => host === h || host.endsWith('.' + h))) return p;
    }
    return null;
  }

  // ===========================================================================
  // SOURCE-PAGE SIDE: extract content + dispatch to a provider
  // ===========================================================================

  function extractSelection() {
    try {
      return (unsafeWindow.getSelection?.() || window.getSelection()).toString().trim();
    } catch {
      return '';
    }
  }

  function extractArticle() {
    try {
      if (typeof Readability === 'undefined') {
        return fallbackText();
      }
      const docClone = document.cloneNode(true);
      const article = new Readability(docClone).parse();
      if (article?.textContent) {
        const title = article.title ? `Title: ${article.title}\n\n` : '';
        const content = article.textContent
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        return title + content;
      }
      return fallbackText();
    } catch {
      return fallbackText();
    }
  }

  function fallbackText() {
    try {
      return document.body.innerText
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    } catch {
      return '';
    }
  }

  // --- YouTube transcript (mirrors content/youtube.js) ----------------------
  function xhr(method, url, body) {
    return new Promise((resolve, reject) => {
      // Prefer GM_xmlhttpRequest (cross-origin safe, sends cookies); fall back to XHR.
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method,
          url,
          data: body,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          onload: (r) =>
            r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(`HTTP ${r.status}`),
          onerror: () => reject('Network error'),
        });
        return;
      }
      const x = new XMLHttpRequest();
      x.open(method, url, true);
      if (body) x.setRequestHeader('Content-Type', 'application/json');
      x.onload = () =>
        x.status >= 200 && x.status < 300 ? resolve(x.responseText) : reject(`HTTP ${x.status}`);
      x.onerror = () => reject('Network error');
      x.send(body);
    });
  }

  async function extractYouTube() {
    const RE_XML = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    const videoTitle = document.title.replace(/ - YouTube$/, '').trim();
    const header = `YouTube Video: ${videoTitle}\n\n`;
    try {
      const videoId = new URL(location.href).searchParams.get('v');
      if (!videoId) return header + '[No video ID found]';

      const win = unsafeWindow;
      let apiKey = win.ytcfg?.data_?.INNERTUBE_API_KEY || null;
      if (!apiKey) {
        try {
          const html = await xhr('GET', `https://www.youtube.com/watch?v=${videoId}`);
          apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || null;
        } catch { /* falls through */ }
      }
      if (!apiKey) return header + '[Could not find INNERTUBE_API_KEY]';

      let captionTracks = null;
      try {
        const playerJson = await xhr(
          'POST',
          `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
          JSON.stringify({
            context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
            videoId,
          })
        );
        captionTracks = JSON.parse(playerJson)?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      } catch {
        captionTracks = win.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      }
      if (!captionTracks?.length) return header.trim();

      const track =
        captionTracks.find((t) => t.kind !== 'asr') ||
        captionTracks.find((t) => t.kind === 'asr') ||
        captionTracks[0];
      if (!track?.baseUrl) return header + '[Caption track URL not found]';

      const lang = track.name?.simpleText || track.languageCode || 'unknown';
      const transcriptUrl = track.baseUrl.replace(/&fmt=\w+/, '');

      let xml;
      try {
        xml = await xhr('GET', transcriptUrl);
      } catch (e) {
        return header + `[Transcript fetch failed: ${e}]`;
      }
      const trimmed = (xml || '').trim();
      if (!trimmed) return header + '[Transcript response was empty]';
      if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
        return header + '[YouTube returned an error page instead of transcript XML]';
      }

      const segments = [];
      let m;
      while ((m = RE_XML.exec(xml)) !== null) {
        const text = m[3]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n/g, ' ')
          .trim();
        if (text) segments.push(text);
      }
      if (!segments.length) return header + '[Could not parse transcript]';
      return header + `Transcript (${lang}):\n` + segments.join(' ');
    } catch (err) {
      return header + `[${err.message}]`;
    }
  }

  // --- Build payload + open the provider ------------------------------------
  async function extractActiveContent() {
    const selected = extractSelection();
    if (selected) {
      return {
        url: location.href,
        type: 'selection',
        content: `[Selected text from: ${document.title || location.href}]\n\n${selected}`,
      };
    }
    if (location.hostname.endsWith('youtube.com') && location.pathname === '/watch') {
      return { url: location.href, type: 'youtube', content: await extractYouTube() };
    }
    return { url: location.href, type: 'page', content: extractArticle() };
  }

  async function summarize(providerId, promptIndex) {
    const provider = PROVIDERS[providerId];
    if (!provider) return;
    const s = getSettings();

    let source;
    try {
      source = await extractActiveContent();
    } catch (e) {
      alert(`${LOG} Extraction failed: ${e.message}`);
      return;
    }

    const maxChars = s.maxContentChars || DEFAULT_MAX_CONTENT_CHARS;
    const truncated =
      source.content.length > maxChars
        ? source.content.slice(0, maxChars) + '\n\n[Content truncated — article is too long]'
        : source.content;

    let message = getPrompt(promptIndex);
    if (s.includeUrl && source.url) message += `\n\nSource URL: ${source.url}`;
    message += `\n\n---\n\n${truncated}`;

    GM_setValue(PAYLOAD_KEY, {
      text: message,
      provider: providerId,
      autoSubmit: s.autoSubmit,
      createdAt: Date.now(),
    });

    if (s.copyToClipboard) {
      try { GM_setClipboard(message); } catch { /* optional */ }
    }

    if (typeof GM_openInTab === 'function') {
      GM_openInTab(provider.url, { active: true, setParent: true });
    } else {
      window.open(provider.url, '_blank');
    }
  }

  // ===========================================================================
  // PROVIDER-PAGE SIDE: poll for payload + inject + submit
  // ===========================================================================

  function setInputValue(provider, el, text) {
    el.focus();
    if (provider.inputType === 'auto' && el.tagName === 'TEXTAREA') {
      // Native setter bypasses React's synthetic-event interception.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return;
    }
    // contenteditable editors (ChatGPT/Gemini/Claude/Grok-CE): execCommand fires
    // the framework's onInput correctly.
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* non-fatal */ }
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
    );
    if (provider.id === 'gemini') el.dispatchEvent(new Event('keyup', { bubbles: true }));
  }

  function pressEnter(el) {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    );
  }

  async function runInjector(provider) {
    const POLL_INTERVAL = 350;
    const MAX_POLLS = 60;
    let polls = 0;

    const payload = GM_getValue(PAYLOAD_KEY, null);
    if (!payload) return;
    if (payload.provider !== provider.id) return;
    if (Date.now() - payload.createdAt > PAYLOAD_TTL) {
      GM_deleteValue(PAYLOAD_KEY);
      return;
    }
    // Consume immediately so other provider tabs / reloads don't re-inject.
    GM_deleteValue(PAYLOAD_KEY);

    while (polls < MAX_POLLS) {
      const inputEl = provider.getInput();
      if (inputEl) {
        setInputValue(provider, inputEl, payload.text);
        if (payload.autoSubmit !== false) {
          // Let the framework enable the send button.
          await new Promise((r) => setTimeout(r, provider.id === 'gemini' ? 900 : 700));
          const submitEl = provider.getSubmit();
          if (submitEl && !submitEl.disabled) submitEl.click();
          else pressEnter(inputEl);
        }
        return;
      }
      polls++;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
    console.error(LOG, 'input element never appeared on', provider.id);
  }

  // ===========================================================================
  // Menu commands (replace popup + context menus)
  // ===========================================================================
  function promptChoiceList() {
    return getPrompts().map((p, i) => `${i}: ${p}`).join('\n');
  }

  function registerSourceMenus() {
    const s = getSettings();
    for (const p of Object.values(PROVIDERS)) {
      const star = p.id === s.defaultProvider ? ' ★' : '';
      GM_registerMenuCommand(`Summarize → ${p.label}${star}`, () =>
        summarize(p.id, getSettings().defaultPromptIndex)
      );
    }

    GM_registerMenuCommand('Summarize (default provider)', () => {
      const cur = getSettings();
      summarize(cur.defaultProvider, cur.defaultPromptIndex);
    });

    GM_registerMenuCommand('⚙ Choose default prompt…', () => {
      const cur = getSettings();
      const prompts = getPrompts();
      const input = prompt(
        `Pick a prompt index (0-${prompts.length - 1}):\n\n${promptChoiceList()}`,
        String(cur.defaultPromptIndex)
      );
      if (input === null) return;
      const idx = parseInt(input.trim(), 10);
      if (!Number.isNaN(idx) && idx >= 0 && idx < prompts.length) {
        GM_setValue('defaultPromptIndex', idx);
        alert(`${LOG} Default prompt set to:\n\n${prompts[idx]}`);
      }
    });

    GM_registerMenuCommand('⚙ Choose default provider…', () => {
      const ids = Object.keys(PROVIDERS);
      const cur = getSettings();
      const input = prompt(
        `Pick a default provider:\n\n${ids.map((id, i) => `${i}: ${PROVIDERS[id].label}`).join('\n')}`,
        String(ids.indexOf(cur.defaultProvider))
      );
      if (input === null) return;
      const idx = parseInt(input.trim(), 10);
      if (!Number.isNaN(idx) && ids[idx]) {
        GM_setValue('defaultProvider', ids[idx]);
        alert(`${LOG} Default provider set to: ${PROVIDERS[ids[idx]].label}`);
      }
    });

    GM_registerMenuCommand('⚙ Settings…', () => {
      const cur = getSettings();
      const auto = confirm(`${LOG} Auto-submit after pasting?\n\nOK = Yes (current: ${cur.autoSubmit})\nCancel = No`);
      GM_setValue('autoSubmit', auto);
      const incl = confirm(`${LOG} Include source URL in the message?\n\nOK = Yes (current: ${cur.includeUrl})\nCancel = No`);
      GM_setValue('includeUrl', incl);
      const clip = confirm(`${LOG} Also copy the message to clipboard?\n\nOK = Yes (current: ${cur.copyToClipboard})\nCancel = No`);
      GM_setValue('copyToClipboard', clip);
      const maxIn = prompt(`${LOG} Max content characters:`, String(cur.maxContentChars));
      if (maxIn !== null) {
        const n = parseInt(maxIn.trim(), 10);
        if (!Number.isNaN(n) && n > 0) GM_setValue('maxContentChars', n);
      }
      alert(`${LOG} Settings saved.`);
    });
  }

  // ===========================================================================
  // Floating ball (懸浮球): draggable quick-access button
  // ===========================================================================
  const BALL_SIZE = 52;
  const BALL_POS_KEY = 'ballPos';
  let ballHost = null;
  let ballTapHandler = null; // set by createFloatingBall; mirrors a plain tap
  let capturingShortcut = false;

  // --- Keyboard shortcut helpers -------------------------------------------
  // Combos are stored layout-independently as e.code, e.g. "Alt+KeyS".
  function eventCombo(e) {
    if (['Control', 'Alt', 'Shift', 'Meta', 'Dead'].includes(e.key)) return null;
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    if (!e.code) return null;
    parts.push(e.code);
    return parts.join('+');
  }

  function prettyCombo(combo) {
    if (!combo) return '（停用）';
    return combo
      .split('+')
      .map((part) => {
        if (part.startsWith('Key')) return part.slice(3);
        if (part.startsWith('Digit')) return part.slice(5);
        if (part.startsWith('Numpad')) return 'Num' + part.slice(6);
        if (part.startsWith('Arrow')) return part.slice(5);
        return part;
      })
      .join(' + ');
  }

  // Run the same action as a plain tap on the ball, even if it is hidden.
  function activateBall() {
    if (ballTapHandler) { ballTapHandler(); return; }
    const s = getSettings();
    if (s.ballClickSends) {
      summarize(s.defaultProvider, s.defaultPromptIndex);
    } else {
      // Menu mode but the ball is hidden: materialize it, then open the menu.
      createFloatingBall(true);
      if (ballTapHandler) ballTapHandler();
    }
  }

  function onShortcutKeyDown(e) {
    if (capturingShortcut) return;
    const s = getSettings();
    if (!s.shortcut) return;
    const combo = eventCombo(e);
    if (!combo || combo !== s.shortcut) return;
    // Don't hijack typing when the combo has no non-shift modifier.
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      const t = e.target;
      const tag = (t && t.tagName) || '';
      if (t && (t.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;
    }
    // Ignore keystrokes aimed at our own menu (e.g. editing a prompt).
    if (ballHost && e.composedPath && e.composedPath().includes(ballHost)) return;
    e.preventDefault();
    activateBall();
  }

  function clampBallPos(left, top) {
    const maxLeft = Math.max(0, window.innerWidth - BALL_SIZE);
    const maxTop = Math.max(0, window.innerHeight - BALL_SIZE);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  function removeFloatingBall() {
    if (ballHost) {
      ballHost.remove();
      ballHost = null;
      ballTapHandler = null;
    }
  }

  function createFloatingBall(force) {
    if (ballHost) return;
    if (!force && !getSettings().showBall) return;
    if (!document.body) return;

    // Host + Shadow DOM keep our styles isolated from the host page.
    const host = document.createElement('div');
    host.id = 'pagemind-fab-host';
    host.style.cssText =
      'all: initial; position: fixed; z-index: 2147483647; width: ' +
      BALL_SIZE + 'px; height: ' + BALL_SIZE + 'px;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      * { box-sizing: border-box; }
      .pm-ball {
        width: ${BALL_SIZE}px; height: ${BALL_SIZE}px; border-radius: 50%;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        box-shadow: 0 4px 14px rgba(0,0,0,.35);
        display: flex; align-items: center; justify-content: center;
        font-size: 26px; cursor: grab; user-select: none;
        transition: transform .12s ease, box-shadow .12s ease;
        touch-action: none; color: #fff;
      }
      .pm-ball:hover { transform: scale(1.06); box-shadow: 0 6px 20px rgba(0,0,0,.45); }
      .pm-ball.dragging { cursor: grabbing; transform: scale(1.02); }
      .pm-menu {
        position: absolute; min-width: 240px; max-width: 300px; background: #1f2430; color: #e6e6e6;
        border: 1px solid rgba(255,255,255,.08); border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.5); padding: 10px; font-size: 13px;
        max-height: 80vh; overflow-y: auto;
      }
      .pm-menu.hidden { display: none; }
      .pm-prompts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .pm-prompt-item { display: flex; gap: 6px; align-items: stretch; }
      .pm-prompt-text {
        flex: 1; resize: vertical; padding: 6px 8px; border-radius: 8px; font-size: 12px;
        background: #2a3040; color: #e6e6e6; border: 1px solid rgba(255,255,255,.12);
        font-family: inherit; line-height: 1.35;
      }
      .pm-icon-btn {
        flex: 0 0 auto; width: 30px; display: flex; align-items: center; justify-content: center;
        border-radius: 8px; cursor: pointer; background: #2a3040;
        border: 1px solid rgba(255,255,255,.12); font-size: 13px;
      }
      .pm-icon-btn:hover { background: #4a2a2a; }
      .pm-title { font-weight: 600; font-size: 12px; opacity: .7; margin: 2px 4px 8px; letter-spacing: .3px; }
      .pm-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
      .pm-btn {
        flex: 1 1 auto; min-width: 88px; padding: 7px 8px; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(255,255,255,.12); background: #2a3040; color: #e6e6e6;
        font-size: 12px; text-align: center; transition: background .1s ease;
      }
      .pm-btn:hover { background: #343c50; }
      .pm-btn.primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); border: none; color: #fff; font-weight: 600; }
      .pm-btn.star::after { content: " ★"; color: #ffd166; }
      .pm-btn.full { flex-basis: 100%; }
      select, input[type="number"] {
        width: 100%; padding: 6px 8px; border-radius: 8px; margin-bottom: 8px;
        background: #2a3040; color: #e6e6e6; border: 1px solid rgba(255,255,255,.12); font-size: 12px;
      }
      label.pm-check { display: flex; align-items: center; gap: 8px; padding: 5px 4px; cursor: pointer; }
      label.pm-check input { margin: 0; }
      .pm-foot { display: flex; gap: 6px; margin-top: 4px; }
      .pm-link { flex: 1; text-align: center; padding: 6px; border-radius: 8px; cursor: pointer; color: #a5b4fc; font-size: 12px; }
      .pm-link:hover { background: #2a3040; }
    `;
    shadow.appendChild(style);

    const ball = document.createElement('div');
    ball.className = 'pm-ball';
    ball.title = 'PageMind';
    ball.textContent = '🧠';
    shadow.appendChild(ball);

    const menu = document.createElement('div');
    menu.className = 'pm-menu hidden';
    shadow.appendChild(menu);

    document.documentElement.appendChild(host);
    ballHost = host;

    // --- Position -----------------------------------------------------------
    const saved = GM_getValue(BALL_POS_KEY, null);
    const initial = saved
      ? clampBallPos(saved.left, saved.top)
      : clampBallPos(window.innerWidth - BALL_SIZE - 24, window.innerHeight - BALL_SIZE - 24);
    host.style.left = initial.left + 'px';
    host.style.top = initial.top + 'px';

    window.addEventListener('resize', () => {
      const c = clampBallPos(parseFloat(host.style.left) || 0, parseFloat(host.style.top) || 0);
      host.style.left = c.left + 'px';
      host.style.top = c.top + 'px';
    });

    // --- Menu rendering -----------------------------------------------------
    let menuView = 'main';

    function positionMenu() {
      // Prefer above the ball; flip below if there isn't room.
      const hostTop = parseFloat(host.style.top) || 0;
      menu.style.left = 'auto';
      menu.style.right = 'auto';
      // Horizontal: open toward the side with more room.
      if ((parseFloat(host.style.left) || 0) + BALL_SIZE / 2 > window.innerWidth / 2) {
        menu.style.right = '0px';
      } else {
        menu.style.left = '0px';
      }
      // Vertical: place above unless the ball is near the top.
      if (hostTop < 320) {
        menu.style.top = (BALL_SIZE + 8) + 'px';
        menu.style.bottom = 'auto';
      } else {
        menu.style.bottom = (BALL_SIZE + 8) + 'px';
        menu.style.top = 'auto';
      }
    }

    function renderMain() {
      const s = getSettings();
      menu.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'pm-title';
      title.textContent = 'PageMind — 摘要此頁';
      menu.appendChild(title);

      const prompts = getPrompts();
      const selIdx = Math.min(s.defaultPromptIndex, prompts.length - 1);
      const promptSel = document.createElement('select');
      prompts.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = (p.length > 40 ? p.slice(0, 40) + '…' : p);
        if (i === selIdx) opt.selected = true;
        promptSel.appendChild(opt);
      });
      promptSel.addEventListener('change', () => {
        GM_setValue('defaultPromptIndex', parseInt(promptSel.value, 10) || 0);
      });
      menu.appendChild(promptSel);

      const row = document.createElement('div');
      row.className = 'pm-row';
      for (const p of Object.values(PROVIDERS)) {
        const btn = document.createElement('div');
        btn.className = 'pm-btn' + (p.id === s.defaultProvider ? ' primary star' : '');
        btn.textContent = p.label;
        btn.addEventListener('click', () => {
          const idx = parseInt(promptSel.value, 10) || 0;
          hideMenu();
          summarize(p.id, idx);
        });
        row.appendChild(btn);
      }
      menu.appendChild(row);

      const foot = document.createElement('div');
      foot.className = 'pm-foot';
      const promptsLink = document.createElement('div');
      promptsLink.className = 'pm-link';
      promptsLink.textContent = '✏ 提示詞';
      promptsLink.addEventListener('click', () => { menuView = 'prompts'; renderPrompts(); });
      const settingsLink = document.createElement('div');
      settingsLink.className = 'pm-link';
      settingsLink.textContent = '⚙ 設定';
      settingsLink.addEventListener('click', () => { menuView = 'settings'; renderSettings(); });
      const hideLink = document.createElement('div');
      hideLink.className = 'pm-link';
      hideLink.textContent = '🙈 隱藏';
      hideLink.addEventListener('click', () => {
        GM_setValue('showBall', false);
        removeFloatingBall();
      });
      foot.appendChild(promptsLink);
      foot.appendChild(settingsLink);
      foot.appendChild(hideLink);
      menu.appendChild(foot);
      positionMenu();
    }

    function renderSettings() {
      const s = getSettings();
      menu.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'pm-title';
      title.textContent = 'PageMind — 設定';
      menu.appendChild(title);

      const mkCheck = (label, key, val) => {
        const wrap = document.createElement('label');
        wrap.className = 'pm-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!val;
        cb.addEventListener('change', () => GM_setValue(key, cb.checked));
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(label));
        return wrap;
      };

      menu.appendChild(mkCheck('點擊懸浮球直接送出', 'ballClickSends', s.ballClickSends));
      menu.appendChild(mkCheck('自動送出', 'autoSubmit', s.autoSubmit));
      menu.appendChild(mkCheck('附上來源網址', 'includeUrl', s.includeUrl));
      menu.appendChild(mkCheck('同時複製到剪貼簿', 'copyToClipboard', s.copyToClipboard));

      const maxLabel = document.createElement('div');
      maxLabel.className = 'pm-title';
      maxLabel.style.margin = '8px 4px 4px';
      maxLabel.textContent = '最大字數';
      menu.appendChild(maxLabel);
      const maxIn = document.createElement('input');
      maxIn.type = 'number';
      maxIn.min = '500';
      maxIn.value = String(s.maxContentChars);
      maxIn.addEventListener('change', () => {
        const n = parseInt(maxIn.value, 10);
        if (!Number.isNaN(n) && n > 0) GM_setValue('maxContentChars', n);
      });
      menu.appendChild(maxIn);

      const scLabel = document.createElement('div');
      scLabel.className = 'pm-title';
      scLabel.style.margin = '8px 4px 4px';
      scLabel.textContent = '快捷鍵（等同點擊懸浮球）';
      menu.appendChild(scLabel);

      const scRow = document.createElement('div');
      scRow.className = 'pm-row';
      scRow.style.marginBottom = '4px';
      const scBtn = document.createElement('div');
      scBtn.className = 'pm-btn';
      scBtn.style.flex = '1 1 auto';
      scBtn.textContent = prettyCombo(s.shortcut);
      scBtn.title = '點擊後按下想要的組合鍵';
      scBtn.addEventListener('click', () => {
        if (capturingShortcut) return;
        capturingShortcut = true;
        scBtn.textContent = '請按下組合鍵…（Esc 取消）';
        const capture = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.key === 'Escape') {
            cleanup();
            scBtn.textContent = prettyCombo(getSettings().shortcut);
            return;
          }
          const combo = eventCombo(ev);
          if (!combo) return; // pure modifier held: keep waiting
          GM_setValue('shortcut', combo);
          scBtn.textContent = prettyCombo(combo);
          cleanup();
        };
        const cleanup = () => {
          window.removeEventListener('keydown', capture, true);
          capturingShortcut = false;
        };
        window.addEventListener('keydown', capture, true);
      });
      const scClear = document.createElement('div');
      scClear.className = 'pm-btn';
      scClear.style.flex = '0 0 auto';
      scClear.textContent = '停用';
      scClear.title = '停用快捷鍵';
      scClear.addEventListener('click', () => {
        GM_setValue('shortcut', '');
        scBtn.textContent = prettyCombo('');
      });
      scRow.appendChild(scBtn);
      scRow.appendChild(scClear);
      menu.appendChild(scRow);

      const foot = document.createElement('div');
      foot.className = 'pm-foot';
      const back = document.createElement('div');
      back.className = 'pm-link';
      back.textContent = '← 返回';
      back.addEventListener('click', () => { menuView = 'main'; renderMain(); });
      const hideLink = document.createElement('div');
      hideLink.className = 'pm-link';
      hideLink.textContent = '🙈 隱藏懸浮球';
      hideLink.addEventListener('click', () => {
        GM_setValue('showBall', false);
        removeFloatingBall();
      });
      foot.appendChild(back);
      foot.appendChild(hideLink);
      menu.appendChild(foot);
      positionMenu();
    }

    function renderPrompts() {
      menu.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'pm-title';
      title.textContent = 'PageMind — 管理提示詞';
      menu.appendChild(title);

      const list = document.createElement('div');
      list.className = 'pm-prompts';
      menu.appendChild(list);

      const drawList = () => {
        const prompts = getPrompts();
        list.innerHTML = '';
        prompts.forEach((text, i) => {
          const item = document.createElement('div');
          item.className = 'pm-prompt-item';

          const ta = document.createElement('textarea');
          ta.className = 'pm-prompt-text';
          ta.rows = 2;
          ta.value = text;
          // Save edits on blur (or Enter without Shift).
          const commit = () => {
            const arr = getPrompts();
            arr[i] = ta.value;
            savePrompts(arr);
          };
          ta.addEventListener('blur', commit);
          ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
          });

          const del = document.createElement('div');
          del.className = 'pm-icon-btn';
          del.textContent = '🗑';
          del.title = '刪除';
          del.addEventListener('click', () => {
            const arr = getPrompts();
            if (arr.length <= 1) { alert(`${LOG} 至少需保留一個提示詞。`); return; }
            arr.splice(i, 1);
            savePrompts(arr);
            // Keep defaultPromptIndex in range.
            const cur = getSettings();
            if (cur.defaultPromptIndex >= arr.length) {
              GM_setValue('defaultPromptIndex', arr.length - 1);
            }
            drawList();
          });

          item.appendChild(ta);
          item.appendChild(del);
          list.appendChild(item);
        });
      };
      drawList();

      const addBtn = document.createElement('div');
      addBtn.className = 'pm-btn full';
      addBtn.style.marginTop = '4px';
      addBtn.textContent = '➕ 新增提示詞';
      addBtn.addEventListener('click', () => {
        const arr = getPrompts();
        arr.push('New prompt:');
        savePrompts(arr);
        drawList();
        positionMenu();
      });
      menu.appendChild(addBtn);

      const foot = document.createElement('div');
      foot.className = 'pm-foot';
      const back = document.createElement('div');
      back.className = 'pm-link';
      back.textContent = '← 返回';
      back.addEventListener('click', () => { menuView = 'main'; renderMain(); });
      const reset = document.createElement('div');
      reset.className = 'pm-link';
      reset.textContent = '↺ 還原預設';
      reset.addEventListener('click', () => {
        if (!confirm(`${LOG} 還原為預設提示詞？自訂內容將遺失。`)) return;
        savePrompts(DEFAULT_PROMPTS.slice());
        GM_setValue('defaultPromptIndex', 0);
        drawList();
        positionMenu();
      });
      foot.appendChild(back);
      foot.appendChild(reset);
      menu.appendChild(foot);
      positionMenu();
    }

    function showMenu() {
      if (menuView === 'settings') renderSettings();
      else if (menuView === 'prompts') renderPrompts();
      else renderMain();
      menu.classList.remove('hidden');
    }
    function hideMenu() {
      menu.classList.add('hidden');
    }
    function toggleMenu() {
      if (menu.classList.contains('hidden')) showMenu();
      else hideMenu();
    }

    // The plain-tap action, shared by pointer taps and the keyboard shortcut.
    function doBallTap() {
      if (getSettings().ballClickSends) {
        const s = getSettings();
        hideMenu();
        summarize(s.defaultProvider, s.defaultPromptIndex);
      } else {
        toggleMenu();
      }
    }
    ballTapHandler = doBallTap;

    // Close the menu when clicking elsewhere on the page.
    document.addEventListener('click', (e) => {
      if (!ballHost) return;
      if (e.composedPath && e.composedPath().includes(host)) return;
      hideMenu();
    });

    // --- Drag + click handling ---------------------------------------------
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;
    let longPressTimer = null;
    let longPressed = false;

    ball.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      moved = false;
      longPressed = false;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseFloat(host.style.left) || 0;
      origTop = parseFloat(host.style.top) || 0;
      ball.setPointerCapture(e.pointerId);
      ball.classList.add('dragging');
      // Long-press always opens the menu (reachable even in click-sends mode).
      longPressTimer = setTimeout(() => {
        longPressed = true;
        showMenu();
      }, 500);
    });

    ball.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 5) {
        moved = true;
        clearTimeout(longPressTimer);
        hideMenu();
      }
      if (moved) {
        const c = clampBallPos(origLeft + dx, origTop + dy);
        host.style.left = c.left + 'px';
        host.style.top = c.top + 'px';
      }
    });

    ball.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      clearTimeout(longPressTimer);
      ball.classList.remove('dragging');
      try { ball.releasePointerCapture(e.pointerId); } catch { /* noop */ }

      if (moved) {
        GM_setValue(BALL_POS_KEY, {
          left: parseFloat(host.style.left) || 0,
          top: parseFloat(host.style.top) || 0,
        });
        return;
      }
      if (longPressed) return; // menu already shown by long-press

      // A plain tap: send directly or open the menu, per setting.
      doBallTap();
    });
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  const provider = detectProvider();
  if (provider) {
    // On an AI provider page: try to inject any pending payload.
    runInjector(provider);
    // Also expose source menus here so the provider page itself can be summarized.
  }
  registerSourceMenus();

  // Floating ball: toggle command + initial render.
  GM_registerMenuCommand('🧠 Toggle floating ball', () => {
    const next = !getSettings().showBall;
    GM_setValue('showBall', next);
    if (next) createFloatingBall();
    else removeFloatingBall();
    alert(`${LOG} Floating ball ${next ? 'shown' : 'hidden'}.`);
  });

  // Global keyboard shortcut (equivalent to tapping the ball).
  window.addEventListener('keydown', onShortcutKeyDown, true);

  if (document.body) {
    createFloatingBall();
  } else {
    document.addEventListener('DOMContentLoaded', () => createFloatingBall(), { once: true });
  }
})();
