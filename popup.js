// Popup script — handles provider selection, prompt selection, and summarize action

import { getDefaultPrompts, PROVIDERS } from './lib/providers.js';
import { normalizeOpenMode } from './lib/settings.js';
import { applyI18n, applyLocaleSetting, t } from './lib/i18n.js';

let selectedProvider = 'chatgpt';
let allPrompts = [];
let openMode = 'companion';
let sourceTabId = null;
let sourceWindowId = null;

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  renderPrompts();
  await updateButtonLabel();
  setupEventListeners();
});

// Check if there's a selection on the active tab and update the button label
async function updateButtonLabel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    sourceTabId = tab.id;
    if (Number.isInteger(tab.windowId)) sourceWindowId = tab.windowId;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.getSelection().toString().trim(),
    });
    const selected = results.map(r => r.result).filter(Boolean).join('\n\n').trim();
    const btn = document.getElementById('summarizeBtn');
    btn.textContent = selected.length > 0
      ? t('popupSummarizeSelection')
      : t('popupSummarizePage');
  } catch {
    // Non-fatal — leave default label
  }
}

async function loadSettings() {
  return new Promise((resolve) => {
    const useSettings = (value) => {
      const data = value && typeof value === 'object' ? value : {};
      applyLocaleSetting(data, chrome);
      applyI18n(document);
      if (typeof data.lastProvider === 'string' && Object.hasOwn(PROVIDERS, data.lastProvider)) {
        selectedProvider = data.lastProvider;
      }
      const customPrompts = Array.isArray(data.customPrompts)
        ? data.customPrompts.filter((prompt) => typeof prompt === 'string')
        : [];
      allPrompts = [...customPrompts, ...getDefaultPrompts()];
      openMode = normalizeOpenMode(data.openMode);
      const requestedIndex = Number.isInteger(data.lastPromptIndex) && data.lastPromptIndex >= 0
        ? data.lastPromptIndex
        : 0;
      document.getElementById('promptSelect').dataset.lastIndex = Math.min(
        requestedIndex,
        allPrompts.length - 1,
      );
      updateProviderButtons();
      resolve();
    };

    try {
      chrome.storage.sync.get(
        ['lastProvider', 'lastPromptIndex', 'customPrompts', 'openMode', 'locale'],
        (data) => useSettings(chrome.runtime.lastError ? {} : data),
      );
    } catch {
      useSettings({});
    }
  });
}

function renderPrompts() {
  const select = document.getElementById('promptSelect');
  const lastIndex = parseInt(select.dataset.lastIndex || '0', 10);

  select.innerHTML = '';
  allPrompts.forEach((prompt, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;
    if (i === lastIndex) option.selected = true;
    select.appendChild(option);
  });
}

function updateProviderButtons() {
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.provider === selectedProvider);
  });
}

function setupEventListeners() {
  // Provider buttons
  document.getElementById('providerGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.provider-btn');
    if (!btn) return;
    selectedProvider = btn.dataset.provider;
    updateProviderButtons();
    chrome.storage.sync.set({ lastProvider: selectedProvider });
  });

  // Prompt select — save last choice
  document.getElementById('promptSelect').addEventListener('change', (e) => {
    chrome.storage.sync.set({ lastPromptIndex: parseInt(e.target.value, 10) });
  });

  // Settings button
  document.getElementById('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Summarize button
  document.getElementById('summarizeBtn').addEventListener('click', handleSummarize);
}

async function handleSummarize() {
  try {
    if (openMode === 'sidepanel') {
      await chrome.sidePanel.open({
        windowId: sourceWindowId ?? chrome.windows.WINDOW_ID_CURRENT,
      });
    }

    const promptIndex = parseInt(document.getElementById('promptSelect').value, 10);
    let selectedText = '';
    try {
      if (Number.isInteger(sourceTabId)) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: sourceTabId, allFrames: true },
          func: () => window.getSelection().toString().trim(),
        });
        selectedText = results.map(r => r.result).filter(Boolean).join('\n\n').trim();
      }
    } catch {
      // Selection access is best-effort; background extraction can still proceed.
    }

    setStatus('loading', selectedText.length > 0
      ? t('popupStatusSendingSelection')
      : t('popupStatusExtracting'));
    setButtonDisabled(true);

    chrome.runtime.sendMessage(
      {
        type: 'SUMMARIZE',
        provider: selectedProvider,
        promptIndex,
        selectedText,
        sourceTabId,
        sourceWindowId,
        destination: openMode,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus('error', t('popupErrorExtension', chrome.runtime.lastError.message));
          setButtonDisabled(false);
          return;
        }

        if (response?.error) {
          setStatus('error', t('popupErrorGeneric', response.error));
          setButtonDisabled(false);
          return;
        }

        if (response?.success) {
          setStatus('success', t('popupStatusSent', PROVIDERS[selectedProvider]?.label || selectedProvider));
          showClipboardHint();
          setTimeout(() => window.close(), 1500);
        }
      },
    );
  } catch (error) {
    setStatus('error', t('popupErrorGeneric', error?.message || String(error)));
    setButtonDisabled(false);
  }
}

function setStatus(type, message) {
  const el = document.getElementById('statusMsg');
  el.textContent = message;
  el.className = 'status visible ' + type;
}

function setButtonDisabled(disabled) {
  const btn = document.getElementById('summarizeBtn');
  btn.disabled = disabled;
  if (disabled) {
    btn.textContent = t('popupSending');
  } else {
    // Restore correct label after operation
    updateButtonLabel();
  }
}

function showClipboardHint() {
  const hint = document.getElementById('clipboardHint');
  hint.classList.add('visible');
}
