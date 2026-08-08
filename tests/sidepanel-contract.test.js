import assert from 'node:assert/strict';
import test from 'node:test';

const previousDocument = globalThis.document;
globalThis.document = { addEventListener() {} };
const {
  createSidePanelController,
  DELIVERY_ACK_TIMEOUT_MS,
  FRAME_READY_TIMEOUT_MS,
} = await import('../sidepanel.js?contract-test');
globalThis.document = previousDocument;

const PROVIDERS = ['chatgpt', 'gemini', 'claude', 'grok'];

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    const enabled = force ?? !this.values.has(value);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.dataset = {};
    this.children = [];
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
  }
  set innerHTML(value) { if (value === '') this.children = []; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ target: this, preventDefault() {}, ...event });
    }
  }
  closest(selector) {
    return selector === '.provider-btn' && this.classList.contains('provider-btn') ? this : null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

class FakeFrame extends FakeElement {
  constructor(owner) {
    super('providerFrame');
    this.owner = owner;
    this.srcWrites = [];
    this.posts = [];
    this.contentWindow = {
      postMessage: (message, origin) => this.posts.push({ message, origin }),
    };
  }
  set src(value) { this._src = value; this.srcWrites.push(value); }
  get src() { return this._src ?? ''; }
  cloneNode() {
    const clone = new FakeFrame(this.owner);
    if (this.src) {
      clone._src = this.src;
      clone.srcWrites.push(this.src);
    }
    return clone;
  }
  removeAttribute(name) {
    if (name === 'src') {
      this._src = '';
      this.srcWrites = [];
    }
  }
  replaceWith(replacement) {
    this.owner.elements.set('providerFrame', replacement);
  }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
  }
}

class ChromeEvent {
  constructor() { this.listeners = []; }
  addListener(listener) { this.listeners.push(listener); }
  async emit(...args) {
    for (const listener of this.listeners) await listener(...args);
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    for (const id of [
      'panelControls', 'collapseBtn', 'reloadBtn', 'openTabBtn', 'providerFrame',
      'frameFallback', 'retryFrameBtn', 'fallbackNewTabBtn', 'fallbackMessage',
      'providerGrid', 'promptSelect', 'summarizeBtn', 'settingsBtn', 'statusMsg',
      'clipboardHint', 'pageTitle', 'pageUrl',
    ]) this.elements.set(id, id === 'providerFrame' ? new FakeFrame(this) : new FakeElement(id));
    this.providerButtons = PROVIDERS.map((provider) => {
      const button = new FakeElement();
      button.dataset.provider = provider;
      button.classList.add('provider-btn');
      return button;
    });
  }
  getElementById(id) { return this.elements.get(id); }
  querySelectorAll(selector) { return selector === '.provider-btn' ? this.providerButtons : []; }
  createElement() { return new FakeElement(); }
}

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function createHarness({
  settings = {}, pendingProvider = null, activeTab = { id: 31, windowId: 7, title: 'Source', url: 'https://source.test/' },
} = {}) {
  const document = new FakeDocument();
  const window = new FakeEventTarget();
  const runtimeEvent = new ChromeEvent();
  const tabActivated = new ChromeEvent();
  const tabUpdated = new ChromeEvent();
  const storageChanged = new ChromeEvent();
  const runtimeCalls = [];
  const tabCreates = [];
  const storageWrites = [];
  const scriptCalls = [];
  const timers = [];
  let payloadResponse = { payload: null };
  let panelReadyResponse = { provider: pendingProvider };
  let summarizeResponse = { success: true, destination: 'sidepanel' };
  let currentTab = activeTab;

  const chrome = {
    runtime: {
      id: 'extension-id',
      lastError: undefined,
      onMessage: runtimeEvent,
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      openOptionsPage() {},
      sendMessage(message, callback) {
        runtimeCalls.push(message);
        const response = message.type === 'PANEL_READY'
          ? panelReadyResponse
          : message.type === 'GET_PAYLOAD'
            ? payloadResponse
            : summarizeResponse;
        callback?.(response);
        return Promise.resolve(response);
      },
    },
    storage: {
      onChanged: storageChanged,
      sync: {
        get(_keys, callback) { callback(settings); },
        set(value, callback) { storageWrites.push(value); callback?.(); },
      },
    },
    windows: {
      getCurrent(_options, callback) { callback({ id: 7 }); },
    },
    tabs: {
      onActivated: tabActivated,
      onUpdated: tabUpdated,
      query(_query, callback) { callback(currentTab ? [currentTab] : []); },
      create(options, callback) { tabCreates.push(options); callback?.({ id: 99, ...options }); },
    },
    scripting: {
      executeScript(options) {
        scriptCalls.push(options);
        return Promise.resolve([{ result: 'Selected words' }]);
      },
    },
  };
  const clock = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  };
  const controller = createSidePanelController({ document, window, chrome, clock });
  const trustedSender = { id: 'extension-id', url: 'chrome-extension://extension-id/background.js' };

  return {
    chrome, controller, document, get frame() { return document.getElementById('providerFrame'); },
    runtimeCalls, runtimeEvent, scriptCalls, storageChanged,
    storageWrites, tabCreates, timers, trustedSender, window,
    setPayload(payload) { payloadResponse = { payload }; },
    setPayloadResponse(response) { payloadResponse = response; },
    setPanelReadyResponse(response) { panelReadyResponse = response; },
    setSummarizeResponse(response) { summarizeResponse = response; },
    setCurrentTab(tab) { currentTab = tab; },
    async ready(provider, origin) {
      const frame = document.getElementById('providerFrame');
      await window.dispatch('message', {
        source: frame.contentWindow,
        origin,
        data: { type: 'PANEL_READY', provider },
      });
      await flush();
    },
    async ack(provider, origin, payloadId, overrides = {}) {
      const frame = document.getElementById('providerFrame');
      await window.dispatch('message', {
        source: frame.contentWindow,
        origin,
        data: {
          type: 'PAGE_MIND_DELIVERED', provider, windowId: 7, payloadId,
          ...overrides,
        },
      });
      await flush();
    },
  };
}

