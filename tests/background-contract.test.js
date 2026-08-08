import assert from 'node:assert/strict';
import test from 'node:test';

import { createPendingPayload } from '../lib/payload-routing.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    async emit(...args) {
      return Promise.all(listeners.map((listener) => listener(...args)));
    },
    get listener() {
      assert.equal(listeners.length, 1);
      return listeners[0];
    },
  };
}

function pick(source, keys) {
  if (keys == null) return { ...source };
  if (typeof keys === 'string') return { [keys]: source[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, source[key]]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
    key,
    source[key] === undefined ? fallback : source[key],
  ]));
}

function createChrome({
  sync = {},
  session = {},
  activeTab = { id: 41, windowId: 7, url: 'https://source.example/article', title: 'Source' },
  dynamicRules = [],
  registeredScripts = [],
  window = { id: 7, left: 0, top: 0, width: 1400, height: 900 },
  deferFirstSyncGet = false,
  enforceUserActivation = false,
  asyncSyncCallbacks = false,
} = {}) {
  const calls = [];
  const syncData = { ...sync };
  const sessionData = { ...session };
  const events = {
    actionClicked: createEvent(),
    contextClicked: createEvent(),
    installed: createEvent(),
    message: createEvent(),
    storageChanged: createEvent(),
    windowRemoved: createEvent(),
  };
  let nextTabId = 800;
  let nextWindowId = 80;
  let syncGetCount = 0;
  let releaseFirstSyncGet;
  let userActivation = false;
  let openPanelOnActionClick = false;
  let currentActiveTab = activeTab;
  const knownTabs = new Map([[activeTab.id, activeTab]]);

  function storageArea(name, data) {
    return {
      get(keys, callback) {
        calls.push({ type: `${name}.get`, keys });
        const result = pick(data, keys);
        if (name === 'sync' && deferFirstSyncGet && syncGetCount++ === 0) {
          return new Promise((resolve) => {
            releaseFirstSyncGet = () => resolve(result);
          });
        }
        if (callback) {
          const callbackActivation = userActivation;
          const invokeCallback = () => {
            const previousActivation = userActivation;
            userActivation = callbackActivation;
            try {
              callback(result);
            } finally {
              userActivation = previousActivation;
            }
          };
          if (name === 'sync' && asyncSyncCallbacks) queueMicrotask(invokeCallback);
          else invokeCallback();
          return undefined;
        }
        return Promise.resolve(result);
      },
      set(values, callback) {
        calls.push({ type: `${name}.set`, values });
        Object.assign(data, values);
        callback?.();
        return Promise.resolve();
      },
      remove(keys, callback) {
        const list = Array.isArray(keys) ? keys : [keys];
        calls.push({ type: `${name}.remove`, keys: list });
        for (const key of list) delete data[key];
        callback?.();
        return Promise.resolve();
      },
    };
  }

  const chrome = {
    action: {
      onClicked: events.actionClicked,
      async setPopup(value) {
        calls.push({ type: 'action.setPopup', value });
      },
    },
    contextMenus: {
      onClicked: events.contextClicked,
      async removeAll() {
        calls.push({ type: 'contextMenus.removeAll' });
      },
      create(value) {
        calls.push({ type: 'contextMenus.create', value });
      },
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        calls.push({ type: 'dnr.getDynamicRules' });
        return dynamicRules;
      },
      async updateDynamicRules(value) {
        calls.push({ type: 'dnr.updateDynamicRules', value });
      },
    },
    offscreen: {
      async createDocument(value) {
        calls.push({ type: 'offscreen.createDocument', value });
      },
    },
    runtime: {
      id: 'abcdefghijklmnop',
      lastError: undefined,
      onInstalled: events.installed,
      onMessage: events.message,
      async getContexts() {
        return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      },
      getURL(path) {
        return `chrome-extension://abcdefghijklmnop/${path}`;
      },
      openOptionsPage() {
        calls.push({ type: 'runtime.openOptionsPage' });
        return Promise.resolve();
      },
      sendMessage(message, callback) {
        calls.push({ type: 'runtime.sendMessage', message });
        if (callback) {
          callback({ success: true });
          return undefined;
        }
        return Promise.resolve({ success: true });
      },
    },
    scripting: {
      async executeScript(value) {
        calls.push({ type: 'scripting.executeScript', value });
        return [{ result: '' }];
      },
      async getRegisteredContentScripts(value) {
        calls.push({ type: 'scripting.getRegisteredContentScripts', value });
        return registeredScripts;
      },
      async registerContentScripts(value) {
        calls.push({ type: 'scripting.registerContentScripts', value });
      },
      async unregisterContentScripts(value) {
        calls.push({ type: 'scripting.unregisterContentScripts', value });
      },
    },
    sidePanel: {
      async open(value) {
        if (enforceUserActivation && !userActivation) {
          throw new Error('sidePanel.open requires user activation');
        }
        calls.push({ type: 'sidePanel.open', value });
      },
      async setPanelBehavior(value) {
        openPanelOnActionClick = value.openPanelOnActionClick;
        calls.push({ type: 'sidePanel.setPanelBehavior', value });
      },
    },
    storage: {
      onChanged: events.storageChanged,
      session: storageArea('session', sessionData),
      sync: storageArea('sync', syncData),
    },
    tabs: {
      async create(value) {
        calls.push({ type: 'tabs.create', value });
        const tab = { id: nextTabId++, windowId: nextWindowId, ...value };
        knownTabs.set(tab.id, tab);
        return tab;
      },
      async get(tabId) {
        calls.push({ type: 'tabs.get', tabId });
        const tab = knownTabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return tab;
      },
      async query(value) {
        calls.push({ type: 'tabs.query', value });
        if (value.active) return [currentActiveTab];
        return [{ id: nextTabId - 1, windowId: value.windowId, url: syncData.customUrls?.chatgpt }];
      },
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      onRemoved: events.windowRemoved,
      async create(value) {
        calls.push({ type: 'windows.create', value });
        return { id: nextWindowId++, tabs: [{ id: nextTabId++, windowId: nextWindowId - 1, url: value.url }] };
      },
      async get(id) {
        calls.push({ type: 'windows.get', id });
        if (window instanceof Error) throw window;
        return { ...window, id };
      },
      async getCurrent(value) {
        calls.push({ type: 'windows.getCurrent', value });
        if (window instanceof Error) throw window;
        return window;
      },
      async remove(id) {
        calls.push({ type: 'windows.remove', id });
      },
      async update(id, value) {
        calls.push({ type: 'windows.update', id, value });
        return { ...window, id, ...value };
      },
    },
  };

  return {
    calls,
    chrome,
    events,
    sessionData,
    syncData,
    clickAction(tab) {
      if (openPanelOnActionClick) {
        calls.push({ type: 'sidePanel.autoOpen', value: { windowId: tab.windowId } });
        return false;
      }
      this.withUserActivation(() => events.actionClicked.listener(tab));
      return true;
    },
    releaseFirstSyncGet() {
      assert.equal(typeof releaseFirstSyncGet, 'function');
      releaseFirstSyncGet();
    },
    setActiveTab(tab) {
      currentActiveTab = tab;
      knownTabs.set(tab.id, tab);
    },
    withUserActivation(callback) {
      userActivation = true;
      try {
        return callback();
      } finally {
        userActivation = false;
      }
    },
  };
}

