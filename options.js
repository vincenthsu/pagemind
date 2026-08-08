// Options page script

import { DEFAULT_PROMPTS } from './lib/providers.js';
import { normalizeOpenMode, resolveToolbarAction } from './lib/settings.js';

let customPrompts = [];
let customUrls = {};
let defaultProvider = 'chatgpt';
let defaultPromptIndex = 0;
let openMode = 'companion';
let autoSubmit = true;
let includeUrl = true;
let maxContentChars = 12000;
let toolbarAction = 'popup';

// Debounce timer for auto-save
let saveTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('addPromptBtn').addEventListener('click', () => {
    addPrompt();
    autoSave();
  });
  document.getElementById('newPromptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      addPrompt();
      autoSave();
    }
  });

  document.getElementById('providerGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.provider-btn');
    if (!btn) return;
    defaultProvider = btn.dataset.provider;
    updateProviderButtons();
    autoSave();
  });

  // Auto-save on any option change
  document.querySelectorAll('input[name="openMode"], input[name="toolbarAction"]').forEach((radio) => {
    radio.addEventListener('change', autoSave);
  });
  document.getElementById('autoSubmitToggle').addEventListener('change', () => autoSave());
  document.getElementById('includeUrlToggle').addEventListener('change', () => autoSave());
  document.getElementById('maxCharsInput').addEventListener('change', () => autoSave());

  // URL input listeners
  ['chatgpt', 'gemini', 'claude', 'grok'].forEach(id => {
    document.getElementById(`url-${id}`).addEventListener('input', () => autoSave());
  });

  document.getElementById('defaultPromptSelect').addEventListener('change', (e) => {
    defaultPromptIndex = parseInt(e.target.value, 10);
    autoSave();
  });
});

function loadSettings() {
  chrome.storage.sync.get(
    ['customPrompts', 'customUrls', 'defaultProvider', 'defaultPromptIndex', 'openMode', 'toolbarAction', 'autoSubmit', 'includeUrl', 'maxContentChars', 'quickSummarize'],
    (data) => {
      if (chrome.runtime?.lastError) {
        console.warn('[PageMind] Could not load settings:', chrome.runtime.lastError.message);
      }
      const settings = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      customPrompts = Array.isArray(settings.customPrompts) ? settings.customPrompts : [];
      customUrls = settings.customUrls && typeof settings.customUrls === 'object' && !Array.isArray(settings.customUrls)
        ? settings.customUrls
        : {};
      defaultProvider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : 'chatgpt';
      defaultPromptIndex = Number.isInteger(settings.defaultPromptIndex) ? settings.defaultPromptIndex : 0;
      openMode = normalizeOpenMode(settings.openMode);
      toolbarAction = resolveToolbarAction(settings);
      autoSubmit = typeof settings.autoSubmit === 'boolean' ? settings.autoSubmit : true;
      includeUrl = typeof settings.includeUrl === 'boolean' ? settings.includeUrl : true;
      maxContentChars = Number.isFinite(settings.maxContentChars) && settings.maxContentChars > 0
        ? settings.maxContentChars
        : 12000;

      updateProviderButtons();
      renderPromptList();
      renderDefaultPromptSelect();

      // Populate custom URLs
      ['chatgpt', 'gemini', 'claude', 'grok'].forEach(id => {
        document.getElementById(`url-${id}`).value = typeof customUrls[id] === 'string' ? customUrls[id] : '';
      });

      const modeRadio = document.querySelector(`input[name="openMode"][value="${openMode}"]`);
      if (modeRadio) modeRadio.checked = true;
      const toolbarRadio = document.querySelector(`input[name="toolbarAction"][value="${toolbarAction}"]`);
      if (toolbarRadio) toolbarRadio.checked = true;

      document.getElementById('autoSubmitToggle').checked = autoSubmit;
      document.getElementById('includeUrlToggle').checked = includeUrl;
      document.getElementById('maxCharsInput').value = maxContentChars;
    }
  );
}

function updateProviderButtons() {
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.provider === defaultProvider);
  });
}