test('exports the testable 12 second readiness timeout', () => {
  assert.equal(typeof createSidePanelController, 'function');
  assert.equal(FRAME_READY_TIMEOUT_MS, 12_000);
  assert.equal(DELIVERY_ACK_TIMEOUT_MS, 12_000);
});

test('initialization asks for pending provider and navigates exactly once', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' }, pendingProvider: 'gemini' });
  await harness.controller.initialize();

  assert.deepEqual(harness.runtimeCalls[0], { type: 'PANEL_READY', windowId: 7 });
  assert.deepEqual(harness.frame.srcWrites, ['https://gemini.google.com/app']);
  assert.equal(harness.document.providerButtons[1].classList.contains('selected'), true);
});

test('trusted frame readiness consumes and delivers the exact payload to its origin', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  const payload = { id: 'payload-1', provider: 'claude', text: 'Summary', autoSubmit: true };
  harness.setPayload(payload);
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');

  assert.deepEqual(harness.runtimeCalls.at(-1), {
    type: 'GET_PAYLOAD', provider: 'claude', context: 'sidepanel', windowId: 7,
  });
  assert.deepEqual(harness.frame.posts, [{
    origin: 'https://claude.ai',
    message: {
      type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
      payloadId: 'payload-1', payload,
    },
  }]);
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
});

test('only an exact delivery ACK clears the locally retained payload', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  harness.setPayload({ id: 'ack-me', provider: 'claude', text: 'Summary' });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  const firstFrame = harness.frame;

  await harness.ack('claude', 'https://evil.test', 'ack-me');
  await harness.ack('claude', 'https://claude.ai', 'wrong-id');
  await harness.ack('grok', 'https://claude.ai', 'ack-me');
  await harness.ack('claude', 'https://claude.ai', 'ack-me', { windowId: 8 });
  await harness.window.dispatch('message', {
    source: {},
    origin: 'https://claude.ai',
    data: { type: 'PAGE_MIND_DELIVERED', provider: 'claude', windowId: 7, payloadId: 'ack-me' },
  });
  await harness.document.getElementById('reloadBtn').dispatch('click');
  harness.setPayloadResponse({ payload: null });
  await harness.ready('claude', 'https://claude.ai');
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'ack-me');

  await harness.ack('claude', 'https://claude.ai', 'ack-me');
  await harness.document.getElementById('reloadBtn').dispatch('click');
  await harness.ready('claude', 'https://claude.ai');
  assert.deepEqual(harness.frame.posts, []);
  assert.notEqual(firstFrame, harness.frame);
});