let moduleSequence = 0;
async function loadBackground(harness) {
  globalThis.chrome = harness.chrome;
  await import(`../background.js?background-contract=${moduleSequence++}`);
  await tick();
  await tick();
}

function callOf(harness, type) {
  return harness.calls.filter((call) => call.type === type);
}

function routedPayloads(harness) {
  const payloads = Object.values(harness.sessionData.pendingPayloads || {});
  const legacy = harness.sessionData.pendingPayload;
  if (legacy && !payloads.some((payload) => payload.id === legacy.id)) payloads.push(legacy);
  return payloads;
}

function routedPayload(harness, kind, id) {
  return routedPayloads(harness).find((payload) => (
    payload.target?.kind === kind
      && payload.target[kind === 'tab' ? 'tabId' : 'windowId'] === id
  ));
}

function installMutableEmbeddingMocks(harness) {
  let rules = [];
  let scripts = [];
  harness.chrome.declarativeNetRequest.getDynamicRules = async () => rules.map((rule) => ({ ...rule }));
  harness.chrome.declarativeNetRequest.updateDynamicRules = async ({ removeRuleIds, addRules }) => {
    rules = rules
      .filter((rule) => !removeRuleIds.includes(rule.id))
      .concat(addRules.map((rule) => structuredClone(rule)));
  };
  harness.chrome.scripting.getRegisteredContentScripts = async ({ ids }) => (
    scripts.filter((script) => ids.includes(script.id)).map((script) => structuredClone(script))
  );
  harness.chrome.scripting.unregisterContentScripts = async ({ ids }) => {
    scripts = scripts.filter((script) => !ids.includes(script.id));
  };
  harness.chrome.scripting.registerContentScripts = async (registrations) => {
    scripts.push(...registrations.map((script) => structuredClone(script)));
  };
  return {
    get hosts() {
      return rules.map((rule) => rule.condition.requestDomains[0]);
    },
    get matches() {
      return scripts.map((script) => script.matches);
    },
  };
}

async function sendRuntimeMessage(harness, message, sender = {}) {
  globalThis.chrome = harness.chrome;
  return new Promise((resolve, reject) => {
    const keepAlive = harness.events.message.listener(message, sender, resolve);
    if (keepAlive !== true) reject(new Error(`Message ${message.type} did not keep its channel open`));
  });
}

test('toolbar panel behavior suppresses clicks only for the dedicated side-panel action', async () => {
  const harness = createChrome({ sync: { quickSummarize: true, openMode: 'sidepanel' } });
  await loadBackground(harness);

  assert.deepEqual(callOf(harness, 'action.setPopup').at(-1).value, { popup: '' });
  assert.deepEqual(callOf(harness, 'sidePanel.setPanelBehavior').at(-1).value, {
    openPanelOnActionClick: false,
  });
  assert.equal(harness.syncData.toolbarAction, 'summarize');

  harness.syncData.toolbarAction = 'sidepanel';
  await harness.events.storageChanged.emit({ toolbarAction: { newValue: 'sidepanel' } }, 'sync');
  await tick();
  assert.deepEqual(callOf(harness, 'sidePanel.setPanelBehavior').at(-1).value, {
    openPanelOnActionClick: true,
  });

  harness.syncData.toolbarAction = 'summarize';
  harness.syncData.openMode = 'companion';
  await harness.events.storageChanged.emit({
    toolbarAction: { newValue: 'summarize' },
    openMode: { newValue: 'companion' },
  }, 'sync');
  await tick();
  assert.deepEqual(callOf(harness, 'sidePanel.setPanelBehavior').at(-1).value, {
    openPanelOnActionClick: false,
  });

  harness.syncData.openMode = 'sidepanel';
  await harness.events.storageChanged.emit({ openMode: { newValue: 'sidepanel' } }, 'sync');
  await tick();
  assert.deepEqual(callOf(harness, 'sidePanel.setPanelBehavior').at(-1).value, {
    openPanelOnActionClick: false,
  });
});

test('embedding synchronization replaces only managed rules and only registered PageMind custom scripts', async () => {
  const harness = createChrome({
    sync: { customUrls: { chatgpt: 'https://custom.example.com/chat' } },
    dynamicRules: [{ id: 3 }, { id: 1000 }, { id: 1999 }, { id: 2000 }],
    registeredScripts: [{ id: 'pagemind-custom-chatgpt-isolated' }],
  });
  await loadBackground(harness);

  const update = callOf(harness, 'dnr.updateDynamicRules').at(-1).value;
  assert.deepEqual(update.removeRuleIds, [1000, 1999]);
  assert.ok(update.addRules.some((rule) => rule.condition.requestDomains.includes('custom.example.com')));
  assert.deepEqual(callOf(harness, 'scripting.unregisterContentScripts').at(-1).value, {
    ids: ['pagemind-custom-chatgpt-isolated'],
  });
  assert.deepEqual(callOf(harness, 'scripting.registerContentScripts').at(-1).value, [{
    id: 'pagemind-custom-chatgpt-isolated',
    matches: ['https://custom.example.com/*'],
    js: ['injectors/bridge.js', 'injectors/chatgpt.js'],
    allFrames: true,
    runAt: 'document_idle',
    persistAcrossSessions: true,
    world: 'ISOLATED',
  }]);

  harness.calls.length = 0;
  harness.chrome.scripting.getRegisteredContentScripts = async () => [];
  await harness.events.storageChanged.emit({ customUrls: { newValue: {} } }, 'sync');
  await tick();
  assert.equal(callOf(harness, 'scripting.unregisterContentScripts').length, 0);
  assert.equal(callOf(harness, 'scripting.registerContentScripts').length, 0);
});

