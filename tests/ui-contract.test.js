import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PROMPTS } from '../lib/providers.js';

const optionsHtml = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const optionsJs = await readFile(new URL('../options.js', import.meta.url), 'utf8');
const sidePanelHtml = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
const PROVIDERS = ['chatgpt', 'gemini', 'claude'];

test('side panel exposes an accessible provider host shell without hiding provider controls', () => {
  for (const id of [
    'panelControls', 'collapseBtn', 'reloadBtn', 'openTabBtn', 'providerFrame',
    'frameFallback', 'retryFrameBtn', 'fallbackNewTabBtn', 'providerGrid',
    'promptSelect', 'summarizeBtn', 'settingsBtn', 'statusMsg', 'pageTitle', 'pageUrl',
  ]) {
    assert.match(sidePanelHtml, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(sidePanelHtml, /id="collapseBtn"[^>]*aria-expanded="true"/);
  assert.match(sidePanelHtml, /id="statusMsg"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(sidePanelHtml, /id="frameFallback"[^>]*role="alert"/);
  assert.match(sidePanelHtml, /<iframe[^>]*id="providerFrame"[^>]*title="AI provider"/);
  assert.match(sidePanelHtml, /id="providerGrid"[^>]*role="group"[^>]*aria-label="AI provider"/);
  assert.doesNotMatch(sidePanelHtml, /id="panelControls"[^>]*hidden/);
});

function radioValues(name) {
  return [...optionsHtml.matchAll(new RegExp(`<input\\s+type="radio"\\s+name="${name}"\\s+value="([^"]+)"`, 'g'))]
    .map((match) => match[1]);
}

function checkedRadioCount(name) {
  return [...optionsHtml.matchAll(new RegExp(`<input\\s+type="radio"\\s+name="${name}"[^>]*`, 'g'))]
    .filter(([input]) => /\schecked(?:\s|>|$)/.test(input)).length;
}

class FakeClassList {
  #values = new Set();

  add(...values) { values.forEach((value) => this.#values.add(value)); }
  remove(...values) { values.forEach((value) => this.#values.delete(value)); }
  toggle(value, force) {
    const enabled = force ?? !this.#values.has(value);
    if (enabled) this.#values.add(value);
    else this.#values.delete(value);
    return enabled;
  }
  contains(value) { return this.#values.has(value); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.children = [];
    this.listeners = new Map();
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') this.children = [];
  }

  get innerHTML() { return this._innerHTML ?? ''; }
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
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.elements = new Map();
    for (const id of [
      'addPromptBtn', 'newPromptInput', 'providerGrid', 'autoSubmitToggle', 'includeUrlToggle',
      'maxCharsInput', 'defaultPromptSelect', 'promptList', 'saveFeedback',
      ...PROVIDERS.map((provider) => `url-${provider}`),
    ]) this.elements.set(id, new FakeElement(id));

    this.elements.get('autoSubmitToggle').checked = true;
    this.elements.get('includeUrlToggle').checked = true;
    this.elements.get('maxCharsInput').value = '12000';
    this.radios = {
      openMode: ['sidepanel', 'companion', 'newtab'].map((value) => this.radio('openMode', value)),
      toolbarAction: ['popup', 'summarize', 'sidepanel'].map((value) => this.radio('toolbarAction', value)),
    };
    this.radios.openMode[1].checked = true;
    this.radios.toolbarAction[0].checked = true;
    this.providerButtons = PROVIDERS.map((provider) => {
      const button = new FakeElement();
      button.dataset.provider = provider;
      button.classList.add('provider-btn');
      return button;
    });
  }

  radio(name, value) {
    const radio = new FakeElement();
    radio.name = name;
    radio.value = value;
    return radio;
  }

  getElementById(id) { return this.elements.get(id); }
  createElement() { return new FakeElement(); }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async fire(type) {
    for (const listener of this.listeners.get(type) ?? []) await listener();
  }
  querySelectorAll(selector) {
    if (selector === '.provider-btn') return this.providerButtons;
    if (selector === 'input[name="openMode"], input[name="toolbarAction"]') {
      return [...this.radios.openMode, ...this.radios.toolbarAction];
    }
    const match = selector.match(/^input\[name="(openMode|toolbarAction)"\]$/);
    return match ? this.radios[match[1]] : [];
  }
  querySelector(selector) {
    const exact = selector.match(/^input\[name="(openMode|toolbarAction)"\]\[value="(.+)"\]$/);
    if (exact) return this.radios[exact[1]].find((radio) => radio.value === exact[2]) ?? null;
    const selected = selector.match(/^input\[name="(openMode|toolbarAction)"\]:checked$/);
    if (selected) return this.radios[selected[1]].find((radio) => radio.checked) ?? null;
    return null;
  }
}

class FakeWindow {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  async dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) await listener();
  }
}

function waitForSave() {
  return new Promise((resolve) => setTimeout(resolve, 325));
}

let moduleId = 0;
async function bootOptions({ settings = {}, delayedGet = false, getError = false, holdSaves = false } = {}) {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const calls = [];
  let resolveGet;
  const pendingSets = [];
  const chrome = {
    runtime: {},
    storage: {
      sync: {
        get(_keys, callback) {
          const respond = () => {
            if (getError) chrome.runtime.lastError = { message: 'read failed' };
            callback(getError ? undefined : settings);
            delete chrome.runtime.lastError;
          };
          if (delayedGet) resolveGet = respond;
          else respond();
        },
        set(payload, callback) {
          calls.push(payload);
          if (holdSaves) pendingSets.push(callback);
          else callback();
        },
      },
    },
  };

  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;
  const previousWindow = globalThis.window;
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.window = window;
  await import(new URL(`../options.js?ui-test=${moduleId += 1}`, import.meta.url));

  return {
    document,
    window,
    chrome,
    calls,
    resolveGet: () => resolveGet?.(),
    resolveSave(error) {
      if (error) chrome.runtime.lastError = { message: error };
      pendingSets.shift()?.();
      delete chrome.runtime.lastError;
    },
    async start() { await document.fire('DOMContentLoaded'); },
    restore() {
      globalThis.document = previousDocument;
      globalThis.chrome = previousChrome;
      globalThis.window = previousWindow;
    },
  };
}

function selectRadio(document, name, value) {
  for (const radio of document.radios[name]) radio.checked = radio.value === value;
  return getRadio(document, name, value);
}

function getRadio(document, name, value) {
  return document.radios[name].find((radio) => radio.value === value);
}

test('options expose exactly three accessible provider windows and toolbar actions', () => {
  assert.deepEqual(radioValues('openMode'), ['sidepanel', 'companion', 'newtab']);
  assert.deepEqual(radioValues('toolbarAction'), ['popup', 'summarize', 'sidepanel']);
  assert.equal(checkedRadioCount('openMode'), 1);
  assert.equal(checkedRadioCount('toolbarAction'), 1);
  assert.match(optionsHtml, /id="providerWindowLabel"/);
  assert.match(optionsHtml, /role="radiogroup" aria-labelledby="providerWindowLabel"/);
  assert.match(optionsHtml, /id="toolbarBehaviorLabel"/);
  assert.match(optionsHtml, /role="radiogroup" aria-labelledby="toolbarBehaviorLabel"/);
  assert.match(optionsHtml, /<span class="mode-option-body">/);
  assert.match(optionsHtml, /id="saveFeedback" role="status" aria-live="polite"/);
  assert.doesNotMatch(optionsHtml, /quickSummarizeToggle|Quick Summarize/);
});

test('options explain Side Panel and toolbar behavior', () => {
  assert.match(optionsHtml, /native\s+Chrome Side Panel/i);
  assert.match(optionsHtml, /new-tab\s+fallback/i);
  assert.match(optionsHtml, /Right-click actions remain\s+available in every mode\./);
  assert.match(optionsHtml, /default provider and prompt/i);
  assert.match(optionsHtml, /without starting a summary/i);
});

test('options wait for storage migration before allowing autosave edits', async () => {
  const harness = await bootOptions({ settings: { openMode: 'newtab', toolbarAction: 'summarize' }, delayedGet: true });
  try {
    const boot = harness.start();
    await selectRadio(harness.document, 'openMode', 'sidepanel').dispatch('change');
    await waitForSave();
    assert.deepEqual(harness.calls, []);

    harness.resolveGet();
    await boot;
    assert.equal(harness.document.radios.openMode.find((radio) => radio.value === 'newtab').checked, true);
    const sidePanel = selectRadio(harness.document, 'openMode', 'sidepanel');
    await sidePanel.dispatch('change');
    await waitForSave();
    assert.deepEqual(harness.calls, [{ openMode: 'sidepanel' }]);
  } finally {
    harness.restore();
  }
});

test('failed storage initialization renders defaults without persisting them', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  const harness = await bootOptions({ getError: true });
  try {
    await harness.start();
    assert.equal(getRadio(harness.document, 'openMode', 'companion').checked, true);
    assert.equal(getRadio(harness.document, 'toolbarAction', 'popup').checked, true);
    assert.deepEqual(harness.calls, []);
  } finally {
    harness.restore();
    console.warn = originalWarn;
  }
});

test('migration takes precedence and corrupt settings normalize before rendering', async () => {
  const harness = await bootOptions({
    settings: {
      customPrompts: [null, '', 1, '  Keep this  '],
      customUrls: { chatgpt: 'https://example.test/', gemini: 1, extra: 'ignore' },
      defaultProvider: 'not-a-provider',
      defaultPromptIndex: 999,
      openMode: 'invalid',
      toolbarAction: 'sidepanel',
      quickSummarize: true,
      autoSubmit: 'yes',
      includeUrl: null,
      maxContentChars: 100001,
    },
  });
  try {
    await harness.start();
    assert.equal(harness.document.getElementById('defaultPromptSelect').children.length, DEFAULT_PROMPTS.length + 1);
    assert.equal(harness.document.getElementById('url-chatgpt').value, 'https://example.test/');
    assert.equal(harness.document.getElementById('url-gemini').value, '');
    assert.equal(harness.document.getElementById('maxCharsInput').value, 100000);
    assert.equal(getRadio(harness.document, 'openMode', 'companion').checked, true);
    assert.equal(getRadio(harness.document, 'toolbarAction', 'sidepanel').checked, true);
  } finally {
    harness.restore();
  }
});

test('autosave writes only dirty keys and preserves unrelated last selections', async () => {
  const harness = await bootOptions();
  try {
    await harness.start();
    await harness.document.getElementById('providerGrid').dispatch('click', { target: harness.document.providerButtons[1] });
    await waitForSave();
    assert.deepEqual(harness.calls, [{ defaultProvider: 'gemini', lastProvider: 'gemini' }]);

    harness.calls.length = 0;
    const direct = selectRadio(harness.document, 'toolbarAction', 'summarize');
    await direct.dispatch('change');
    await waitForSave();
    assert.deepEqual(harness.calls, [{ toolbarAction: 'summarize' }]);
    assert.equal(Object.hasOwn(harness.calls[0], 'quickSummarize'), false);
  } finally {
    harness.restore();
  }
});

test('prompt selections and mutations persist synchronized default and last indices', async () => {
  const harness = await bootOptions({ settings: { customPrompts: ['First'], defaultPromptIndex: 0 } });
  try {
    await harness.start();
    const select = harness.document.getElementById('defaultPromptSelect');
    select.value = '1';
    await select.dispatch('change');
    await waitForSave();
    assert.deepEqual(harness.calls, [{ defaultPromptIndex: 1, lastPromptIndex: 1 }]);

    harness.calls.length = 0;
    const input = harness.document.getElementById('newPromptInput');
    input.value = 'New prompt';
    await harness.document.getElementById('addPromptBtn').dispatch('click');
    await waitForSave();
    assert.deepEqual(harness.calls, [{
      customPrompts: ['New prompt', 'First'],
      defaultPromptIndex: 2,
      lastPromptIndex: 2,
    }]);
  } finally {
    harness.restore();
  }
});

test('an in-flight same-key autosave serializes the latest value', async () => {
  const harness = await bootOptions({ holdSaves: true });
  try {
    await harness.start();
    const includeUrl = harness.document.getElementById('includeUrlToggle');
    includeUrl.checked = false;
    await includeUrl.dispatch('change');
    await waitForSave();
    assert.deepEqual(harness.calls, [{ includeUrl: false }]);

    includeUrl.checked = true;
    await includeUrl.dispatch('change');
    harness.resolveSave();
    await waitForSave();
    assert.deepEqual(harness.calls, [{ includeUrl: false }, { includeUrl: true }]);
  } finally {
    harness.restore();
  }
});

test('failed saves wait for a later edit before retrying retained dirty keys', async () => {
  const harness = await bootOptions({ holdSaves: true });
  try {
    await harness.start();
    const autoSubmit = harness.document.getElementById('autoSubmitToggle');
    autoSubmit.checked = false;
    await autoSubmit.dispatch('change');
    await waitForSave();
    harness.resolveSave('write failed');

    const feedback = harness.document.getElementById('saveFeedback');
    assert.equal(feedback.classList.contains('visible'), true);
    assert.equal(feedback.classList.contains('error'), true);
    assert.equal(feedback.textContent, 'Could not save settings. Try again.');

    await waitForSave();
    await waitForSave();
    assert.deepEqual(harness.calls, [{ autoSubmit: false }]);

    const includeUrl = harness.document.getElementById('includeUrlToggle');
    includeUrl.checked = false;
    await includeUrl.dispatch('change');
    await waitForSave();
    assert.deepEqual(harness.calls, [
      { autoSubmit: false },
      { autoSubmit: false, includeUrl: false },
    ]);
    harness.resolveSave();
  } finally {
    harness.restore();
  }
});

test('pagehide flushes pending dirty settings without waiting for the debounce', async () => {
  const harness = await bootOptions({ holdSaves: true });
  try {
    await harness.start();
    const autoSubmit = harness.document.getElementById('autoSubmitToggle');
    autoSubmit.checked = false;
    await autoSubmit.dispatch('change');
    await harness.window.dispatch('pagehide');
    assert.deepEqual(harness.calls, [{ autoSubmit: false }]);
  } finally {
    await waitForSave();
    harness.resolveSave();
    harness.restore();
  }
});

test('pagehide dispatches later dirty values while a normal save is in flight', async () => {
  const harness = await bootOptions({ holdSaves: true });
  try {
    await harness.start();
    const autoSubmit = harness.document.getElementById('autoSubmitToggle');
    autoSubmit.checked = false;
    await autoSubmit.dispatch('change');
    await waitForSave();
    assert.deepEqual(harness.calls, [{ autoSubmit: false }]);

    autoSubmit.checked = true;
    await autoSubmit.dispatch('change');
    const includeUrl = harness.document.getElementById('includeUrlToggle');
    includeUrl.checked = false;
    await includeUrl.dispatch('change');
    await harness.window.dispatch('pagehide');
    assert.deepEqual(harness.calls, [
      { autoSubmit: false },
      { autoSubmit: true, includeUrl: false },
    ]);

    await waitForSave();
    assert.equal(harness.calls.length, 2);
    harness.resolveSave();
    harness.resolveSave();
  } finally {
    harness.restore();
  }
});

test('pageshow restores normal saving after a pagehide with an in-flight save', async () => {
  const harness = await bootOptions({ holdSaves: true });
  try {
    await harness.start();
    const autoSubmit = harness.document.getElementById('autoSubmitToggle');
    autoSubmit.checked = false;
    await autoSubmit.dispatch('change');
    await harness.window.dispatch('pagehide');
    assert.deepEqual(harness.calls, [{ autoSubmit: false }]);

    await harness.window.dispatch('pageshow');
    const includeUrl = harness.document.getElementById('includeUrlToggle');
    includeUrl.checked = false;
    await includeUrl.dispatch('change');
    await waitForSave();
    assert.equal(harness.calls.length, 1);

    harness.resolveSave();
    await waitForSave();
    assert.deepEqual(harness.calls, [
      { autoSubmit: false },
      { includeUrl: false },
    ]);
    harness.resolveSave();
  } finally {
    harness.restore();
  }
});