test('delivery ACK timeout shows fallback and Retry redelivers the retained payload', async () => {
  const harness = createHarness({ settings: { lastProvider: 'grok' } });
  harness.setPayload({ id: 'needs-ack', provider: 'grok', text: 'Summary' });
  await harness.controller.initialize();
  await harness.ready('grok', 'https://grok.com');
  const ackTimer = harness.timers.at(-1);
  assert.equal(ackTimer.delay, 12_000);
  ackTimer.callback();
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), true);

  harness.setPayloadResponse({ payload: null });
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  await flush();
  await harness.ready('grok', 'https://grok.com');
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'needs-ack');
});

test('ACK-timeout Retry reposts retained payload when fresh lookup transiently fails', async () => {
  const harness = createHarness({ settings: { lastProvider: 'grok' } });
  harness.setPayload({ id: 'retry-retained', provider: 'grok', text: 'Summary' });
  await harness.controller.initialize();
  await harness.ready('grok', 'https://grok.com');
  harness.timers.at(-1).callback();

  harness.setPayloadResponse({ error: 'temporary lookup failure' });
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  await flush();
  await harness.ready('grok', 'https://grok.com');
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'retry-retained');
  assert.match(harness.document.getElementById('statusMsg').textContent, /temporary lookup failure/);
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
  assert.equal(harness.timers.at(-1).delay, 12_000);
});

test('readiness fetches fresh payload before choosing between fresh and retained', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  harness.setPayload({ id: 'retained-a', provider: 'claude', text: 'A', createdAt: 100 });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  harness.frame.posts.length = 0;

  harness.setPayload({ id: 'fresh-b', provider: 'claude', text: 'B', createdAt: 200 });
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  assert.deepEqual(harness.frame.posts.map(({ message }) => message.payloadId), ['fresh-b']);
});

test('older GET response cannot replace a newer candidate retained during navigation', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  await harness.controller.initialize();
  const callbacks = [];
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'GET_PAYLOAD') {
      callbacks.push(callback);
      return undefined;
    }
    return originalSend(message, callback);
  };
  await harness.ready('claude', 'https://claude.ai');
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  await harness.document.getElementById('reloadBtn').dispatch('click');
  callbacks[1]({ payload: { id: 'newer-candidate', provider: 'claude', text: 'B' } });
  await flush();
  callbacks[0]({ payload: { id: 'older-candidate', provider: 'claude', text: 'A' } });
  await flush();
  harness.chrome.runtime.sendMessage = originalSend;
  harness.setPayloadResponse({ payload: null });
  await harness.ready('claude', 'https://claude.ai');
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'newer-candidate');
});

test('later finite createdAt wins when retained payload is newer than fresh route', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  harness.setPayload({ id: 'retained-newer', provider: 'claude', text: 'A', createdAt: 300 });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  harness.frame.posts.length = 0;
  harness.setPayload({ id: 'fresh-older', provider: 'claude', text: 'B', createdAt: 200 });
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  assert.deepEqual(harness.frame.posts.map(({ message }) => message.payloadId), ['retained-newer']);
});

test('stale ACK for replaced payload cannot clear the newer retained payload', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  harness.setPayload({ id: 'payload-a', provider: 'claude', text: 'A', createdAt: 100 });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  harness.setPayload({ id: 'payload-b', provider: 'claude', text: 'B', createdAt: 200 });
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  await harness.ack('claude', 'https://claude.ai', 'payload-a');

  await harness.document.getElementById('reloadBtn').dispatch('click');
  harness.setPayloadResponse({ payload: null });
  await harness.ready('claude', 'https://claude.ai');
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'payload-b');
});

test('readiness never posts a delivery when background has no actual payload', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  assert.deepEqual(harness.frame.posts, []);
});

test('frame messages reject foreign source, origin, and provider without consuming', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  const before = harness.runtimeCalls.length;
  for (const event of [
    { source: {}, origin: 'https://chatgpt.com', data: { type: 'PANEL_READY', provider: 'chatgpt' } },
    { source: harness.frame.contentWindow, origin: 'https://evil.test', data: { type: 'PANEL_READY', provider: 'chatgpt' } },
    { source: harness.frame.contentWindow, origin: 'https://chatgpt.com', data: { type: 'PANEL_READY', provider: 'claude' } },
  ]) await harness.window.dispatch('message', event);
  await flush();

  assert.equal(harness.runtimeCalls.length, before);
  assert.deepEqual(harness.frame.posts, []);
});

