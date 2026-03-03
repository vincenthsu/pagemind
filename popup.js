// Popup script — handles provider selection, prompt selection, and summarize action

const DEFAULT_PROMPTS = [
  'Summarize the following content in 5 bullet points:',
  'What are the key takeaways from this content?',
  'Explain this to me like I\'m 5 years old:',
  'Extract all action items and decisions from this content:',
  'Write a critical analysis of:',
  'Translate the following content to Traditional Chinese and summarize:',
];

let selectedProvider = 'chatgpt';
let allPrompts = [];

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  renderPrompts();
  setupEventListeners();
  await updateButtonLabel();
});

// Check if there's a selection on the active tab and update the button label
async function updateButtonLabel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.getSelection().toString().trim(),
    });
    const selected = results.map(r => r.result).filter(Boolean).join('\n\n').trim();
    const btn = document.getElementById('summarizeBtn');
    if (selected.length > 0) {
      btn.textContent = '✂️ Summarize Selection';
    } else {
      btn.textContent = 'Summarize This Page';
    }
  } catch {
    // Non-fatal — leave default label
  }
}

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['lastProvider', 'lastPromptIndex', 'customPrompts'],
      (data) => {
        if (data.lastProvider) {
          selectedProvider = data.lastProvider;
        }

        const customPrompts = data.customPrompts || [];
        allPrompts = [...customPrompts, ...DEFAULT_PROMPTS];

        // Restore last prompt index (bounded to current list length)
        const lastIndex = Math.min(
          data.lastPromptIndex ?? 0,
          allPrompts.length - 1
        );
        document.getElementById('promptSelect').dataset.lastIndex = lastIndex;

        // Highlight the selected provider button
        updateProviderButtons();
        resolve();
      }
    );
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
  const promptIndex = parseInt(document.getElementById('promptSelect').value, 10);

  // Check for selected text on the active tab before sending
  let selectedText = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => window.getSelection().toString().trim(),
      });
      selectedText = results.map(r => r.result).filter(Boolean).join('\n\n').trim();
    }
  } catch {
    // Non-fatal — proceed without selection
  }

  if (selectedText.length > 0) {
    setStatus('loading', '⏳ Sending selected text…');
  } else {
    setStatus('loading', '⏳ Extracting page content…');
  }
  setButtonDisabled(true);

  chrome.runtime.sendMessage(
    { type: 'SUMMARIZE', provider: selectedProvider, promptIndex, selectedText },
    (response) => {
      if (chrome.runtime.lastError) {
        setStatus('error', '❌ Extension error: ' + chrome.runtime.lastError.message);
        setButtonDisabled(false);
        return;
      }

      if (response?.error) {
        setStatus('error', '❌ ' + response.error);
        setButtonDisabled(false);
        return;
      }

      if (response?.success) {
        const providerLabels = {
          chatgpt: 'ChatGPT',
          gemini: 'Gemini',
          claude: 'Claude',
          grok: 'Grok',
        };
        setStatus('success', `✅ Sent to ${providerLabels[selectedProvider] || selectedProvider}`);
        showClipboardHint();
        // Close popup after short delay
        setTimeout(() => window.close(), 1500);
      }
    }
  );
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
    btn.textContent = 'Sending…';
  } else {
    // Restore correct label after operation
    updateButtonLabel();
  }
}

function showClipboardHint() {
  const hint = document.getElementById('clipboardHint');
  hint.classList.add('visible');
}
