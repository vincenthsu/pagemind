import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const BRIDGE_URL = new URL('../injectors/bridge.js', import.meta.url);
const EXTENSION_ORIGIN = 'chrome-extension://pagemind';
const INJECTOR_URLS = Object.freeze({
  chatgpt: new URL('../injectors/chatgpt.js', import.meta.url),
  gemini: new URL('../injectors/gemini.js', import.meta.url),
  claude: new URL('../injectors/claude.js', import.meta.url),
  grok: new URL('../injectors/grok.js', import.meta.url),
});

async function createHarness({
  frame = 'top',
  readyState = 'complete',
  runtimeAvailable = true,
  responses = [],
} = {}) {
  const source = await readFile(BRIDGE_URL, 'utf8');
  const windowListeners = new Map();
  const documentListeners = new Map();
  const runtimeMessages = [];
  const parentMessages = [];
  const timers = [];
  const errors = [];
  const top = {};
  const parent = frame === 'nested' ? {} : top;
  const window = frame === 'top' ? top : {};
  const document = { readyState };

  window.top = top;
  window.parent = frame === 'top' ? window : parent;
  window.addEventListener = (type, listener) => {
    const listeners = windowListeners.get(type) ?? [];
    listeners.push(listener);
    windowListeners.set(type, listeners);
  };
  window.removeEventListener = (type, listener) => {
    const listeners = windowListeners.get(type) ?? [];
    windowListeners.set(type, listeners.filter((candidate) => candidate !== listener));
  };
  document.addEventListener = (type, listener) => {
    const listeners = documentListeners.get(type) ?? [];
    listeners.push(listener);
    documentListeners.set(type, listeners);
  };
  parent.postMessage = (data, origin) => parentMessages.push({ data, origin });

  const runtime = {
    lastError: undefined,
    getURL(path) {
      assert.equal(path, '');
      return `${EXTENSION_ORIGIN}/`;
    },
    sendMessage(message, callback) {
      runtimeMessages.push(message);
      const response = responses.shift();
      if (typeof response === 'function') response(callback);
      else callback(response);
    },
  };
  const context = {
    console: { error: (...args) => errors.push(args) },
    document,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    window,
  };
  if (runtimeAvailable) context.chrome = { runtime };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'injectors/bridge.js' });

  return {
    bridge: context.PageMindBridge,
    document,
    documentListeners,
    enableRuntime() { context.chrome = { runtime }; },
    errors,
    fireDocument(type) {
      document.readyState = 'complete';
      for (const listener of documentListeners.get(type) ?? []) listener();
    },
    parent,
    parentMessages,
    runtimeMessages,
    timers,
    windowListeners,
  };
}