test('overlapping embedding refreshes serialize and converge on the latest custom URLs', async () => {
  const harness = createChrome();
  await loadBackground(harness);

  let rules = [];
  let scripts = [];
  let updateCount = 0;
  let releaseFirstUpdate;
  let markFirstUpdateStarted;
  const firstUpdateStarted = new Promise((resolve) => {
    markFirstUpdateStarted = resolve;
  });
  harness.chrome.declarativeNetRequest.getDynamicRules = async () => rules.map((rule) => ({ ...rule }));
  harness.chrome.declarativeNetRequest.updateDynamicRules = async ({ removeRuleIds, addRules }) => {
    updateCount += 1;
    if (updateCount === 1) {
      markFirstUpdateStarted();
      await new Promise((resolve) => {
        releaseFirstUpdate = resolve;
      });
    }
    rules = rules
      .filter((rule) => !removeRuleIds.includes(rule.id))
      .concat(addRules.map((rule) => structuredClone(rule)));
  };
  harness.chrome.scripting.getRegisteredContentScripts = async ({ ids }) => (
    scripts.filter((script) => ids.includes(script.id)).map((script) => structuredClone(script))
  );
  harness.chrome.scripting.unregisterContentScripts = async ({ ids }) => {
    scripts = scripts.filter((script) => !ids.includes(script.id));
  };
  harness.chrome.scripting.registerContentScripts = async (registrations) => {
    scripts.push(...registrations.map((script) => structuredClone(script)));
  };

  const older = { chatgpt: 'https://older.example.com/chat' };
  const latest = { chatgpt: 'https://latest.example.com/chat' };
  await harness.events.storageChanged.emit({ customUrls: { newValue: older } }, 'sync');
  await firstUpdateStarted;
  await harness.events.storageChanged.emit({ customUrls: { newValue: latest } }, 'sync');
  await tick();
  releaseFirstUpdate();
  for (let index = 0; index < 8; index += 1) await tick();

  const hosts = rules.map((rule) => rule.condition.requestDomains[0]);
  assert.equal(updateCount, 2);
  assert.equal(hosts.includes('latest.example.com'), true);
  assert.equal(hosts.includes('older.example.com'), false);
  assert.deepEqual(scripts.map((script) => script.matches), [['https://latest.example.com/*']]);
});

test('a failed stale embedding refresh still applies a newer coalesced request', async () => {
  const harness = createChrome();
  await loadBackground(harness);
  const state = installMutableEmbeddingMocks(harness);
  const applyUpdate = harness.chrome.declarativeNetRequest.updateDynamicRules;
  let updateCount = 0;
  let releaseFailedUpdate;
  let markFailedUpdateStarted;
  const failedUpdateStarted = new Promise((resolve) => {
    markFailedUpdateStarted = resolve;
  });
  harness.chrome.declarativeNetRequest.updateDynamicRules = async (update) => {
    updateCount += 1;
    if (updateCount === 1) {
      markFailedUpdateStarted();
      await new Promise((resolve) => {
        releaseFailedUpdate = resolve;
      });
      throw new Error('simulated stale DNR failure');
    }
    await applyUpdate(update);
  };

  const older = { chatgpt: 'https://failed-older.example.com/chat' };
  const latest = { chatgpt: 'https://after-failure.example.com/chat' };
  await harness.events.storageChanged.emit({ customUrls: { newValue: older } }, 'sync');
  await failedUpdateStarted;
  await harness.events.storageChanged.emit({ customUrls: { newValue: latest } }, 'sync');
  releaseFailedUpdate();
  for (let index = 0; index < 10; index += 1) await tick();

  assert.equal(updateCount, 2);
  assert.equal(state.hosts.includes('after-failure.example.com'), true);
  assert.equal(state.hosts.includes('failed-older.example.com'), false);
  assert.deepEqual(state.matches, [['https://after-failure.example.com/*']]);
});

test('stale startup and install reads cannot overwrite a newer custom-URL change', async () => {
  for (const source of ['startup', 'installed']) {
    const older = { chatgpt: `https://older-${source}.example.com/chat` };
    const latest = { chatgpt: `https://latest-${source}.example.com/chat` };
    const harness = createChrome({
      sync: { customUrls: older },
      deferFirstSyncGet: source === 'startup',
    });
    const state = installMutableEmbeddingMocks(harness);
    await loadBackground(harness);

    let releaseStaleRead;
    let staleReadStarted = Promise.resolve();
    if (source === 'installed') {
      const originalGet = harness.chrome.storage.sync.get.bind(harness.chrome.storage.sync);
      let markStaleReadStarted;
      staleReadStarted = new Promise((resolve) => {
        markStaleReadStarted = resolve;
      });
      harness.chrome.storage.sync.get = (keys, callback) => {
        if (Array.isArray(keys) && keys.includes('customUrls') && !callback) {
          const snapshot = pick(harness.syncData, keys);
          markStaleReadStarted();
          return new Promise((resolve) => {
            releaseStaleRead = () => resolve(snapshot);
          });
        }
        return originalGet(keys, callback);
      };
      await harness.events.installed.emit();
    }

    await staleReadStarted;
    harness.syncData.customUrls = latest;
    await harness.events.storageChanged.emit({ customUrls: { newValue: latest } }, 'sync');
    for (let index = 0; index < 4; index += 1) await tick();
    if (source === 'startup') harness.releaseFirstSyncGet();
    else releaseStaleRead();
    for (let index = 0; index < 8; index += 1) await tick();

    assert.equal(state.hosts.includes(`latest-${source}.example.com`), true);
    assert.equal(state.hosts.includes(`older-${source}.example.com`), false);
    assert.deepEqual(state.matches, [[`https://latest-${source}.example.com/*`]]);
  }
});

