import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const BRIDGE_URL = new URL('../injectors/bridge.js', import.meta.url);
const EXTENSION_ORIGIN = 'chrome-extension://pagemind';

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
  const payload = { text: 'Summarize this' };
  const harness = await createHarness({ responses: [{ payloadId: 'tab-1', payload }] });
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
  const payload = { text: 'Valid' };
  const harness = await createHarness({ responses: [
    { payloadId: 42, payload: {} },
    { payloadId: 'bad-payload', payload: null },
    { payloadId: 'tab-valid', payload },
  ] });
  const delivered = [];

  harness.bridge.register('gemini', async (value) => delivered.push(value));
  assert.equal(harness.timers[0].delay, 400);
  harness.timers[0].callback();
  assert.equal(harness.timers[1].delay, 400);
  harness.timers[1].callback();
  await Promise.resolve();

  assert.deepEqual(delivered, [payload]);
  assert.equal(harness.runtimeMessages.length, 3);
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
  await Promise.resolve();

  assert.deepEqual(delivered, [payload]);
  assert.deepEqual(harness.runtimeMessages, []);
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