function renderDefaultPromptSelect() {
  const select = document.getElementById('defaultPromptSelect');
  const allPrompts = [...customPrompts, ...DEFAULT_PROMPTS];
  select.innerHTML = '';
  allPrompts.forEach((prompt, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;
    if (i === defaultPromptIndex) option.selected = true;
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

    customPrompts.forEach((prompt, i) => {
      list.appendChild(createPromptItem(prompt, i, 'custom'));
    });
  }

  const builtinHeader = document.createElement('li');
  builtinHeader.className = 'section-divider';
  builtinHeader.textContent = 'Built-in Prompts';
  list.appendChild(builtinHeader);

  DEFAULT_PROMPTS.forEach((prompt) => {
    list.appendChild(createPromptItem(prompt, -1, 'builtin'));
  });
}

function createPromptItem(prompt, index, type) {
  const li = document.createElement('li');
  li.className = `prompt-item ${type}`;

  const text = document.createElement('span');
  text.className = 'prompt-text';
  text.textContent = prompt;
  li.appendChild(text);

  const tag = document.createElement('span');
  tag.className = 'prompt-tag';
  tag.textContent = type === 'custom' ? 'Custom' : 'Built-in';
  li.appendChild(tag);

  if (type === 'custom') {
    const upBtn = document.createElement('button');
    upBtn.className = 'icon-btn up';
    upBtn.title = 'Move up';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => { movePrompt(index, -1); autoSave(); });
    li.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.className = 'icon-btn down';
    downBtn.title = 'Move down';
    downBtn.textContent = '↓';
    downBtn.disabled = index === customPrompts.length - 1;
    downBtn.addEventListener('click', () => { movePrompt(index, 1); autoSave(); });
    li.appendChild(downBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.title = 'Remove';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => { removePrompt(index); autoSave(); });
    li.appendChild(delBtn);
  }

  return li;
}

function addPrompt() {
  const input = document.getElementById('newPromptInput');
  const text = input.value.trim();
  if (!text) return;
  customPrompts.unshift(text);
  // Shift defaultPromptIndex since we inserted at position 0
  defaultPromptIndex += 1;
  input.value = '';
  renderPromptList();
  renderDefaultPromptSelect();
}

function removePrompt(index) {
  customPrompts.splice(index, 1);
  // Adjust defaultPromptIndex
  if (defaultPromptIndex === index) {
    defaultPromptIndex = 0;
  } else if (defaultPromptIndex > index) {
    defaultPromptIndex -= 1;
  }
  renderPromptList();
  renderDefaultPromptSelect();
}

function movePrompt(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= customPrompts.length) return;
  const temp = customPrompts[index];
  customPrompts[index] = customPrompts[newIndex];
  customPrompts[newIndex] = temp;
  // Adjust defaultPromptIndex if it was one of the swapped items
  if (defaultPromptIndex === index) {
    defaultPromptIndex = newIndex;
  } else if (defaultPromptIndex === newIndex) {
    defaultPromptIndex = index;
  }
  renderPromptList();
  renderDefaultPromptSelect();
}

// Auto-save with debounce (300ms)
function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
}

function saveSettings() {
  const selectedMode = document.querySelector('input[name="openMode"]:checked')?.value || 'companion';
  const selectedToolbarAction = document.querySelector('input[name="toolbarAction"]:checked')?.value || 'popup';
  const autoSubmitVal = document.getElementById('autoSubmitToggle')?.checked ?? true;
  const includeUrlVal = document.getElementById('includeUrlToggle')?.checked ?? true;
  const maxCharsVal = parseInt(document.getElementById('maxCharsInput')?.value, 10) || 12000;
  openMode = normalizeOpenMode(selectedMode);
  toolbarAction = resolveToolbarAction({ toolbarAction: selectedToolbarAction });

  // Collect custom URLs
  const newCustomUrls = {};
  ['chatgpt', 'gemini', 'claude', 'grok'].forEach(id => {
    const val = document.getElementById(`url-${id}`).value.trim();
    if (val) newCustomUrls[id] = val;
  });

  chrome.storage.sync.set({
    customPrompts,
    customUrls: newCustomUrls,
    defaultProvider,
    defaultPromptIndex,
    lastProvider: defaultProvider,
    lastPromptIndex: defaultPromptIndex,
    openMode: normalizeOpenMode(selectedMode),
    toolbarAction: resolveToolbarAction({ toolbarAction: selectedToolbarAction }),
    autoSubmit: autoSubmitVal,
    includeUrl: includeUrlVal,
    maxContentChars: maxCharsVal,
  }, () => {
    if (chrome.runtime?.lastError) {
      console.error('[PageMind] Could not save settings:', chrome.runtime.lastError.message);
      return;
    }
    const feedback = document.getElementById('saveFeedback');
    feedback.classList.add('visible');
    setTimeout(() => feedback.classList.remove('visible'), 1500);
  });
}