test('context menus install idempotently, encode destination, and track open-mode changes', async () => {
  const harness = createChrome({ sync: { openMode: 'companion' } });
  await loadBackground(harness);

  await harness.events.installed.emit();
  await tick();
  await harness.events.installed.emit();
  await tick();

  assert.equal(callOf(harness, 'contextMenus.removeAll').length, 2);
  const ids = callOf(harness, 'contextMenus.create').slice(-3).map((call) => call.value.id);
  assert.deepEqual(ids, ['summarize-page-companion', 'open-side-panel', 'open-settings']);

  harness.syncData.openMode = 'sidepanel';
  await harness.events.storageChanged.emit({ openMode: { newValue: 'sidepanel' } }, 'sync');
  await tick();
  const updatedIds = callOf(harness, 'contextMenus.create').slice(-3).map((call) => call.value.id);
  assert.deepEqual(updatedIds, ['summarize-page-sidepanel', 'open-side-panel', 'open-settings']);

  globalThis.chrome = harness.chrome;
  await harness.events.contextClicked.listener({ menuItemId: 'open-side-panel' }, { id: 55, windowId: 19 });
  assert.deepEqual(callOf(harness, 'sidePanel.open').at(-1).value, { windowId: 19 });
  await harness.events.contextClicked.listener({ menuItemId: 'open-settings' }, { id: 55, windowId: 19 });
  assert.equal(callOf(harness, 'runtime.openOptionsPage').length, 1);
});

test('cold context-menu summarization opens the panel synchronously before activation expires', async () => {
  const harness = createChrome({
    enforceUserActivation: true,
    sync: {
      openMode: 'sidepanel', defaultProvider: 'claude', defaultPromptIndex: 0,
      includeUrl: false,
    },
    activeTab: { id: 56, windowId: 20, url: 'https://source.example/', title: 'Context source' },
  });
  await loadBackground(harness);
  harness.setActiveTab({
    id: 57, windowId: 20, url: 'https://switched.example/', title: 'Switched context tab',
  });
  harness.calls.length = 0;

  globalThis.chrome = harness.chrome;
  harness.withUserActivation(() => harness.events.contextClicked.listener(
    { menuItemId: 'summarize-page-sidepanel', selectionText: 'Context selection' },
    { id: 56, windowId: 20 },
  ));
  await tick();
  await tick();
  await tick();

  assert.deepEqual(callOf(harness, 'sidePanel.open')[0].value, { windowId: 20 });
  assert.ok(
    harness.calls.findIndex((call) => call.type === 'sidePanel.open')
      < harness.calls.findIndex((call) => call.type === 'sync.get'),
  );
  const pending = routedPayload(harness, 'sidepanel', 20);
  assert.deepEqual(pending.target, { kind: 'sidepanel', windowId: 20 });
  assert.deepEqual(callOf(harness, 'tabs.get')[0], { type: 'tabs.get', tabId: 56 });
  assert.match(pending.text, /Context source/);
  assert.doesNotMatch(pending.text, /Switched context tab/);
  assert.match(pending.text, /Context selection/);
});

test('GET_PAYLOAD consumes only an exact provider/context/tab match and preserves nonmatches', async () => {
  const payload = createPendingPayload({
    id: 'payload-tab', text: 'Text', provider: 'claude', target: { kind: 'tab', tabId: 91 },
  });
  const harness = createChrome({ session: { pendingPayload: payload } });
  await loadBackground(harness);
  harness.calls.length = 0;

  const wrong = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'claude', context: 'tab' },
    { tab: { id: 92 }, frameId: 0 },
  );
  assert.deepEqual(wrong, { payload: null });
  assert.equal(routedPayload(harness, 'tab', 91), payload);
  assert.equal(harness.sessionData.pendingPayload, undefined);

  const right = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'claude', context: 'tab', windowId: 999 },
    { tab: { id: 91 }, frameId: 0 },
  );
  assert.deepEqual(right, { payload });
  assert.equal(routedPayloads(harness).length, 0);
  assert.equal(callOf(harness, 'session.remove').length, 1);
});

test('concurrent exact GET_PAYLOAD requests deliver a pending payload only once', async () => {
  const payload = createPendingPayload({
    id: 'payload-concurrent', text: 'Once', provider: 'claude',
    target: { kind: 'tab', tabId: 91 },
  });
  const harness = createChrome({ session: { pendingPayload: payload } });
  await loadBackground(harness);
  harness.calls.length = 0;

  const request = { type: 'GET_PAYLOAD', provider: 'claude', context: 'tab' };
  const sender = { tab: { id: 91 }, frameId: 0 };
  const responses = await Promise.all([
    sendRuntimeMessage(harness, request, sender),
    sendRuntimeMessage(harness, request, sender),
  ]);

  assert.equal(responses.filter((response) => response.payload === payload).length, 1);
  assert.equal(responses.filter((response) => response.payload === null).length, 1);
  assert.equal(callOf(harness, 'session.remove').length, 1);
});

test('GET_PAYLOAD does not remove or deliver a replacement written after its matched snapshot', async () => {
  const original = createPendingPayload({
    id: 'payload-original', text: 'Original', provider: 'claude',
    target: { kind: 'tab', tabId: 91 },
  });
  const replacement = createPendingPayload({
    id: 'payload-replacement', text: 'Replacement', provider: 'claude',
    target: { kind: 'tab', tabId: 91 },
  });
  const harness = createChrome({ session: { pendingPayload: original } });
  await loadBackground(harness);
  harness.calls.length = 0;

  const originalGet = harness.chrome.storage.session.get.bind(harness.chrome.storage.session);
  let firstRead = true;
  harness.chrome.storage.session.get = async (keys) => {
    if (firstRead) {
      firstRead = false;
      const snapshot = await originalGet(keys);
      harness.sessionData.pendingPayload = replacement;
      return snapshot;
    }
    return originalGet(keys);
  };

  const response = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'claude', context: 'tab' },
    { tab: { id: 91 }, frameId: 0 },
  );

  assert.deepEqual(response, { payload: null });
  assert.equal(routedPayload(harness, 'tab', 91), replacement);
  assert.equal(harness.sessionData.pendingPayload, undefined);
  assert.equal(callOf(harness, 'session.remove').length, 1);

  const replacementResponse = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'claude', context: 'tab' },
    { tab: { id: 91 }, frameId: 0 },
  );
  assert.deepEqual(replacementResponse, { payload: replacement });
  assert.equal(routedPayloads(harness).length, 0);
});

