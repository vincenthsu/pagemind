// Options page script

import { DEFAULT_PROMPTS } from './lib/providers.js';
import { createExportPayload, normalizeOpenMode, resolveToolbarAction, validateImportedSettings } from './lib/settings.js';

const PROVIDERS = ['chatgpt', 'gemini', 'claude'];
const MIN_CONTENT_CHARS = 1000;
const MAX_CONTENT_CHARS = 100000;
const DEFAULT_CONTENT_CHARS = 12000;

let customPrompts = [];
let customUrls = {};
let defaultProvider = 'chatgpt';
let defaultPromptIndex = 0;
let openMode = 'companion';
let autoSubmit = true;
let includeUrl = true;
let sidepanelNewChat = false;
let maxContentChars = DEFAULT_CONTENT_CHARS;
let toolbarAction = 'popup';
let saveTimer = null;
let feedbackTimer = null;
let saveInFlight = false;
let isExiting = false;
const dirtyKeys = new Set();

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  registerEventListeners();
  window.addEventListener('pagehide', flushOnPageHide);
  window.addEventListener('pageshow', resumeAfterPageShow);
});

function registerEventListeners() {
  document.getElementById('addPromptBtn').addEventListener('click', () => {
    if (addPrompt()) autoSave('customPrompts', 'defaultPromptIndex', 'lastPromptIndex');
  });
  document.getElementById('newPromptInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (addPrompt()) autoSave('customPrompts', 'defaultPromptIndex', 'lastPromptIndex');
    }
  });

  document.getElementById('providerGrid').addEventListener('click', (event) => {
    const button = event.target.closest('.provider-btn');
    if (!button || !PROVIDERS.includes(button.dataset.provider)) return;
    defaultProvider = button.dataset.provider;
    updateProviderButtons();
    autoSave('defaultProvider', 'lastProvider');
  });

  document.querySelectorAll('input[name="openMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      openMode = normalizeOpenMode(radio.value);
      autoSave('openMode');
    });
  });
  document.querySelectorAll('input[name="toolbarAction"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      toolbarAction = resolveToolbarAction({ toolbarAction: radio.value });
      autoSave('toolbarAction');
    });
  });
  document.getElementById('autoSubmitToggle').addEventListener('change', (event) => {
    autoSubmit = Boolean(event.target.checked);
    autoSave('autoSubmit');
  });
  document.getElementById('includeUrlToggle').addEventListener('change', (event) => {
    includeUrl = Boolean(event.target.checked);
    autoSave('includeUrl');
  });
  document.getElementById('sidepanelNewChatToggle').addEventListener('change', (event) => {
    sidepanelNewChat = Boolean(event.target.checked);
    autoSave('sidepanelNewChat');
  });
  document.getElementById('maxCharsInput').addEventListener('change', (event) => {
    maxContentChars = normalizeMaxContentChars(Number(event.target.value));
    event.target.value = maxContentChars;
    autoSave('maxContentChars');
  });

  PROVIDERS.forEach((provider) => {
    document.getElementById(`url-${provider}`).addEventListener('input', () => autoSave('customUrls'));
  });

  document.getElementById('defaultPromptSelect').addEventListener('change', (event) => {
    defaultPromptIndex = normalizePromptIndex(Number(event.target.value));
    autoSave('defaultPromptIndex', 'lastPromptIndex');
  });

  document.getElementById('exportSettingsBtn').addEventListener('click', () => {
    exportSettings();
  });
  document.getElementById('importSettingsBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importSettingsFromFile(file);
    event.target.value = '';
  });
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['customPrompts', 'customUrls', 'defaultProvider', 'defaultPromptIndex', 'openMode', 'toolbarAction', 'autoSubmit', 'includeUrl', 'sidepanelNewChat', 'maxContentChars', 'quickSummarize'],
      (data) => {
        try {
          if (chrome.runtime?.lastError) {
            console.warn('[PageMind] Could not load settings:', chrome.runtime.lastError.message);
          }
          applySettings(data);
          renderSettings();
        } catch (error) {
          console.error('[PageMind] Could not render settings:', error);
          applySettings({});
          renderSettings();
        } finally {
          resolve();
        }
      }
    );
  });
}

