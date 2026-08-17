// Central registry for AI provider configuration
// Update selectors here when provider UIs change

import { t } from './i18n.js';
import en from './locales/en.js';

export const PROVIDERS = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    color: '#10a37f',
    inputSelector: '#prompt-textarea',
    submitSelector: 'button[data-testid="send-button"]',
    inputType: 'contenteditable',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    color: '#4285f4',
    inputSelector: '.ql-editor[contenteditable="true"]',
    submitSelector: 'button.send-button, button[aria-label="Send message"]',
    inputType: 'contenteditable',
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    url: 'https://claude.ai/new',
    color: '#d97757',
    inputSelector: '.ProseMirror[contenteditable="true"]',
    submitSelector: 'button[aria-label="Send Message"]',
    inputType: 'contenteditable',
  },
};

// Built-in prompt slots. Order and count must stay identical in every locale so a
// stored prompt index keeps pointing at the same prompt after a language change.
export const DEFAULT_PROMPT_KEYS = Object.freeze([
  'defaultPromptSummarize',
  'defaultPromptTakeaways',
  'defaultPromptEli5',
  'defaultPromptActionItems',
  'defaultPromptCritique',
]);

// English baseline; use getDefaultPrompts() wherever the active locale matters.
export const DEFAULT_PROMPTS = Object.freeze(DEFAULT_PROMPT_KEYS.map((key) => en[key]));

export function getDefaultPrompts() {
  return DEFAULT_PROMPT_KEYS.map((key) => t(key));
}