test('same-provider PANEL_NAVIGATE delivers immediately while a different provider waits for readiness', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  await harness.ready('chatgpt', 'https://chatgpt.com');
  harness.runtimeCalls.length = 0;
  harness.frame.posts.length = 0;
  harness.setPayload({ id: 'same', provider: 'chatgpt', text: 'Same' });
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'chatgpt', url: 'https://chatgpt.com/',
  }, harness.trustedSender);
  await flush();
  assert.equal(harness.frame.srcWrites.length, 1);
  assert.equal(harness.frame.posts[0].message.payloadId, 'same');

  harness.setPayload({ id: 'other', provider: 'grok', text: 'Other' });
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'grok', url: 'https://grok.com/',
  }, harness.trustedSender);
  await flush();
  assert.equal(harness.frame.srcWrites.at(-1), 'https://grok.com/');
  assert.equal(harness.frame.posts.length, 0);
  await harness.ready('grok', 'https://grok.com');
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'other');
});

test('a stale payload response cannot deliver into a newer provider navigation', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  let releasePayload;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'GET_PAYLOAD') {
      harness.runtimeCalls.push(message);
      releasePayload = callback;
      return undefined;
    }
    return originalSend(message, callback);
  };
  await harness.ready('chatgpt', 'https://chatgpt.com');
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  releasePayload({ payload: { id: 'stale', provider: 'chatgpt', text: 'Old' } });
  await flush();
  assert.deepEqual(harness.frame.posts, []);
});

test('a stale payload error cannot show fallback over a newer provider', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  let releasePayload;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'GET_PAYLOAD') {
      releasePayload = callback;
      return undefined;
    }
    return originalSend(message, callback);
  };
  await harness.ready('chatgpt', 'https://chatgpt.com');
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  releasePayload({ error: 'old request failed' });
  await flush();
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
  assert.doesNotMatch(harness.document.getElementById('statusMsg').textContent, /old request failed/);
});

test('a consumed payload survives same-provider reload until the new frame is ready', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  let releasePayload;
  let held = false;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'GET_PAYLOAD' && !held) {
      held = true;
      harness.runtimeCalls.push(message);
      releasePayload = callback;
      return undefined;
    }
    return originalSend(message, callback);
  };
  await harness.ready('chatgpt', 'https://chatgpt.com');
  await harness.document.getElementById('reloadBtn').dispatch('click');
  releasePayload({ payload: { id: 'retained', provider: 'chatgpt', text: 'Keep me' } });
  await flush();
  await harness.ready('chatgpt', 'https://chatgpt.com');
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'retained');
});

test('old same-origin frame readiness cannot satisfy a reloaded navigation', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  const oldFrame = harness.frame;
  await harness.document.getElementById('reloadBtn').dispatch('click');
  harness.runtimeCalls.length = 0;
  await harness.window.dispatch('message', {
    source: oldFrame.contentWindow,
    origin: 'https://chatgpt.com',
    data: { type: 'PANEL_READY', provider: 'chatgpt' },
  });
  await flush();
  assert.equal(harness.runtimeCalls.some((message) => message.type === 'GET_PAYLOAD'), false);
});

test('runtime navigation ignores wrong windows, unsupported providers, and untrusted senders', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  const initialWrites = harness.frame.srcWrites.length;
  const messages = [
    [{ type: 'PANEL_NAVIGATE', windowId: 8, provider: 'claude' }, harness.trustedSender],
    [{ type: 'PANEL_NAVIGATE', windowId: 7, provider: 'unknown' }, harness.trustedSender],
    [{ type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude' }, { ...harness.trustedSender, id: 'other' }],
    [{ type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude' }, { ...harness.trustedSender, tab: { id: 1 } }],
    [{ type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude' }, { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' }],
  ];
  for (const args of messages) await harness.runtimeEvent.emit(...args);
  await flush();
  assert.equal(harness.frame.srcWrites.length, initialWrites);
});

test('runtime navigation rejects a foreign URL and navigates to the provider policy URL', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://evil.test/phish',
  }, harness.trustedSender);
  assert.equal(harness.frame.srcWrites.at(-1), 'https://claude.ai/new');
});