function applySettings(data) {
  const settings = isPlainObject(data) ? data : {};
  customPrompts = Array.isArray(settings.customPrompts)
    ? settings.customPrompts.map((prompt) => typeof prompt === 'string' ? prompt.trim() : '').filter(Boolean)
    : [];
  customUrls = normalizeCustomUrls(settings.customUrls);
  defaultProvider = PROVIDERS.includes(settings.defaultProvider) ? settings.defaultProvider : 'chatgpt';
  defaultPromptIndex = normalizePromptIndex(settings.defaultPromptIndex);
  openMode = normalizeOpenMode(settings.openMode);
  toolbarAction = resolveToolbarAction(settings);
  autoSubmit = typeof settings.autoSubmit === 'boolean' ? settings.autoSubmit : true;
  includeUrl = typeof settings.includeUrl === 'boolean' ? settings.includeUrl : true;
  sidepanelNewChat = typeof settings.sidepanelNewChat === 'boolean' ? settings.sidepanelNewChat : false;
  maxContentChars = normalizeMaxContentChars(settings.maxContentChars);
}

function renderSettings() {
  updateProviderButtons();
  renderPromptList();
  renderDefaultPromptSelect();
  PROVIDERS.forEach((provider) => {
    document.getElementById(`url-${provider}`).value = customUrls[provider] ?? '';
  });

  const modeRadio = document.querySelector(`input[name="openMode"][value="${openMode}"]`);
  if (modeRadio) modeRadio.checked = true;
  const toolbarRadio = document.querySelector(`input[name="toolbarAction"][value="${toolbarAction}"]`);
  if (toolbarRadio) toolbarRadio.checked = true;
  document.getElementById('autoSubmitToggle').checked = autoSubmit;
  document.getElementById('includeUrlToggle').checked = includeUrl;
  document.getElementById('sidepanelNewChatToggle').checked = sidepanelNewChat;
  document.getElementById('maxCharsInput').value = maxContentChars;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCustomUrls(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(PROVIDERS.flatMap((provider) => {
    const url = value[provider];
    return typeof url === 'string' ? [[provider, url]] : [];
  }));
}

function normalizePromptIndex(value) {
  const maxIndex = Math.max(0, customPrompts.length + DEFAULT_PROMPTS.length - 1);
  if (!Number.isInteger(value)) return 0;
  return Math.min(Math.max(value, 0), maxIndex);
}

function normalizeMaxContentChars(value) {
  if (!Number.isInteger(value)) return DEFAULT_CONTENT_CHARS;
  return Math.min(Math.max(value, MIN_CONTENT_CHARS), MAX_CONTENT_CHARS);
}

function updateProviderButtons() {
  document.querySelectorAll('.provider-btn').forEach((button) => {
    button.classList.toggle('selected', button.dataset.provider === defaultProvider);
  });
}

function renderDefaultPromptSelect() {
  const select = document.getElementById('defaultPromptSelect');
  const allPrompts = [...customPrompts, ...DEFAULT_PROMPTS];
  select.innerHTML = '';
  allPrompts.forEach((prompt, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
    if (index === defaultPromptIndex) option.selected = true;
    select.appendChild(option);
  });
}

function renderPromptList() {
  const list = document.getElementById('promptList');
  list.innerHTML = '';

  if (customPrompts.length > 0) {
    const customHeader = document.createElement('li');
    customHeader.className = 'section-divider';
    customHeader.textContent = 'Custom Prompts';
    list.appendChild(customHeader);
    customPrompts.forEach((prompt, index) => list.appendChild(createPromptItem(prompt, index, 'custom')));
  }

  const builtinHeader = document.createElement('li');
  builtinHeader.className = 'section-divider';
  builtinHeader.textContent = 'Built-in Prompts';
  list.appendChild(builtinHeader);
  DEFAULT_PROMPTS.forEach((prompt) => list.appendChild(createPromptItem(prompt, -1, 'builtin')));
}

function createPromptItem(prompt, index, type) {
  const item = document.createElement('li');
  item.className = `prompt-item ${type}`;

  const text = document.createElement('span');
  text.className = 'prompt-text';
  text.textContent = prompt;
  item.appendChild(text);

  const tag = document.createElement('span');
  tag.className = 'prompt-tag';
  tag.textContent = type === 'custom' ? 'Custom' : 'Built-in';
  item.appendChild(tag);

  if (type === 'custom') {
    const upButton = document.createElement('button');
    upButton.className = 'icon-btn up';
    upButton.title = 'Move up';
    upButton.textContent = '↑';
    upButton.disabled = index === 0;
    upButton.addEventListener('click', () => {
      if (movePrompt(index, -1)) autoSave('customPrompts', 'defaultPromptIndex', 'lastPromptIndex');
    });
    item.appendChild(upButton);

    const downButton = document.createElement('button');
    downButton.className = 'icon-btn down';
    downButton.title = 'Move down';
    downButton.textContent = '↓';
    downButton.disabled = index === customPrompts.length - 1;
    downButton.addEventListener('click', () => {
      if (movePrompt(index, 1)) autoSave('customPrompts', 'defaultPromptIndex', 'lastPromptIndex');
    });
    item.appendChild(downButton);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'icon-btn';
    deleteButton.title = 'Remove';
    deleteButton.textContent = '✕';
    deleteButton.addEventListener('click', () => {
      removePrompt(index);
      autoSave('customPrompts', 'defaultPromptIndex', 'lastPromptIndex');
    });
    item.appendChild(deleteButton);
  }

  return item;
}

function addPrompt() {
  const input = document.getElementById('newPromptInput');
  const text = input.value.trim();
  if (!text) return false;
  customPrompts.unshift(text);
  defaultPromptIndex = normalizePromptIndex(defaultPromptIndex + 1);
  input.value = '';
  renderPromptList();
  renderDefaultPromptSelect();
  return true;
}

function removePrompt(index) {
  customPrompts.splice(index, 1);
  if (defaultPromptIndex === index) defaultPromptIndex = 0;
  else if (defaultPromptIndex > index) defaultPromptIndex -= 1;
  defaultPromptIndex = normalizePromptIndex(defaultPromptIndex);
  renderPromptList();
  renderDefaultPromptSelect();
}

function movePrompt(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= customPrompts.length) return false;
  [customPrompts[index], customPrompts[newIndex]] = [customPrompts[newIndex], customPrompts[index]];
  if (defaultPromptIndex === index) defaultPromptIndex = newIndex;
  else if (defaultPromptIndex === newIndex) defaultPromptIndex = index;
  renderPromptList();
  renderDefaultPromptSelect();
  return true;
}