test('a nested provider frame cannot claim a payload targeted to its top-level tab', async () => {
  const payload = createPendingPayload({
    id: 'payload-top-frame', text: 'Top-level only', provider: 'claude',
    target: { kind: 'tab', tabId: 91 },
  });
  const harness = createChrome({ session: { pendingPayload: payload } });
  await loadBackground(harness);

  const response = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'claude', context: 'tab' },
    { tab: { id: 91 }, frameId: 3 },
  );

  assert.deepEqual(response, { payload: null });
  assert.equal(routedPayload(harness, 'tab', 91), payload);
});

test('PANEL_READY reveals a pending provider only to its exact integer side-panel window target', async () => {
  const payload = createPendingPayload({
    id: 'payload-panel', text: 'Text', provider: 'grok', target: { kind: 'sidepanel', windowId: 17 },
  });
  const harness = createChrome({ session: { pendingPayload: payload } });
  await loadBackground(harness);

  const sender = { url: 'chrome-extension://abcdefghijklmnop/sidepanel.html' };
  assert.deepEqual(await sendRuntimeMessage(
    harness,
    { type: 'PANEL_READY', windowId: 17 },
    { url: 'https://attacker.example/frame' },
  ), { provider: null });
  assert.deepEqual(await sendRuntimeMessage(
    harness,
    { type: 'PANEL_READY', windowId: 17 },
    { tab: { id: 91 }, url: 'chrome-extension://abcdefghijklmnop/sidepanel.html' },
  ), { provider: null });
  assert.equal(routedPayload(harness, 'sidepanel', 17), payload);
  assert.deepEqual(await sendRuntimeMessage(harness, { type: 'PANEL_READY', windowId: 18 }, sender), { provider: null });
  assert.deepEqual(await sendRuntimeMessage(harness, { type: 'PANEL_READY', windowId: '17' }, sender), { provider: null });
  assert.deepEqual(await sendRuntimeMessage(harness, { type: 'PANEL_READY', windowId: 17 }, sender), { provider: 'grok' });
  assert.equal(routedPayload(harness, 'sidepanel', 17), payload);
});

test('PANEL_READY expired cleanup preserves a newer replacement payload', async () => {
  const expired = createPendingPayload({
    id: 'payload-panel-expired', text: 'Expired', provider: 'grok',
    target: { kind: 'sidepanel', windowId: 17 }, createdAt: Date.now() - 60_001,
  });
  const replacement = createPendingPayload({
    id: 'payload-panel-new', text: 'New', provider: 'claude',
    target: { kind: 'sidepanel', windowId: 18 },
  });
  const harness = createChrome({ session: { pendingPayload: expired } });
  await loadBackground(harness);

  const originalGet = harness.chrome.storage.session.get.bind(harness.chrome.storage.session);
  let firstRead = true;
  harness.chrome.storage.session.get = async (keys) => {
    if (firstRead) {
      firstRead = false;
      const snapshot = await originalGet(keys);
      harness.sessionData.pendingPayload = replacement;
      return snapshot;
    }
    return originalGet(keys);
  };

  assert.deepEqual(await sendRuntimeMessage(harness, {
    type: 'PANEL_READY', windowId: 17,
  }, { url: 'chrome-extension://abcdefghijklmnop/sidepanel.html' }), { provider: null });
  assert.equal(routedPayload(harness, 'sidepanel', 18), replacement);
  assert.equal(harness.sessionData.pendingPayload, undefined);
  assert.equal(callOf(harness, 'session.remove').length, 1);
});

test('PANEL_READY does not reveal a provider from a replaced matching snapshot', async () => {
  const original = createPendingPayload({
    id: 'payload-panel-original', text: 'Original', provider: 'grok',
    target: { kind: 'sidepanel', windowId: 17 },
  });
  const replacement = createPendingPayload({
    id: 'payload-panel-current', text: 'Current', provider: 'claude',
    target: { kind: 'sidepanel', windowId: 18 },
  });
  const harness = createChrome({ session: { pendingPayload: original } });
  await loadBackground(harness);

  const originalGet = harness.chrome.storage.session.get.bind(harness.chrome.storage.session);
  let firstRead = true;
  harness.chrome.storage.session.get = async (keys) => {
    if (firstRead) {
      firstRead = false;
      const snapshot = await originalGet(keys);
      harness.sessionData.pendingPayload = replacement;
      return snapshot;
    }
    return originalGet(keys);
  };

  assert.deepEqual(await sendRuntimeMessage(harness, {
    type: 'PANEL_READY', windowId: 17,
  }, { url: 'chrome-extension://abcdefghijklmnop/sidepanel.html' }), { provider: null });
  assert.equal(routedPayload(harness, 'sidepanel', 18), replacement);
});

test('a provider tab cannot claim a side-panel payload by spoofing its context and window ID', async () => {
  const payload = createPendingPayload({
    id: 'payload-panel-secret', text: 'Private panel text', provider: 'claude',
    target: { kind: 'sidepanel', windowId: 17 },
  });
  const harness = createChrome({ session: { pendingPayload: payload } });
  await loadBackground(harness);

  const response = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'claude', context: 'sidepanel', windowId: 17 },
    { tab: { id: 91, windowId: 17 }, url: 'https://claude.ai/new' },
  );

  assert.deepEqual(response, { payload: null });
  assert.equal(routedPayload(harness, 'sidepanel', 17), payload);
});

