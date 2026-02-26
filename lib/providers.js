// Central registry for AI provider configuration
// Update selectors here when provider UIs change

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
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    url: 'https://www.perplexity.ai/',
    color: '#20b2aa',
    inputSelector: 'textarea[placeholder]',
    submitSelector: 'button[aria-label="Submit"]',
    inputType: 'textarea',
  },
};

export const DEFAULT_PROMPTS = [
  'Summarize the following content in 5 bullet points:',
  'What are the key takeaways from this content?',
  'Explain this to me like I\'m 5 years old:',
  'Extract all action items and decisions from this content:',
  'Write a critical analysis of:',
  'Translate the following content to Traditional Chinese and summarize:',
];