async function createProviderHarness(provider, { inputAvailable = true } = {}) {
  const sources = await Promise.all([
    readFile(BRIDGE_URL, 'utf8'),
    readFile(INJECTOR_URLS[provider], 'utf8'),
    ...(provider === 'grok'
      ? [readFile(new URL('../injectors/grok-main.js', import.meta.url), 'utf8')]
      : []),
  ]);
  const parentMessages = [];
  const windowMessages = [];
  const documentEvents = [];
  const timers = [];
  const errors = [];
  const selectorResults = new Map();

  function addEventTarget(target) {
    const listeners = new Map();
    target.addEventListener = (type, listener, options) => {
      const entries = listeners.get(type) ?? [];
      entries.push({ listener, once: options?.once === true });
      listeners.set(type, entries);
    };
    target.removeEventListener = (type, listener) => {
      const entries = listeners.get(type) ?? [];
      listeners.set(type, entries.filter((entry) => entry.listener !== listener));
    };
    target.dispatchEvent = (event) => {
      event.target ??= target;
      event.currentTarget = target;
      for (const entry of [...(listeners.get(event.type) ?? [])]) {
        entry.listener.call(target, event);
        if (entry.once) target.removeEventListener(event.type, entry.listener);
      }
      return !event.defaultPrevented;
    };
    target.listeners = listeners;
  }

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = init.bubbles === true;
      this.cancelable = init.cancelable === true;
      this.defaultPrevented = false;
      Object.assign(this, init);
    }

    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }
  class FakeCustomEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail;
    }
  }

  const document = { readyState: 'complete', activeElement: null };
  addEventTarget(document);
  const originalDocumentDispatch = document.dispatchEvent;
  document.dispatchEvent = (event) => {
    documentEvents.push({ type: event.type, detail: event.detail });
    return originalDocumentDispatch(event);
  };

  function createElement(tagName) {
    let value = '';
    const element = {
      tagName,
      disabled: false,
      textContent: '',
      events: [],
      clicks: 0,
      get value() { return value; },
      set value(nextValue) { value = nextValue; },
      focus() { document.activeElement = element; },
      click() { element.clicks += 1; },
      closest() { return null; },
    };
    addEventTarget(element);
    const originalDispatch = element.dispatchEvent;
    element.dispatchEvent = (event) => {
      element.events.push(event);
      return originalDispatch(event);
    };
    return element;
  }

  const inputs = {
    chatgpt: createElement('DIV'),
    gemini: createElement('DIV'),
    claude: createElement('DIV'),
    grok: createElement('TEXTAREA'),
  };
  const submit = createElement('BUTTON');
  const primarySelectors = {
    chatgpt: '#prompt-textarea',
    gemini: '.ql-editor[contenteditable="true"]',
    claude: '.ProseMirror[contenteditable="true"]',
    grok: 'textarea[placeholder]',
  };
  const submitSelectors = {
    chatgpt: 'button[data-testid="send-button"]',
    gemini: 'button.send-button',
    claude: 'button[aria-label="Send Message"]',
    grok: 'button[aria-label="Send"]',
  };
  if (inputAvailable) selectorResults.set(primarySelectors[provider], inputs[provider]);
  selectorResults.set(submitSelectors[provider], submit);
  document.querySelector = (selector) => selectorResults.get(selector) ?? null;
  document.execCommand = (command, _showUi, argument) => {
    if (command === 'insertText' && document.activeElement) {
      if (document.activeElement.tagName === 'TEXTAREA') document.activeElement.value = argument;
      else document.activeElement.textContent = argument;
    }
    return true;
  };
  document.createRange = () => ({ selectNodeContents() {} });

  const top = {};
  const parent = top;
  parent.postMessage = (data, origin) => parentMessages.push({ data, origin });
  const window = { top, parent };
  addEventTarget(window);
  window.postMessage = (data, origin) => windowMessages.push({ data, origin });
  window.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  window.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  Object.defineProperty(window.HTMLTextAreaElement.prototype, 'value', {
    set(value) { this.value = value; },
  });

  const context = {
    chrome: { runtime: { getURL: () => `${EXTENSION_ORIGIN}/` } },
    console: {
      error: (...args) => errors.push(args),
      log() {},
    },
    CustomEvent: FakeCustomEvent,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    document,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    window,
  };
  context.globalThis = context;

  vm.runInNewContext(sources[0], context, { filename: 'injectors/bridge.js' });
  if (provider === 'grok') {
    vm.runInNewContext(sources[2], context, { filename: 'injectors/grok-main.js' });
  }
  vm.runInNewContext(sources[1], context, { filename: `injectors/${provider}.js` });

  return {
    deliver(overrides = {}) {
      window.dispatchEvent({
        type: 'message',
        source: parent,
        origin: EXTENSION_ORIGIN,
        data: {
          type: 'PAGE_MIND_DELIVER',
          provider,
          windowId: 31,
          payloadId: `${provider}-payload`,
          payload: { provider, text: `Prompt for ${provider}`, autoSubmit: false },
        },
        ...overrides,
      });
    },
    document,
    documentEvents,
    errors,
    input: inputs[provider],
    installInput() { selectorResults.set(primarySelectors[provider], inputs[provider]); },
    parent,
    parentMessages,
    runTimer(delay) {
      const timer = timers.find((candidate) => !candidate.cleared && candidate.delay === delay);
      assert.ok(timer, `expected a ${delay}ms timer`);
      timer.cleared = true;
      timer.callback();
    },
    submit,
    timers,
    window,
    windowMessages,
  };
}

async function settleEvents() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

function deliver(harness, overrides = {}) {
  const event = {
    source: harness.parent,
    origin: EXTENSION_ORIGIN,
    data: {
      type: 'PAGE_MIND_DELIVER',
      provider: 'claude',
      windowId: 7,
      payloadId: 'panel-1',
      payload: { text: 'Explain this' },
    },
    ...overrides,
  };
  for (const listener of harness.windowListeners.get('message') ?? []) listener(event);
}