test('the PageMind side-panel document can consume its exact window-targeted payload', async () => {
  const payload = createPendingPayload({
    id: 'payload-panel-valid', text: 'Panel text', provider: 'claude',
    target: { kind: 'sidepanel', windowId: 17 },
  });
  const harness = createChrome({ session: { pendingPayload: payload } });
  await loadBackground(harness);

  const response = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'claude', context: 'sidepanel', windowId: 17 },
    { url: 'chrome-extension://abcdefghijklmnop/sidepanel.html' },
  );

  assert.deepEqual(response, { payload });
  assert.equal(routedPayloads(harness).length, 0);
});

test('GET_PAYLOAD removes expired payloads without returning them', async () => {
  const payload = createPendingPayload({
    id: 'payload-expired', text: 'Old text', provider: 'grok',
    target: { kind: 'tab', tabId: 91 }, createdAt: Date.now() - 60_001,
  });
  const harness = createChrome({ session: { pendingPayload: payload } });
  await loadBackground(harness);

  const response = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'grok', context: 'tab' },
    { tab: { id: 91 }, frameId: 0 },
  );

  assert.deepEqual(response, { payload: null });
  assert.equal(routedPayloads(harness).length, 0);
});

test('payload route reads prune malformed entries while preserving valid unmatched routes', async () => {
  const valid = createPendingPayload({
    id: 'payload-valid', text: 'Keep me', provider: 'claude', target: { kind: 'tab', tabId: 92 },
  });
  const malformed = {
    id: 'payload-malformed', text: '', provider: 'grok',
    target: { kind: 'tab', tabId: 91 }, createdAt: Date.now(),
  };
  const harness = createChrome({
    session: { pendingPayloads: { 'tab:91': malformed, 'tab:92': valid } },
  });
  await loadBackground(harness);

  const response = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'grok', context: 'tab' },
    { tab: { id: 91 }, frameId: 0 },
  );

  assert.deepEqual(response, { payload: null });
  assert.deepEqual(routedPayloads(harness), [valid]);
});

test('new-tab summaries create the exact destination before storing a tab-targeted payload', async () => {
  const harness = createChrome({
    sync: {
      customPrompts: ['Please condense'], customUrls: { claude: 'https://custom.example.com/chat' },
      openMode: 'newtab', autoSubmit: false, includeUrl: true, maxContentChars: 5000,
    },
    activeTab: { id: 41, windowId: 12, url: 'https://source.example/article', title: 'Source' },
  });
  await loadBackground(harness);
  harness.setActiveTab({
    id: 42, windowId: 12, url: 'https://switched.example/article', title: 'Switched popup source',
  });
  harness.calls.length = 0;

  const response = await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'claude', promptIndex: 0, selectedText: 'Selected',
    sourceTabId: 41, sourceWindowId: 12, source: 'popup', destination: 'newtab',
  });

  assert.deepEqual(response, {
    success: true, destination: 'newtab', provider: 'claude', url: 'https://custom.example.com/chat',
  });
  assert.deepEqual(callOf(harness, 'tabs.get')[0], { type: 'tabs.get', tabId: 41 });
  const createdIndex = harness.calls.findIndex((call) => call.type === 'tabs.create');
  const storedIndex = harness.calls.findIndex((call) => call.type === 'session.set');
  assert.ok(createdIndex >= 0 && createdIndex < storedIndex);
  const pending = routedPayload(harness, 'tab', 800);
  assert.equal(pending.target.kind, 'tab');
  assert.equal(pending.target.tabId, callOf(harness, 'tabs.create')[0] && 800);
  assert.match(pending.id, /^[0-9a-f-]{20,}$/i);
  assert.match(pending.text, /Please condense/);
  assert.match(pending.text, /Selected/);
  assert.match(pending.text, /Source URL: https:\/\/source\.example\/article/);
  assert.match(pending.text, /Selected text from: Source/);
  assert.doesNotMatch(pending.text, /switched\.example|Switched popup source/i);
});

test('an exact source tab cannot be paired with a different source window', async () => {
  const harness = createChrome({
    activeTab: { id: 41, windowId: 12, url: 'https://source.example/', title: 'Source' },
  });
  await loadBackground(harness);

  const response = await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'chatgpt', promptIndex: 0, selectedText: 'Private',
    sourceTabId: 41, sourceWindowId: 99, destination: 'newtab',
  });

  assert.match(response.error, /does not belong to the source window/);
  assert.equal(routedPayloads(harness).length, 0);
  assert.equal(callOf(harness, 'tabs.create').length, 0);
});

test('summaries targeting two provider tabs coexist and consuming one preserves the other', async () => {
  const harness = createChrome({
    sync: { openMode: 'newtab', includeUrl: false },
    activeTab: { id: 101, windowId: 12, url: 'https://one.example/', title: 'One' },
  });
  await loadBackground(harness);
  harness.setActiveTab({ id: 102, windowId: 13, url: 'https://two.example/', title: 'Two' });

  await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'chatgpt', promptIndex: 0, selectedText: 'First',
    sourceTabId: 101, sourceWindowId: 12, destination: 'newtab',
  });
  await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'claude', promptIndex: 0, selectedText: 'Second',
    sourceTabId: 102, sourceWindowId: 13, destination: 'newtab',
  });

  assert.equal(routedPayloads(harness).length, 2);
  assert.equal(routedPayload(harness, 'tab', 800).provider, 'chatgpt');
  assert.equal(routedPayload(harness, 'tab', 801).provider, 'claude');

  const response = await sendRuntimeMessage(
    harness,
    { type: 'GET_PAYLOAD', provider: 'chatgpt', context: 'tab' },
    { tab: { id: 800 }, frameId: 0 },
  );
  assert.equal(response.payload.provider, 'chatgpt');
  assert.equal(routedPayloads(harness).length, 1);
  assert.equal(routedPayload(harness, 'tab', 801).provider, 'claude');
});