function autoSave(...keys) {
  keys.forEach((key) => dirtyKeys.add(key));
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDirtySettings, 300);
}

function flushDirtySettings() {
  saveTimer = null;
  if (saveInFlight || dirtyKeys.size === 0) return;

  const keys = [...dirtyKeys];
  dirtyKeys.clear();
  const payload = buildSavePayload(keys);
  saveInFlight = true;
  chrome.storage.sync.set(payload, () => {
    const error = chrome.runtime?.lastError;
    saveInFlight = false;
    if (error) {
      keys.forEach((key) => dirtyKeys.add(key));
      showSaveFeedback('Could not save settings. Try again.', true);
    } else {
      showSaveFeedback('✓ Settings saved');
      if (!isExiting && dirtyKeys.size > 0) scheduleSave();
    }
  });
}

function flushOnPageHide() {
  isExiting = true;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saveInFlight) {
    flushExitDirtySettings();
    return;
  }
  flushDirtySettings();
}

function flushExitDirtySettings() {
  if (dirtyKeys.size === 0) return;
  const keys = [...dirtyKeys];
  dirtyKeys.clear();
  const payload = buildSavePayload(keys);
  chrome.storage.sync.set(payload, () => {
    if (chrome.runtime?.lastError) {
      keys.forEach((key) => dirtyKeys.add(key));
      showSaveFeedback('Could not save settings. Try again.', true);
    } else {
      showSaveFeedback('✓ Settings saved');
    }
  });
}

function resumeAfterPageShow() {
  isExiting = false;
  if (!saveInFlight && dirtyKeys.size > 0) scheduleSave();
}