test('publishes the bridge before runtime APIs are available and retries after 400ms', async () => {
  const harness = await createHarness({ frame: 'direct', runtimeAvailable: false });

  assert.equal(typeof harness.bridge.register, 'function');
  harness.bridge.register('claude', async () => {});
  assert.deepEqual(harness.parentMessages, []);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 400);

  harness.enableRuntime();
  harness.timers[0].callback();
  assert.deepEqual(structuredClone(harness.parentMessages), [{
    data: { type: 'PANEL_READY', provider: 'claude' },
    origin: EXTENSION_ORIGIN,
  }]);
});

test('top-level registration requests and delivers an explicitly identified runtime payload', async () => {
  const payload = { id: 'tab-1', text: 'Summarize this' };
  const harness = await createHarness({ responses: [{ payload }] });
  const delivered = [];

  harness.bridge.register('chatgpt', async (value) => delivered.push(value));
  await Promise.resolve();

  assert.deepEqual(structuredClone(harness.runtimeMessages), [{
    type: 'GET_PAYLOAD', provider: 'chatgpt', context: 'tab',
  }]);
  assert.deepEqual(delivered, [payload]);
  assert.equal(Object.isFrozen(harness.bridge), true);
});

test('runtime delivery rejects malformed IDs and payloads and retries every 400ms', async () => {
  const payload = { id: 'tab-valid', text: 'Valid' };
  const harness = await createHarness({ responses: [
    { payload: { id: 42 } },
    { payload: null },
    { payload: 'not an object' },
    { payload },
  ] });
  const delivered = [];

  harness.bridge.register('gemini', async (value) => delivered.push(value));
  assert.equal(harness.timers[0].delay, 400);
  harness.timers[0].callback();
  assert.equal(harness.timers[1].delay, 400);
  harness.timers[1].callback();
  assert.equal(harness.timers[2].delay, 400);
  harness.timers[2].callback();
  await Promise.resolve();

  assert.deepEqual(delivered, [payload]);
  assert.equal(harness.runtimeMessages.length, 4);
});

test('direct panel child announces PANEL_READY only after DOMContentLoaded', async () => {
  const harness = await createHarness({ frame: 'direct', readyState: 'loading' });

  harness.bridge.register('claude', async () => {});
  assert.deepEqual(harness.parentMessages, []);

  harness.fireDocument('DOMContentLoaded');
  assert.deepEqual(structuredClone(harness.parentMessages), [{
    data: { type: 'PANEL_READY', provider: 'claude' },
    origin: EXTENSION_ORIGIN,
  }]);
  assert.deepEqual(harness.runtimeMessages, []);
});

test('trusted PAGE_MIND_DELIVER supplies the panel payload directly', async () => {
  const payload = { text: 'Panel payload' };
  const harness = await createHarness({ frame: 'direct' });
  const delivered = [];
  harness.bridge.register('claude', async (value) => delivered.push(value));

  deliver(harness, { data: {
    type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 17,
    payloadId: 'panel-17', payload,
  } });
  await new Promise(setImmediate);

  assert.deepEqual(delivered, [payload]);
  assert.deepEqual(harness.runtimeMessages, []);
  assert.deepEqual(structuredClone(harness.parentMessages.at(-1)), {
    data: {
      type: 'PAGE_MIND_DELIVERED', provider: 'claude', windowId: 17,
      payloadId: 'panel-17',
    },
    origin: EXTENSION_ORIGIN,
  });
});

test('failed panel delivery is not acknowledged and the same payloadId can retry', async () => {
  const harness = await createHarness({ frame: 'direct' });
  let attempts = 0;
  harness.bridge.register('claude', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient editor failure');
  });

  deliver(harness);
  await new Promise(setImmediate);
  assert.equal(attempts, 1);
  assert.equal(harness.parentMessages.length, 1);

  deliver(harness);
  await new Promise(setImmediate);
  assert.equal(attempts, 2);
  assert.deepEqual(structuredClone(harness.parentMessages.at(-1)), {
    data: {
      type: 'PAGE_MIND_DELIVERED', provider: 'claude', windowId: 7,
      payloadId: 'panel-1',
    },
    origin: EXTENSION_ORIGIN,
  });
});

