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
let defaultProvider = 'chatgpt';

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('addPromptBtn').addEventListener('click', addPrompt);
  document.getElementById('newPromptInput').addEventListener('keydown', (e) => {
    // Ctrl+Enter or Cmd+Enter to add
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      addPrompt();
    }
  });

  document.getElementById('providerGrid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.provider-btn');
    if (!btn) return;
    defaultProvider = btn.dataset.provider;
    updateProviderButtons();
  });

  document.getElementById('saveBtn').addEventListener('click', saveSettings);
});

// Also handle provider grid in options (it's declared with id in the HTML)
document.addEventListener('click', (e) => {
  if (e.target.closest('.provider-grid') && e.target.closest('.provider-btn')) {
    // handled by the grid listener above, but also update visual state here
    updateProviderButtons();
  }
});

function loadSettings() {
  chrome.storage.sync.get(['customPrompts', 'defaultProvider'], (data) => {
    customPrompts = data.customPrompts || [];
    defaultProvider = data.defaultProvider || 'chatgpt';
    updateProviderButtons();
    renderPromptList();
  });
}

function updateProviderButtons() {
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.provider === defaultProvider);
  });
}

function renderPromptList() {
  const list = document.getElementById('promptList');
  list.innerHTML = '';

  // Custom prompts (editable, reorderable)
  if (customPrompts.length > 0) {
    const customHeader = document.createElement('li');
    customHeader.className = 'section-divider';
    customHeader.textContent = 'Custom Prompts';
    list.appendChild(customHeader);

    customPrompts.forEach((prompt, i) => {
      list.appendChild(createPromptItem(prompt, i, 'custom'));
    });
  }

  // Built-in prompts (read-only display)
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
    // Up button
    const upBtn = document.createElement('button');
    upBtn.className = 'icon-btn up';
    upBtn.title = 'Move up';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => movePrompt(index, -1));
    li.appendChild(upBtn);

    // Down button
    const downBtn = document.createElement('button');
    downBtn.className = 'icon-btn down';
    downBtn.title = 'Move down';
    downBtn.textContent = '↓';
    downBtn.disabled = index === customPrompts.length - 1;
    downBtn.addEventListener('click', () => movePrompt(index, 1));
    li.appendChild(downBtn);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.title = 'Remove';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => removePrompt(index));
    li.appendChild(delBtn);
  }

  return li;
}

function addPrompt() {
  const input = document.getElementById('newPromptInput');
  const text = input.value.trim();
  if (!text) return;

  customPrompts.unshift(text); // add to top
  input.value = '';
  renderPromptList();
}

function removePrompt(index) {
  customPrompts.splice(index, 1);
  renderPromptList();
}

function movePrompt(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= customPrompts.length) return;
  const temp = customPrompts[index];
  customPrompts[index] = customPrompts[newIndex];
  customPrompts[newIndex] = temp;
  renderPromptList();
}

function saveSettings() {
  chrome.storage.sync.set({ customPrompts, defaultProvider }, () => {
    // Also update the lastProvider if it matches what we're saving as default
    chrome.storage.sync.set({ lastProvider: defaultProvider });

    const feedback = document.getElementById('saveFeedback');
    feedback.classList.add('visible');
    setTimeout(() => feedback.classList.remove('visible'), 2500);
  });
}