test('interleaved side-panel providers coexist by window and supersede only their own route', async () => {
  const harness = createChrome({
    sync: { openMode: 'sidepanel', includeUrl: false },
    activeTab: { id: 111, windowId: 21, url: 'https://one.example/', title: 'One' },
  });
  await loadBackground(harness);
  harness.setActiveTab({ id: 112, windowId: 22, url: 'https://two.example/', title: 'Two' });
  let releaseOldNavigation;
  let markOldNavigationStarted;
  const oldNavigationStarted = new Promise((resolve) => {
    markOldNavigationStarted = resolve;
  });
  harness.chrome.runtime.sendMessage = (message, callback) => {
    harness.calls.push({ type: 'runtime.sendMessage', message });
    if (message.type === 'PANEL_NAVIGATE' && message.provider === 'chatgpt') {
      markOldNavigationStarted();
      return new Promise((resolve) => {
        releaseOldNavigation = () => {
          callback?.({ success: true });
          resolve({ success: true });
        };
      });
    }
    callback?.({ success: true });
    return Promise.resolve({ success: true });
  };

  const olderWindowOne = sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'chatgpt', promptIndex: 0, selectedText: 'Window one old',
    sourceTabId: 111, sourceWindowId: 21, destination: 'sidepanel',
  });
  await oldNavigationStarted;
  await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'claude', promptIndex: 0, selectedText: 'Window two',
    sourceTabId: 112, sourceWindowId: 22, destination: 'sidepanel',
  });
  await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'grok', promptIndex: 0, selectedText: 'Window one new',
    sourceTabId: 111, sourceWindowId: 21, destination: 'sidepanel',
  });
  releaseOldNavigation();
  await olderWindowOne;

  assert.equal(routedPayloads(harness).length, 2);
  assert.equal(routedPayload(harness, 'sidepanel', 21).provider, 'grok');
  assert.match(routedPayload(harness, 'sidepanel', 21).text, /Window one new/);
  assert.equal(routedPayload(harness, 'sidepanel', 22).provider, 'claude');

  const panelSender = { url: 'chrome-extension://abcdefghijklmnop/sidepanel.html' };
  assert.deepEqual(await sendRuntimeMessage(harness, {
    type: 'PANEL_READY', windowId: 22,
  }, panelSender), { provider: 'claude' });
  assert.deepEqual(await sendRuntimeMessage(harness, {
    type: 'PANEL_READY', windowId: 21,
  }, panelSender), { provider: 'grok' });
});

test('side-panel sources override another requested destination and navigate only after targeted storage', async () => {
  const harness = createChrome({
    sync: { openMode: 'companion', autoSubmit: true, includeUrl: false },
    activeTab: { id: 51, windowId: 23, url: 'https://source.example/', title: 'Source' },
  });
  await loadBackground(harness);
  harness.calls.length = 0;

  const response = await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'chatgpt', promptIndex: 0, selectedText: 'Panel text',
    sourceWindowId: 23, source: 'sidepanel', destination: 'newtab',
  });

  assert.equal(response.destination, 'sidepanel');
  assert.deepEqual(routedPayload(harness, 'sidepanel', 23).target, { kind: 'sidepanel', windowId: 23 });
  assert.equal(callOf(harness, 'tabs.create').length, 0);
  const storedIndex = harness.calls.findIndex((call) => call.type === 'session.set');
  const navigateIndex = harness.calls.findIndex((call) => call.type === 'runtime.sendMessage'
    && call.message.type === 'PANEL_NAVIGATE');
  assert.ok(storedIndex >= 0 && storedIndex < navigateIndex);
  assert.deepEqual(harness.calls[navigateIndex].message, {
    type: 'PANEL_NAVIGATE', windowId: 23, provider: 'chatgpt', url: 'https://chatgpt.com/',
  });
});

test('companion fallback still stores against the exact provider tab it creates', async () => {
  const harness = createChrome({
    sync: { openMode: 'companion', includeUrl: false },
    window: new Error('window unavailable'),
    activeTab: { id: 61, windowId: 31, url: 'https://source.example/', title: 'Source' },
  });
  await loadBackground(harness);
  harness.calls.length = 0;

  const response = await sendRuntimeMessage(harness, {
    type: 'SUMMARIZE', provider: 'gemini', promptIndex: 0, selectedText: 'Fallback',
    sourceWindowId: 31, destination: 'companion',
  });

  assert.equal(response.destination, 'companion');
  assert.equal(callOf(harness, 'tabs.create').length, 1);
  assert.deepEqual(routedPayload(harness, 'tab', 800).target, { kind: 'tab', tabId: 800 });
});

test('dedicated side-panel action suppresses clicks while direct summarize dispatches and opens', async () => {
  const harness = createChrome({
    enforceUserActivation: true,
    sync: {
      toolbarAction: 'sidepanel', defaultProvider: 'chatgpt', defaultPromptIndex: 0,
      openMode: 'sidepanel', includeUrl: false,
    },
    activeTab: { id: 71, windowId: 44, url: 'https://source.example/', title: 'Source' },
  });
  await loadBackground(harness);
  harness.calls.length = 0;

  globalThis.chrome = harness.chrome;
  assert.equal(harness.clickAction({ id: 71, windowId: 44 }), false);
  assert.equal(callOf(harness, 'sidePanel.open').length, 0);
  assert.equal(callOf(harness, 'tabs.query').length, 0);

  harness.syncData.toolbarAction = 'summarize';
  await harness.events.storageChanged.emit({ toolbarAction: { newValue: 'summarize' } }, 'sync');
  await tick();
  assert.deepEqual(callOf(harness, 'sidePanel.setPanelBehavior').at(-1).value, {
    openPanelOnActionClick: false,
  });
  harness.calls.length = 0;
  harness.setActiveTab({
    id: 72, windowId: 44, url: 'https://switched.example/', title: 'Switched toolbar tab',
  });
  assert.equal(harness.clickAction({ id: 71, windowId: 44 }), true);
  assert.deepEqual(callOf(harness, 'sidePanel.open')[0].value, { windowId: 44 });
  await tick();
  await tick();
  assert.deepEqual(callOf(harness, 'tabs.get')[0], { type: 'tabs.get', tabId: 71 });
  const pending = routedPayload(harness, 'sidepanel', 44);
  assert.match(pending.text, /Source/);
  assert.doesNotMatch(pending.text, /Switched toolbar tab/);
  assert.deepEqual(pending.target, { kind: 'sidepanel', windowId: 44 });
});