test('runtime navigation refreshes custom URL policy before validating a background URL', async () => {
  const settings = { lastProvider: 'chatgpt', customUrls: {} };
  const harness = createHarness({ settings });
  await harness.controller.initialize();
  settings.customUrls = { claude: 'https://custom-claude.test/chat' };
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://custom-claude.test/chat',
  }, harness.trustedSender);
  await flush();
  assert.equal(harness.frame.src, 'https://custom-claude.test/chat');
});

test('a delayed older runtime navigation cannot override a newer navigation', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  const customUrlReads = [];
  harness.chrome.storage.sync.get = (keys, callback) => {
    if (keys.length === 1 && keys[0] === 'customUrls') customUrlReads.push(callback);
    else callback({});
  };
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'grok', url: 'https://grok.com/',
  }, harness.trustedSender);
  customUrlReads[1]({ customUrls: {} });
  await flush();
  customUrlReads[0]({ customUrls: {} });
  await flush();
  assert.equal(harness.frame.src, 'https://grok.com/');
});

test('local provider navigation supersedes runtime handler waiting on URL refresh', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  let releaseRefresh;
  harness.chrome.storage.sync.get = (keys, callback) => {
    if (keys.length === 1 && keys[0] === 'customUrls') releaseRefresh = callback;
    else callback({});
  };
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await harness.document.getElementById('providerGrid').dispatch('click', {
    target: harness.document.providerButtons[1],
  });
  releaseRefresh({ customUrls: {} });
  await flush();
  assert.equal(harness.frame.src, 'https://gemini.google.com/app');
});

test('a superseded custom URL refresh failure cannot overwrite current status', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  const customUrlReads = [];
  harness.chrome.storage.sync.get = (keys, callback) => {
    if (keys.length === 1 && keys[0] === 'customUrls') customUrlReads.push(callback);
    else callback({});
  };
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'grok', url: 'https://grok.com/',
  }, harness.trustedSender);
  customUrlReads[1]({ customUrls: {} });
  await flush();
  harness.chrome.runtime.lastError = { message: 'stale refresh failed' };
  customUrlReads[0]();
  delete harness.chrome.runtime.lastError;
  await flush();
  assert.doesNotMatch(harness.document.getElementById('statusMsg').textContent, /stale refresh failed/);
});

test('current custom URL refresh failure exposes retry that discovers the pending provider', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  harness.chrome.storage.sync.get = (keys, callback) => {
    if (keys.length === 1 && keys[0] === 'customUrls') {
      harness.chrome.runtime.lastError = { message: 'refresh failed' };
      callback();
      delete harness.chrome.runtime.lastError;
    } else callback({});
  };
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  assert.match(harness.document.getElementById('statusMsg').textContent, /refresh failed/);
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), true);

  harness.chrome.storage.sync.get = (_keys, callback) => callback({ customUrls: {} });
  harness.setPanelReadyResponse({ provider: 'claude' });
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  await flush();
  assert.equal(harness.frame.src, 'https://claude.ai/new');
});

test('a delayed custom URL refresh cannot overwrite a newer storage change', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  let releaseRefresh;
  harness.chrome.storage.sync.get = (keys, callback) => {
    if (keys.length === 1 && keys[0] === 'customUrls') releaseRefresh = callback;
    else callback({});
  };
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await harness.storageChanged.emit({
    customUrls: { newValue: { claude: 'https://new-custom.test/chat' } },
  }, 'sync');
  releaseRefresh({ customUrls: {} });
  await flush();
  assert.equal(harness.frame.src, 'https://new-custom.test/chat');
});

test('storage changes keep provider-button navigation on the latest custom URL policy', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt', customUrls: {} } });
  await harness.controller.initialize();
  await harness.storageChanged.emit({
    customUrls: { newValue: { claude: 'https://custom-claude.test/chat' } },
  }, 'sync');
  await harness.document.getElementById('providerGrid').dispatch('click', {
    target: harness.document.providerButtons[2],
  });
  assert.equal(harness.frame.src, 'https://custom-claude.test/chat');
});