test('concurrent panel duplicate runs and acknowledges exactly once', async () => {
  const harness = await createHarness({ frame: 'direct' });
  let deliveries = 0;
  let resolveHandler;
  harness.bridge.register('claude', async () => {
    deliveries += 1;
    await new Promise((resolve) => { resolveHandler = resolve; });
  });

  deliver(harness);
  deliver(harness);
  await Promise.resolve();
  assert.equal(deliveries, 1);

  resolveHandler();
  await new Promise(setImmediate);
  deliver(harness);
  await new Promise(setImmediate);

  assert.equal(deliveries, 1);
  assert.equal(harness.parentMessages.filter(({ data }) => (
    data.type === 'PAGE_MIND_DELIVERED'
  )).length, 1);
});

test('top-level delivery never posts PAGE_MIND_DELIVERED', async () => {
  const payload = { id: 'tab-ack-boundary', text: 'Top level' };
  const harness = await createHarness({ responses: [{ payload }] });

  harness.bridge.register('chatgpt', async () => {});
  await new Promise(setImmediate);

  assert.deepEqual(harness.parentMessages, []);
});

test('top-level handler failure retries the fetched payload without another GET_PAYLOAD', async () => {
  const payload = { id: 'tab-retry', text: 'Retry top-level editor' };
  const harness = await createHarness({ responses: [{ payload }] });
  let attempts = 0;
  harness.bridge.register('chatgpt', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('editor not mounted');
  });
  await new Promise(setImmediate);

  assert.equal(attempts, 1);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 400);

  harness.timers[0].callback();
  await new Promise(setImmediate);

  assert.equal(attempts, 2);
  assert.equal(harness.runtimeMessages.length, 1);
  assert.deepEqual(harness.parentMessages, []);
});

test('panel delivery ignores untrusted and malformed messages', async () => {
  const harness = await createHarness({ frame: 'direct' });
  let deliveries = 0;
  harness.bridge.register('claude', async () => { deliveries += 1; });
  const validData = {
    type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
    payloadId: 'panel-1', payload: { text: 'Valid' },
  };
  const invalidEvents = [
    { source: {}, origin: EXTENSION_ORIGIN, data: validData },
    { source: harness.parent, origin: 'https://evil.example', data: validData },
    { source: harness.parent, origin: EXTENSION_ORIGIN, data: { ...validData, type: 'PAGEMIND_DELIVER' } },
    { source: harness.parent, origin: EXTENSION_ORIGIN, data: { ...validData, provider: 'grok' } },
    { source: harness.parent, origin: EXTENSION_ORIGIN, data: { ...validData, windowId: 7.5 } },
    { source: harness.parent, origin: EXTENSION_ORIGIN, data: { ...validData, payloadId: 7 } },
    { source: harness.parent, origin: EXTENSION_ORIGIN, data: { ...validData, payloadId: '' } },
    { source: harness.parent, origin: EXTENSION_ORIGIN, data: { ...validData, payload: null } },
    { source: harness.parent, origin: EXTENSION_ORIGIN, data: { ...validData, payload: 'text' } },
  ];

  for (const event of invalidEvents) deliver(harness, event);
  await Promise.resolve();

  assert.equal(deliveries, 0);
  assert.deepEqual(harness.runtimeMessages, []);
});

test('panel deliveries deduplicate by payloadId before awaiting the handler', async () => {
  const harness = await createHarness({ frame: 'direct' });
  let deliveries = 0;
  harness.bridge.register('claude', async () => {
    deliveries += 1;
    await new Promise(() => {});
  });

  deliver(harness);
  deliver(harness, { data: {
    type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
    payloadId: 'panel-1', payload: { text: 'Different value, same ID' },
  } });
  await Promise.resolve();

  assert.equal(deliveries, 1);
});

test('panel deliveries reject nonconsecutive replays of a payloadId', async () => {
  const harness = await createHarness({ frame: 'direct' });
  const deliveries = [];
  harness.bridge.register('claude', async (payload) => deliveries.push(payload.text));

  deliver(harness, { data: {
    type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
    payloadId: 'panel-a', payload: { text: 'A' },
  } });
  deliver(harness, { data: {
    type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
    payloadId: 'panel-b', payload: { text: 'B' },
  } });
  deliver(harness, { data: {
    type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
    payloadId: 'panel-a', payload: { text: 'A replay' },
  } });
  await Promise.resolve();

  assert.deepEqual(deliveries, ['A', 'B']);
});