function buildSavePayload(keys) {
  const dirty = new Set(keys);
  const payload = {};
  if (dirty.has('customPrompts')) payload.customPrompts = customPrompts;
  if (dirty.has('customUrls')) {
    customUrls = collectCustomUrls();
    payload.customUrls = customUrls;
  }
  if (dirty.has('defaultProvider')) payload.defaultProvider = defaultProvider;
  if (dirty.has('lastProvider')) payload.lastProvider = defaultProvider;
  if (dirty.has('defaultPromptIndex')) payload.defaultPromptIndex = defaultPromptIndex;
  if (dirty.has('lastPromptIndex')) payload.lastPromptIndex = defaultPromptIndex;
  if (dirty.has('openMode')) payload.openMode = openMode;
  if (dirty.has('toolbarAction')) payload.toolbarAction = toolbarAction;
  if (dirty.has('autoSubmit')) payload.autoSubmit = autoSubmit;
  if (dirty.has('includeUrl')) payload.includeUrl = includeUrl;
  if (dirty.has('sidepanelNewChat')) payload.sidepanelNewChat = sidepanelNewChat;
  if (dirty.has('maxContentChars')) payload.maxContentChars = maxContentChars;
  return payload;
}

function collectCustomUrls() {
  return Object.fromEntries(PROVIDERS.flatMap((provider) => {
    const value = document.getElementById(`url-${provider}`).value.trim();
    return value ? [[provider, value]] : [];
  }));
}

function showSaveFeedback(message, isError = false) {
  const feedback = document.getElementById('saveFeedback');
  feedback.textContent = message;
  feedback.classList.toggle('error', isError);
  feedback.classList.add('visible');
  clearTimeout(feedbackTimer);
  if (!isError) {
    feedbackTimer = setTimeout(() => feedback.classList.remove('visible'), 1500);
  }
}

function exportSettings() {
  const currentSettings = {
    defaultProvider,
    lastProvider: defaultProvider,
    defaultPromptIndex,
    lastPromptIndex: defaultPromptIndex,
    customPrompts,
    customUrls: collectCustomUrls(),
    openMode,
    toolbarAction,
    autoSubmit,
    includeUrl,
    sidepanelNewChat,
    maxContentChars,
  };
  const exportData = createExportPayload(currentSettings);
  const json = JSON.stringify(exportData, null, 2);
  if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `pagemind-settings-${dateStr}.json`;
    if (document.body) {
      document.body.appendChild(a);
      if (typeof a.click === 'function') a.click();
      if (typeof document.body.removeChild === 'function') document.body.removeChild(a);
    } else if (typeof a.click === 'function') {
      a.click();
    }
    URL.revokeObjectURL(url);
  }
  showSaveFeedback('✓ Settings exported');
  return json;
}

function importSettingsFromFile(file) {
  if (!file) return;
  if (typeof FileReader === 'undefined') {
    showSaveFeedback('FileReader is not supported', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = (event) => {
    importSettingsContent(event.target.result);
  };
  reader.onerror = () => {
    showSaveFeedback('Could not read settings file', true);
  };
  reader.readAsText(file);
}

function importSettingsContent(text) {
  try {
    const parsed = JSON.parse(text);
    const imported = validateImportedSettings(parsed);
    if (!imported) {
      showSaveFeedback('Could not import settings: Invalid JSON file', true);
      return false;
    }

    applySettings(imported);
    renderSettings();

    const payload = {
      defaultProvider,
      lastProvider: defaultProvider,
      defaultPromptIndex,
      lastPromptIndex: defaultPromptIndex,
      customPrompts,
      customUrls,
      openMode,
      toolbarAction,
      autoSubmit,
      includeUrl,
      sidepanelNewChat,
      maxContentChars,
    };

    dirtyKeys.clear();
    clearTimeout(saveTimer);
    saveTimer = null;

    chrome.storage.sync.set(payload, () => {
      if (chrome.runtime?.lastError) {
        showSaveFeedback('Could not save imported settings.', true);
      } else {
        showSaveFeedback('✓ Settings imported successfully');
      }
    });
    return true;
  } catch {
    showSaveFeedback('Could not import settings: Invalid JSON file', true);
    return false;
  }
}