test('a cold-worker Chrome storage callback preserves activation for direct side-panel summarize', async () => {
  const harness = createChrome({
    deferFirstSyncGet: true,
    enforceUserActivation: true,
    asyncSyncCallbacks: true,
    sync: {
      toolbarAction: 'summarize', defaultProvider: 'chatgpt', defaultPromptIndex: 0,
      openMode: 'sidepanel', includeUrl: false,
    },
    activeTab: { id: 72, windowId: 45, url: 'https://source.example/', title: 'Cold source' },
  });
  await loadBackground(harness);
  harness.calls.length = 0;

  globalThis.chrome = harness.chrome;
  assert.equal(harness.clickAction({ id: 72, windowId: 45 }), true);
  await tick();
  await tick();
  await tick();

  const gestureLookup = callOf(harness, 'sync.get')[0];
  assert.deepEqual(gestureLookup.keys, [
    'toolbarAction', 'quickSummarize', 'defaultProvider', 'defaultPromptIndex', 'openMode',
  ]);
  assert.deepEqual(callOf(harness, 'sidePanel.open')[0].value, { windowId: 45 });
  assert.deepEqual(routedPayload(harness, 'sidepanel', 45).target, { kind: 'sidepanel', windowId: 45 });
  harness.releaseFirstSyncGet();
});

function createElement(id) {
  const listeners = new Map();
  return {
    id,
    classList: { add() {}, toggle() {} },
    dataset: {},
    disabled: false,
    innerHTML: '',
    textContent: '',
    value: '0',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    appendChild() {},
    getListener(type) {
      return listeners.get(type);
    },
  };
}

test('popup caches its source window and opens a side panel before selection extraction', async () => {
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const elements = Object.fromEntries([
    'promptSelect', 'providerGrid', 'settingsBtn', 'summarizeBtn', 'statusMsg', 'clipboardHint',
  ].map((id) => [id, createElement(id)]));
  let domReady;
  const document = {
    addEventListener(type, listener) {
      if (type === 'DOMContentLoaded') domReady = listener;
    },
    createElement() {
      return createElement('option');
    },
    getElementById(id) {
      return elements[id];
    },
    querySelectorAll() {
      return [];
    },
  };
  const harness = createChrome({
    sync: { openMode: 'sidepanel', lastProvider: 'claude', lastPromptIndex: 0 },
    activeTab: { id: 81, windowId: 52, url: 'https://source.example/', title: 'Source' },
  });
  harness.chrome.scripting.executeScript = async (value) => {
    harness.calls.push({ type: 'scripting.executeScript', value });
    return [{ result: 'Popup selection' }];
  };
  harness.chrome.runtime.sendMessage = (message, callback) => {
    harness.calls.push({ type: 'runtime.sendMessage', message });
    callback?.({});
  };

  try {
    globalThis.chrome = harness.chrome;
    globalThis.document = document;
    globalThis.window = { close() {} };
    await import(`../popup.js?background-contract=${moduleSequence++}`);
    await domReady();
    harness.setActiveTab({
      id: 82, windowId: 53, url: 'https://switched.example/', title: 'Switched popup tab',
    });
    harness.calls.length = 0;

    await elements.summarizeBtn.getListener('click')();

    assert.equal(harness.calls[0].type, 'sidePanel.open');
    assert.deepEqual(harness.calls[0].value, { windowId: 52 });
    assert.equal(callOf(harness, 'scripting.executeScript')[0].value.target.tabId, 81);
    const message = callOf(harness, 'runtime.sendMessage').at(-1).message;
    assert.deepEqual(message, {
      type: 'SUMMARIZE', provider: 'claude', promptIndex: 0, selectedText: 'Popup selection',
      sourceTabId: 81, sourceWindowId: 52, destination: 'sidepanel',
    });

    harness.calls.length = 0;
    harness.chrome.scripting.executeScript = async (value) => {
      harness.calls.push({ type: 'scripting.executeScript', value });
      throw new Error('selection access denied');
    };
    await elements.summarizeBtn.getListener('click')();
    assert.deepEqual(callOf(harness, 'runtime.sendMessage').at(-1).message, {
      type: 'SUMMARIZE', provider: 'claude', promptIndex: 0, selectedText: '',
      sourceTabId: 81, sourceWindowId: 52, destination: 'sidepanel',
    });
  } finally {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});

test('popup initialization resolves with defaults after storage errors and corrupt prompt data', async () => {
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;

  try {
    for (const scenario of [
      { lastError: { message: 'storage unavailable' }, data: undefined },
      {
        lastError: undefined,
        data: {
          lastProvider: 'unknown-provider',
          customPrompts: [{ length: 100 }],
          openMode: 'invalid',
        },
      },
    ]) {
      const elements = Object.fromEntries([
        'promptSelect', 'providerGrid', 'settingsBtn', 'summarizeBtn', 'statusMsg', 'clipboardHint',
      ].map((id) => [id, createElement(id)]));
      let domReady;
      globalThis.document = {
        addEventListener(type, listener) {
          if (type === 'DOMContentLoaded') domReady = listener;
        },
        createElement() {
          return createElement('option');
        },
        getElementById(id) {
          return elements[id];
        },
        querySelectorAll() {
          return [];
        },
      };
      globalThis.window = { close() {} };
      const harness = createChrome();
      harness.chrome.runtime.sendMessage = (message, callback) => {
        harness.calls.push({ type: 'runtime.sendMessage', message });
        callback?.({});
      };
      harness.chrome.storage.sync.get = (_keys, callback) => {
        harness.chrome.runtime.lastError = scenario.lastError;
        try {
          callback(scenario.data);
        } finally {
          harness.chrome.runtime.lastError = undefined;
        }
      };
      globalThis.chrome = harness.chrome;
      await import(`../popup.js?background-contract=${moduleSequence++}`);

      await assert.doesNotReject(() => domReady());
      assert.equal(typeof elements.summarizeBtn.getListener('click'), 'function');
      assert.ok(elements.promptSelect.dataset.lastIndex !== undefined);
      await elements.summarizeBtn.getListener('click')();
      assert.equal(callOf(harness, 'runtime.sendMessage').at(-1).message.provider, 'chatgpt');
    }
  } finally {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});