test('stale registration DOM work and messages cannot reach the active handler', async () => {
  const harness = await createHarness({ frame: 'direct', readyState: 'loading' });
  const oldDeliveries = [];
  const newDeliveries = [];

  harness.bridge.register('claude', async (payload) => oldDeliveries.push(payload));
  harness.bridge.register('grok', async (payload) => newDeliveries.push(payload));
  harness.fireDocument('DOMContentLoaded');
  deliver(harness);
  deliver(harness, { data: {
    type: 'PAGE_MIND_DELIVER', provider: 'grok', windowId: 7,
    payloadId: 'new-panel', payload: { text: 'New' },
  } });
  await Promise.resolve();

  assert.deepEqual(structuredClone(harness.parentMessages), [{
    data: { type: 'PANEL_READY', provider: 'grok' },
    origin: EXTENSION_ORIGIN,
  }]);
  assert.deepEqual(oldDeliveries, []);
  assert.deepEqual(newDeliveries, [{ text: 'New' }]);
});

test('stale runtime retry attempts cannot announce an old registration', async () => {
  const harness = await createHarness({ frame: 'direct', runtimeAvailable: false });

  harness.bridge.register('claude', async () => {});
  harness.bridge.register('grok', async () => {});
  harness.enableRuntime();
  harness.timers[0].callback();
  harness.timers[1].callback();

  assert.deepEqual(structuredClone(harness.parentMessages), [{
    data: { type: 'PANEL_READY', provider: 'grok' },
    origin: EXTENSION_ORIGIN,
  }]);
});

test('a retained stale listener cannot deliver into a newer same-provider registration', async () => {
  const harness = await createHarness({ frame: 'direct' });
  const oldDeliveries = [];
  const newDeliveries = [];
  harness.bridge.register('claude', async (payload) => oldDeliveries.push(payload));
  const staleListener = harness.windowListeners.get('message')[0];
  harness.bridge.register('claude', async (payload) => newDeliveries.push(payload));

  staleListener({
    source: harness.parent,
    origin: EXTENSION_ORIGIN,
    data: {
      type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
      payloadId: 'stale', payload: { text: 'Stale' },
    },
  });
  deliver(harness, { data: {
    type: 'PAGE_MIND_DELIVER', provider: 'claude', windowId: 7,
    payloadId: 'current', payload: { text: 'Current' },
  } });
  await Promise.resolve();

  assert.deepEqual(oldDeliveries, []);
  assert.deepEqual(newDeliveries, [{ text: 'Current' }]);
});

test('handler failures are caught and logged once', async () => {
  const harness = await createHarness({ frame: 'direct' });
  harness.bridge.register('claude', async () => { throw new Error('handler failed'); });

  deliver(harness);
  await new Promise(setImmediate);

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0][0], /handler failed/i);
});

test('nested provider frames neither announce readiness nor accept delivery', async () => {
  const harness = await createHarness({ frame: 'nested' });

  harness.bridge.register('gemini', async () => {});

  assert.deepEqual(harness.parentMessages, []);
  assert.deepEqual(harness.runtimeMessages, []);
  assert.equal(harness.windowListeners.has('message'), false);
});

test('register validates its provider and handler', async () => {
  const harness = await createHarness({ frame: 'nested' });

  assert.throws(() => harness.bridge.register('', async () => {}), /nonempty string/);
  assert.throws(() => harness.bridge.register(42, async () => {}), /nonempty string/);
  assert.throws(() => harness.bridge.register('chatgpt'), /function/);
});

for (const provider of ['chatgpt', 'gemini', 'claude', 'grok']) {
  test(`${provider} actual injector completes panel delivery through the bridge`, async () => {
    const harness = await createProviderHarness(provider);

    assert.deepEqual(structuredClone(harness.parentMessages), [{
      data: { type: 'PANEL_READY', provider },
      origin: EXTENSION_ORIGIN,
    }]);

    harness.deliver();
    await settleEvents();

    const injectedText = provider === 'grok' ? harness.input.value : harness.input.textContent;
    assert.equal(injectedText, `Prompt for ${provider}`);
    const expectedInputEvents = {
      chatgpt: ['input', 'input'],
      gemini: ['input', 'input', 'keyup'],
      claude: ['input', 'input'],
      grok: ['input', 'change'],
    };
    assert.deepEqual(harness.input.events.map(({ type }) => type), expectedInputEvents[provider]);
    assert.deepEqual(structuredClone(harness.parentMessages.at(-1)), {
      data: {
        type: 'PAGE_MIND_DELIVERED', provider, windowId: 31,
        payloadId: `${provider}-payload`,
      },
      origin: EXTENSION_ORIGIN,
    });
    assert.equal(harness.parentMessages.filter(({ data }) => (
      data.type === 'PAGE_MIND_DELIVERED'
    )).length, 1);
  });
}