test('stale navigation timeout cannot cover a newer provider but current timeout shows fallback', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  const staleTimer = harness.timers.at(-1);
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'gemini', url: 'https://gemini.google.com/app',
  }, harness.trustedSender);
  const currentTimer = harness.timers.at(-1);

  staleTimer.callback();
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
  currentTimer.callback();
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), true);
  assert.equal(currentTimer.delay, 12_000);
});

test('unsafe custom URL visibly falls back and open-tab uses the exact resolved built-in URL', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude', customUrls: { claude: 'http://unsafe.test/chat' } } });
  await harness.controller.initialize();
  assert.equal(harness.frame.src, 'https://claude.ai/new');
  assert.match(harness.document.getElementById('statusMsg').textContent, /built-in Claude URL/i);
  await harness.document.getElementById('openTabBtn').dispatch('click');
  assert.deepEqual(harness.tabCreates, [{ url: 'https://claude.ai/new', active: true }]);
});

test('open-tab and settings failures are reported instead of becoming inert', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  harness.chrome.tabs.create = (_options, callback) => {
    harness.chrome.runtime.lastError = { message: 'tab creation failed' };
    callback();
    delete harness.chrome.runtime.lastError;
  };
  await harness.document.getElementById('openTabBtn').dispatch('click');
  await flush();
  assert.match(harness.document.getElementById('statusMsg').textContent, /tab creation failed/);

  harness.chrome.runtime.openOptionsPage = () => Promise.reject(new Error('settings failed'));
  await harness.document.getElementById('settingsBtn').dispatch('click');
  await flush();
  assert.match(harness.document.getElementById('statusMsg').textContent, /settings failed/);
});

test('policy-rejected HTTPS custom URL also reports its built-in fallback', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude', customUrls: { claude: 'https://chatgpt.com/alternate' } } });
  await harness.controller.initialize();
  assert.equal(harness.frame.src, 'https://claude.ai/new');
  assert.match(harness.document.getElementById('statusMsg').textContent, /built-in Claude URL/i);
});

test('background payload errors remain visible and provide the retry fallback', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  harness.setPayloadResponse({ error: 'storage unavailable' });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  assert.match(harness.document.getElementById('statusMsg').textContent, /storage unavailable/);
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), true);
});

test('an older payload error cannot cover a newer successful consume', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  await harness.controller.initialize();
  let firstCallback;
  let requestCount = 0;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type !== 'GET_PAYLOAD') return originalSend(message, callback);
    requestCount += 1;
    if (requestCount === 1) firstCallback = callback;
    else callback({ payload: null });
    return undefined;
  };
  await harness.ready('claude', 'https://claude.ai');
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  firstCallback({ error: 'stale failure' });
  await flush();
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
  assert.doesNotMatch(harness.document.getElementById('statusMsg').textContent, /stale failure/);
});

test('late valid payload clears a newer consume error overlay when posted to current frame', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  await harness.controller.initialize();
  let firstCallback;
  let requestCount = 0;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type !== 'GET_PAYLOAD') return originalSend(message, callback);
    requestCount += 1;
    if (requestCount === 1) firstCallback = callback;
    else callback({ error: 'newer consume failed' });
    return undefined;
  };
  await harness.ready('claude', 'https://claude.ai');
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), true);
  firstCallback({ payload: { id: 'late-valid', provider: 'claude', text: 'Recovered' } });
  await flush();
  assert.equal(harness.frame.posts.at(-1).message.payloadId, 'late-valid');
  assert.equal(harness.document.getElementById('statusMsg').textContent, '');
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
});

test('older successful consume cannot post after a newer payload already delivered', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  await harness.controller.initialize();
  let firstCallback;
  let requestCount = 0;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type !== 'GET_PAYLOAD') return originalSend(message, callback);
    requestCount += 1;
    if (requestCount === 1) firstCallback = callback;
    else callback({ payload: { id: 'newer', provider: 'claude', text: 'Newer' } });
    return undefined;
  };
  await harness.ready('claude', 'https://claude.ai');
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  firstCallback({ payload: { id: 'older', provider: 'claude', text: 'Older' } });
  await flush();
  assert.deepEqual(harness.frame.posts.map(({ message }) => message.payloadId), ['newer']);
});

