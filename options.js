// Options page script

const DEFAULT_PROMPTS = [
  'Summarize the following content in 5 bullet points:',
  'What are the key takeaways from this content?',
  'Explain this to me like I\'m 5 years old:',
  'Extract all action items and decisions from this content:',
  'Write a critical analysis of:',
  'Translate the following content to Traditional Chinese and summarize:',
];

let customPrompts = [];
let customUrls = {};
let defaultProvider = 'chatgpt';
let defaultPromptIndex = 0;
let openMode = 'companion';
let autoSubmit = true;
let includeUrl = true;
let maxContentChars = 12000;
let quickSummarize = false;

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
  document.querySelectorAll('input[name="openMode"]').forEach((radio) => {
    radio.addEventListener('change', () => autoSave());
  });
  document.getElementById('autoSubmitToggle').addEventListener('change', () => autoSave());
  document.getElementById('includeUrlToggle').addEventListener('change', () => autoSave());
  document.getElementById('quickSummarizeToggle').addEventListener('change', () => autoSave());
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
    ['customPrompts', 'customUrls', 'defaultProvider', 'defaultPromptIndex', 'openMode', 'autoSubmit', 'includeUrl', 'maxContentChars', 'quickSummarize'],
    (data) => {
      customPrompts = data.customPrompts || [];
      customUrls = data.customUrls || {};
      defaultProvider = data.defaultProvider || 'chatgpt';
      defaultPromptIndex = data.defaultPromptIndex ?? 0;
      openMode = data.openMode || 'companion';
      autoSubmit = data.autoSubmit !== undefined ? data.autoSubmit : true;
      includeUrl = data.includeUrl !== undefined ? data.includeUrl : true;
      maxContentChars = data.maxContentChars || 12000;
      quickSummarize = data.quickSummarize || false;

      updateProviderButtons();
      renderPromptList();
      renderDefaultPromptSelect();

      // Populate custom URLs
      ['chatgpt', 'gemini', 'claude', 'grok'].forEach(id => {
        document.getElementById(`url-${id}`).value = customUrls[id] || '';
      });

      const radio = document.querySelector(`input[name="openMode"][value="${openMode}"]`);
      if (radio) radio.checked = true;

      document.getElementById('autoSubmitToggle').checked = autoSubmit;
      document.getElementById('includeUrlToggle').checked = includeUrl;
      document.getElementById('quickSummarizeToggle').checked = quickSummarize;
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
  const autoSubmitVal = document.getElementById('autoSubmitToggle')?.checked ?? true;
  const includeUrlVal = document.getElementById('includeUrlToggle')?.checked ?? true;
  const maxCharsVal = parseInt(document.getElementById('maxCharsInput')?.value, 10) || 12000;
  const quickSummarizeVal = document.getElementById('quickSummarizeToggle')?.checked ?? false;

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
    openMode: selectedMode,
    autoSubmit: autoSubmitVal,
    includeUrl: includeUrlVal,
    maxContentChars: maxCharsVal,
    quickSummarize: quickSummarizeVal,
  }, () => {
    const feedback = document.getElementById('saveFeedback');
    feedback.classList.add('visible');
    setTimeout(() => feedback.classList.remove('visible'), 1500);
  });
}