for (const [provider, delay] of [
  ['chatgpt', 700],
  ['gemini', 900],
  ['claude', 700],
  ['grok', 800],
]) {
  test(`${provider} actual injector preserves delayed auto-submit`, async () => {
    const harness = await createProviderHarness(provider);
    harness.deliver({ data: {
      type: 'PAGE_MIND_DELIVER', provider, windowId: 31,
      payloadId: `${provider}-submit`,
      payload: { provider, text: `Submit ${provider}`, autoSubmit: true },
    } });
    await Promise.resolve();

    assert.equal(harness.submit.clicks, 0);
    harness.runTimer(delay);
    await settleEvents();

    assert.equal(harness.submit.clicks, 1);
    assert.equal(harness.parentMessages.filter(({ data }) => (
      data.type === 'PAGE_MIND_DELIVERED'
    )).length, 1);
  });
}

for (const [provider, pollDelay] of [
  ['chatgpt', 300],
  ['gemini', 400],
  ['claude', 300],
]) {
  test(`${provider} actual injector waits for a delayed editor mount`, async () => {
    const harness = await createProviderHarness(provider, { inputAvailable: false });

    harness.deliver();
    await Promise.resolve();
    assert.equal(harness.parentMessages.length, 1);

    harness.installInput();
    harness.runTimer(pollDelay);
    await settleEvents();

    assert.equal(harness.input.textContent, `Prompt for ${provider}`);
    assert.equal(harness.parentMessages.filter(({ data }) => (
      data.type === 'PAGE_MIND_DELIVERED'
    )).length, 1);
  });
}

test('actual injector rejection is unacknowledged and the same payloadId retries', async () => {
  const harness = await createProviderHarness('chatgpt');

  harness.deliver({ data: {
    type: 'PAGE_MIND_DELIVER', provider: 'chatgpt', windowId: 31,
    payloadId: 'chatgpt-payload',
    payload: { provider: 'chatgpt', text: 42, autoSubmit: false },
  } });
  await settleEvents();
  assert.equal(harness.parentMessages.length, 1);

  harness.deliver();
  await settleEvents();

  assert.equal(harness.input.textContent, 'Prompt for chatgpt');
  assert.equal(harness.parentMessages.filter(({ data }) => (
    data.type === 'PAGE_MIND_DELIVERED'
  )).length, 1);
});

test('actual injector rejects malformed and untrusted panel deliveries', async () => {
  const harness = await createProviderHarness('gemini');
  const validData = {
    type: 'PAGE_MIND_DELIVER', provider: 'gemini', windowId: 31,
    payloadId: 'gemini-untrusted',
    payload: { provider: 'gemini', text: 'Do not inject', autoSubmit: false },
  };

  harness.deliver({ source: {}, data: validData });
  harness.deliver({ origin: 'https://evil.example', data: validData });
  harness.deliver({ data: { ...validData, payload: null } });
  await settleEvents();

  assert.equal(harness.input.textContent, '');
  assert.equal(harness.parentMessages.length, 1);
});

test('Grok uses an exact document-local request/result contract without window messages', async () => {
  const harness = await createProviderHarness('grok');

  harness.deliver();
  await settleEvents();

  const protocolEvents = harness.documentEvents.filter(({ type }) => type.startsWith('__PAGE_MIND_GROK_'));
  assert.equal(protocolEvents.length, 2);
  assert.equal(protocolEvents[0].type, '__PAGE_MIND_GROK_DELIVER__');
  assert.deepEqual(Object.keys(protocolEvents[0].detail).sort(), ['autoSubmit', 'requestId', 'text']);
  assert.equal(protocolEvents[0].detail.text, 'Prompt for grok');
  assert.equal(protocolEvents[1].type, '__PAGE_MIND_GROK_RESULT__');
  assert.deepEqual(Object.keys(protocolEvents[1].detail).sort(), ['ok', 'requestId']);
  assert.equal(protocolEvents[1].detail.requestId, protocolEvents[0].detail.requestId);
  assert.equal(protocolEvents[1].detail.ok, true);
  assert.equal(harness.timers.some(({ delay }) => delay === 30000), true);
  assert.deepEqual(harness.windowMessages, []);
});