test('startup PANEL_READY errors are visible and retry discovers the pending provider', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  harness.setPanelReadyResponse({ error: 'discovery failed' });
  await harness.controller.initialize();
  assert.match(harness.document.getElementById('statusMsg').textContent, /discovery failed/);
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), true);

  harness.setPanelReadyResponse({ provider: 'claude' });
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  await flush();
  assert.equal(harness.frame.src, 'https://claude.ai/new');
});

test('delayed startup discovery cannot navigate over a newer background navigation', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  let releaseDiscovery;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'PANEL_READY') {
      releaseDiscovery = callback;
      return undefined;
    }
    return originalSend(message, callback);
  };
  const initialization = harness.controller.initialize();
  await flush();
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  releaseDiscovery({ provider: 'chatgpt' });
  await initialization;
  assert.equal(harness.frame.src, 'https://claude.ai/new');
});

test('delayed retry discovery cannot navigate over a newer background navigation', async () => {
  const harness = createHarness({ settings: { lastProvider: 'chatgpt' } });
  await harness.controller.initialize();
  let releaseDiscovery;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'PANEL_READY') {
      releaseDiscovery = callback;
      return undefined;
    }
    return originalSend(message, callback);
  };
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'grok', url: 'https://grok.com/',
  }, harness.trustedSender);
  await flush();
  releaseDiscovery({ provider: 'chatgpt' });
  await flush();
  assert.equal(harness.frame.src, 'https://grok.com/');
});

test('successful same-frame recovery clears both retrieval error and fallback overlay', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  harness.setPayloadResponse({ error: 'temporary failure' });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  harness.setPayload({ id: 'recovered-direct', provider: 'claude', text: 'Recovered' });
  await harness.runtimeEvent.emit({
    type: 'PANEL_NAVIGATE', windowId: 7, provider: 'claude', url: 'https://claude.ai/new',
  }, harness.trustedSender);
  await flush();
  assert.equal(harness.document.getElementById('statusMsg').textContent, '');
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
});

test('successful retry clears a previous payload retrieval error', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  harness.setPayloadResponse({ error: 'temporary failure' });
  await harness.controller.initialize();
  await harness.ready('claude', 'https://claude.ai');
  harness.setPayload({ id: 'recovered', provider: 'claude', text: 'Recovered' });
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  await flush();
  await harness.ready('claude', 'https://claude.ai');
  assert.equal(harness.document.getElementById('statusMsg').textContent, '');
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), false);
});

test('retry resolves the panel window again after initial window lookup failure', async () => {
  const harness = createHarness({ settings: { lastProvider: 'claude' } });
  let lookupCount = 0;
  harness.chrome.windows.getCurrent = (_options, callback) => {
    lookupCount += 1;
    if (lookupCount === 1) {
      harness.chrome.runtime.lastError = { message: 'window lookup failed' };
      callback();
      delete harness.chrome.runtime.lastError;
    } else callback({ id: 7 });
  };
  await harness.controller.initialize();
  assert.equal(harness.document.getElementById('frameFallback').classList.contains('visible'), true);
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  await flush();
  assert.equal(lookupCount, 2);
  assert.equal(harness.frame.src, 'https://claude.ai/new');
  assert.deepEqual(harness.runtimeCalls.at(-1), { type: 'PANEL_READY', windowId: 7 });
  assert.equal(harness.document.getElementById('pageTitle').textContent, 'Source');
});

test('fallback open-tab resolves a safe provider URL before any frame navigation', async () => {
  const harness = createHarness({
    settings: { lastProvider: 'claude', customUrls: { claude: 'http://unsafe.test/chat' } },
  });
  harness.chrome.windows.getCurrent = (_options, callback) => {
    harness.chrome.runtime.lastError = { message: 'window lookup failed' };
    callback();
    delete harness.chrome.runtime.lastError;
  };
  await harness.controller.initialize();
  await harness.document.getElementById('fallbackNewTabBtn').dispatch('click');
  await flush();
  assert.deepEqual(harness.tabCreates, [{ url: 'https://claude.ai/new', active: true }]);
});

test('collapse remains reversible and reload starts a fresh navigation', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  const controls = harness.document.getElementById('panelControls');
  const collapse = harness.document.getElementById('collapseBtn');
  await collapse.dispatch('click');
  assert.equal(controls.classList.contains('collapsed'), true);
  assert.equal(collapse.getAttribute('aria-expanded'), 'false');
  await collapse.dispatch('click');
  assert.equal(controls.classList.contains('collapsed'), false);
  assert.equal(collapse.getAttribute('aria-expanded'), 'true');

  await harness.document.getElementById('reloadBtn').dispatch('click');
  assert.equal(harness.frame.srcWrites.length, 1);
  await harness.document.getElementById('retryFrameBtn').dispatch('click');
  assert.equal(harness.frame.srcWrites.length, 1);
});

