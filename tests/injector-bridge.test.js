import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const BRIDGE_URL = new URL('../injectors/bridge.js', import.meta.url);
const EXTENSION_ORIGIN = 'chrome-extension://pagemind';

async function createHarness(frame = 'top', responses = []) {
  const source = await readFile(BRIDGE_URL, 'utf8');
  const messages = [];
  const timers = [];
  const posted = [];
  const listeners = new Map();
  const errors = [];
  let lastErrorReads = 0;
  const top = {};
  const parent = frame === 'nested' ? {} : top;
  const window = frame === 'top' ? top : {};

  window.top = top;
  window.parent = frame === 'top' ? window : parent;
  window.addEventListener = (type, listener) => listeners.set(type, listener);
  parent.postMessage = (data, origin) => posted.push({ data, origin });

  const runtime = {
    getURL(path) {
      assert.equal(path, '');
      return `${EXTENSION_ORIGIN}/`;
    },
    sendMessage(message, callback) {
      messages.push(message);
      const response = responses.shift();
      if (typeof response === 'function') response(callback);
      else callback(response);
    },
  };
  Object.defineProperty(runtime, 'lastError', {
    get() {
      lastErrorReads += 1;
      return undefined;
    },
  });
  const context = {
    chrome: { runtime },
    console: { error: (...args) => errors.push(args) },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    window,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'injectors/bridge.js' });

  return {
    bridge: context.PageMindBridge,
    errors,
    get lastErrorReads() { return lastErrorReads; },
    listeners,
    messages,
    parent,
    posted,
    timers,
  };
}

test('top-level registration immediately requests its tab payload', async () => {
  const harness = await createHarness('top', [{ payload: { id: 'payload-1', text: 'Hello' } }]);
  const delivered = [];

  harness.bridge.register('chatgpt', async (payload) => delivered.push(payload));
  await Promise.resolve();

  assert.deepEqual(structuredClone(harness.messages), [{
    type: 'GET_PAYLOAD',
    provider: 'chatgpt',
    context: 'tab',
  }]);
  assert.equal(Object.hasOwn(harness.messages[0], 'windowId'), false);
  assert.deepEqual(delivered, [{ id: 'payload-1', text: 'Hello' }]);
  assert.equal(Object.isFrozen(harness.bridge), true);
});

test('a missing payload schedules a 500ms retry that requests again', async () => {
  const harness = await createHarness('top', [undefined, { payload: { id: 'payload-2' } }]);

  harness.bridge.register('gemini', async () => {});
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 500);

  harness.timers[0].callback();
  assert.equal(harness.messages.length, 2);
  assert.equal(harness.lastErrorReads, 2);
});

test('default and Side Panel retries stop at their configured limits', async () => {
  const topHarness = await createHarness('top');
  topHarness.bridge.register('chatgpt', async () => {});
  for (let index = 0; index < topHarness.timers.length; index += 1) {
    topHarness.timers[index].callback();
  }
  assert.equal(topHarness.messages.length, 121);
  assert.equal(topHarness.timers.length, 120);

  const panelHarness = await createHarness('direct');
  panelHarness.bridge.register('chatgpt', async () => {});
  panelHarness.listeners.get('message')({
    source: panelHarness.parent,
    origin: EXTENSION_ORIGIN,
    data: { type: 'PAGEMIND_DELIVER', provider: 'chatgpt', windowId: 3 },
  });
  for (let index = 0; index < panelHarness.timers.length; index += 1) {
    panelHarness.timers[index].callback();
  }
  assert.equal(panelHarness.messages.length, 21);
  assert.equal(panelHarness.timers.length, 20);
});

test('direct Side Panel child announces readiness without requesting a payload', async () => {
  const harness = await createHarness('direct');

  harness.bridge.register('claude', async () => {});

  assert.deepEqual(structuredClone(harness.posted), [{
    data: { type: 'PAGEMIND_PROVIDER_READY', provider: 'claude' },
    origin: EXTENSION_ORIGIN,
  }]);
  assert.deepEqual(harness.messages, []);
});