test('provider and prompt selections persist normalized values', async () => {
  const harness = createHarness({ settings: { lastProvider: 'not-supported', lastPromptIndex: -8 } });
  await harness.controller.initialize();
  assert.equal(harness.frame.src, 'https://chatgpt.com/');
  await harness.document.getElementById('providerGrid').dispatch('click', {
    target: harness.document.providerButtons[2],
  });
  harness.document.getElementById('promptSelect').value = '3';
  await harness.document.getElementById('promptSelect').dispatch('change');
  await flush();
  assert.deepEqual(harness.storageWrites, [{ lastProvider: 'claude' }, { lastPromptIndex: 3 }]);
  assert.deepEqual(
    harness.document.providerButtons.map((button) => button.getAttribute('aria-pressed')),
    ['false', 'false', 'true', 'false'],
  );
});

test('late active-tab results cannot overwrite newer page information', async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  const queries = [];
  harness.chrome.tabs.query = (_query, callback) => queries.push(callback);
  await harness.chrome.tabs.onActivated.emit({ tabId: 41, windowId: 7 });
  await harness.chrome.tabs.onActivated.emit({ tabId: 42, windowId: 7 });
  queries[1]([{ id: 42, windowId: 7, title: 'New tab', url: 'https://new.test/' }]);
  await flush();
  queries[0]([{ id: 41, windowId: 7, title: 'Old tab', url: 'https://old.test/' }]);
  await flush();
  assert.equal(harness.document.getElementById('pageTitle').textContent, 'New tab');
  assert.equal(harness.document.getElementById('pageUrl').textContent, 'https://new.test/');
});

test('side-panel summary captures exact active tab and always targets its panel', async () => {
  const harness = createHarness({ settings: { lastProvider: 'gemini', lastPromptIndex: 2 } });
  await harness.controller.initialize();
  harness.runtimeCalls.length = 0;
  await harness.document.getElementById('summarizeBtn').dispatch('click');
  const summarize = harness.runtimeCalls.find((message) => message.type === 'SUMMARIZE');

  assert.deepEqual(summarize, {
    type: 'SUMMARIZE', provider: 'gemini', promptIndex: 2,
    selectedText: 'Selected words', source: 'sidepanel', destination: 'sidepanel',
    sourceTabId: 31, sourceWindowId: 7,
  });
  assert.deepEqual(harness.scriptCalls.at(-1).target, { tabId: 31, allFrames: true });
  assert.equal(harness.document.getElementById('summarizeBtn').disabled, false);
});

test('malformed summary response exits loading with an error and re-enables', async () => {
  const harness = createHarness();
  harness.setSummarizeResponse(undefined);
  await harness.controller.initialize();
  await harness.document.getElementById('summarizeBtn').dispatch('click');
  assert.equal(harness.document.getElementById('summarizeBtn').disabled, false);
  assert.match(harness.document.getElementById('statusMsg').textContent, /unexpected response/i);
  assert.equal(harness.document.getElementById('statusMsg').classList.contains('error'), true);
});

test('summary status captures request provider and clipboard hint requires explicit confirmation', async () => {
  const harness = createHarness({ settings: { lastProvider: 'gemini' } });
  let releaseSummary;
  const originalSend = harness.chrome.runtime.sendMessage;
  harness.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'SUMMARIZE') {
      releaseSummary = callback;
      return undefined;
    }
    return originalSend(message, callback);
  };
  await harness.controller.initialize();
  const summary = harness.document.getElementById('summarizeBtn').dispatch('click');
  await flush();
  await harness.document.getElementById('providerGrid').dispatch('click', {
    target: harness.document.providerButtons[2],
  });
  releaseSummary({ success: true, destination: 'sidepanel', clipboardCopied: false });
  await summary;
  assert.match(harness.document.getElementById('statusMsg').textContent, /Gemini/);
  assert.equal(harness.document.getElementById('clipboardHint').classList.contains('visible'), false);
});