test('trusted Side Panel delivery requests the window payload', async () => {
  const payload = { id: 'payload-3', text: 'Explain this' };
  const harness = await createHarness('direct', [{ payload }]);
  const delivered = [];
  harness.bridge.register('grok', async (value) => delivered.push(value));

  harness.listeners.get('message')({
    source: harness.parent,
    origin: EXTENSION_ORIGIN,
    data: { type: 'PAGEMIND_DELIVER', provider: 'grok', windowId: 17 },
  });
  await Promise.resolve();

  assert.deepEqual(structuredClone(harness.messages), [{
    type: 'GET_PAYLOAD',
    provider: 'grok',
    context: 'sidepanel',
    windowId: 17,
  }]);
  assert.deepEqual(delivered, [payload]);
});

test('untrusted or malformed Side Panel messages are ignored', async () => {
  const harness = await createHarness('direct');
  harness.bridge.register('chatgpt', async () => {});
  const valid = {
    source: harness.parent,
    origin: EXTENSION_ORIGIN,
    data: { type: 'PAGEMIND_DELIVER', provider: 'chatgpt', windowId: 4 },
  };
  const invalidEvents = [
    { ...valid, source: {} },
    { ...valid, origin: 'https://evil.example' },
    { ...valid, data: { ...valid.data, provider: 'claude' } },
    { ...valid, data: { ...valid.data, windowId: undefined } },
    { ...valid, data: { ...valid.data, windowId: 4.5 } },
    { ...valid, data: { ...valid.data, type: 'OTHER' } },
  ];

  for (const event of invalidEvents) harness.listeners.get('message')(event);

  assert.deepEqual(harness.messages, []);
});

test('nested provider frames neither announce readiness nor request payloads', async () => {
  const harness = await createHarness('nested');

  harness.bridge.register('gemini', async () => {});

  assert.deepEqual(harness.posted, []);
  assert.deepEqual(harness.messages, []);
  assert.equal(harness.listeners.has('message'), false);
});

test('the same payload ID is handled only once across repeated deliveries', async () => {
  const payload = { id: 'one-shot', text: 'Only once' };
  const harness = await createHarness('direct', [{ payload }, { payload }]);
  let deliveries = 0;
  harness.bridge.register('claude', async () => { deliveries += 1; });
  const event = {
    source: harness.parent,
    origin: EXTENSION_ORIGIN,
    data: { type: 'PAGEMIND_DELIVER', provider: 'claude', windowId: 9 },
  };

  harness.listeners.get('message')(event);
  harness.listeners.get('message')(event);
  await Promise.resolve();

  assert.equal(harness.messages.length, 2);
  assert.equal(deliveries, 1);
});

test('register validates its provider and handler', async () => {
  const harness = await createHarness('nested');

  assert.throws(() => harness.bridge.register('', async () => {}), /nonempty string/);
  assert.throws(() => harness.bridge.register(42, async () => {}), /nonempty string/);
  assert.throws(() => harness.bridge.register('chatgpt'), /function/);
});

test('late responses from an old registration do not reach a new handler', async () => {
  let respondToOldRequest;
  const newPayload = { id: 'new-payload' };
  const harness = await createHarness('top', [
    (callback) => { respondToOldRequest = callback; },
    { payload: newPayload },
  ]);
  const oldDeliveries = [];
  const newDeliveries = [];

  harness.bridge.register('chatgpt', async (payload) => oldDeliveries.push(payload));
  harness.bridge.register('claude', async (payload) => newDeliveries.push(payload));
  respondToOldRequest({ payload: { id: 'old-payload' } });
  await Promise.resolve();

  assert.deepEqual(oldDeliveries, []);
  assert.deepEqual(newDeliveries, [newPayload]);
});

test('handler failures are logged once and the payload remains deduplicated', async () => {
  const payload = { id: 'failed-once' };
  const harness = await createHarness('direct', [{ payload }, { payload }]);
  harness.bridge.register('grok', async () => { throw new Error('handler failed'); });
  const event = {
    source: harness.parent,
    origin: EXTENSION_ORIGIN,
    data: { type: 'PAGEMIND_DELIVER', provider: 'grok', windowId: 8 },
  };

  harness.listeners.get('message')(event);
  await Promise.resolve();
  await Promise.resolve();
  harness.listeners.get('message')(event);
  await Promise.resolve();

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0][0], /handler failed/i);
});
