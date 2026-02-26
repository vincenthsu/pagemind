// Service Worker — orchestrates content extraction and AI provider navigation
// This file uses ES module syntax (manifest.json: "type": "module")

import { PROVIDERS, DEFAULT_PROMPTS } from './lib/providers.js';

const MAX_CONTENT_CHARS = 12000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SUMMARIZE') {
    handleSummarize(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep message channel open for async response
  }

  if (message.type === 'GET_PAYLOAD') {
    // Called by injector content scripts to retrieve the pending payload
    chrome.storage.session.get(['pendingPayload'], (data) => {
      const payload = data.pendingPayload || null;
      // Clear immediately — one-shot delivery
      if (payload) {
        chrome.storage.session.remove(['pendingPayload']);
      }
      sendResponse({ payload });
    });
    return true;
  }
});

async function handleSummarize({ provider, promptIndex }) {
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) throw new Error('Unknown provider: ' + provider);

  // Get the active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) throw new Error('No active tab found');

  const tabUrl = activeTab.url || '';
  const isYouTube = tabUrl.includes('youtube.com/watch');

  let extractedContent;

  if (isYouTube) {
    // Inject YouTube transcript extractor
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content/youtube.js'],
    });
    extractedContent = results[0]?.result;
    if (!extractedContent) {
      const title = activeTab.title || 'Unknown Video';
      extractedContent = `YouTube Video: ${title}\nURL: ${tabUrl}\n\n[Could not extract transcript — please summarize based on the title and URL]`;
    }
  } else {
    // Inject Readability first (provides global Readability class), then extractor
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['lib/readability.js'],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content/extractor.js'],
    });
    extractedContent = results[0]?.result;
    if (!extractedContent) {
      extractedContent = `Page: ${activeTab.title}\nURL: ${tabUrl}\n\n[Could not extract page content]`;
    }
  }

  // Get the selected prompt
  const settings = await chrome.storage.sync.get(['customPrompts']);
  const allPrompts = [...(settings.customPrompts || []), ...DEFAULT_PROMPTS];
  const prompt = allPrompts[promptIndex] ?? DEFAULT_PROMPTS[0];

  // Truncate content if needed
  const truncated = extractedContent.length > MAX_CONTENT_CHARS
    ? extractedContent.slice(0, MAX_CONTENT_CHARS) + '\n\n[Content truncated — article is too long]'
    : extractedContent;

  const fullMessage = `${prompt}\n\n---\n\n${truncated}`;

  // Store payload in session storage (ephemeral, cleared after injection)
  await chrome.storage.session.set({
    pendingPayload: {
      text: fullMessage,
      provider,
      createdAt: Date.now(),
    },
  });

  // Also write to clipboard as fallback (via offscreen document)
  try {
    await writeToClipboard(fullMessage);
  } catch (e) {
    // Non-fatal — clipboard is just a convenience fallback
    console.warn('[AI Summarizer] Clipboard write failed:', e.message);
  }

  // Open the AI provider in a new tab
  await chrome.tabs.create({ url: providerConfig.url, active: true });

  return { success: true };
}

// --- Clipboard via Offscreen Document ---
// MV3 service workers can't access navigator.clipboard — use an offscreen doc
async function writeToClipboard(text) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  }).catch(() => []);

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen/offscreen.html'),
      reasons: ['CLIPBOARD'],
      justification: 'Copy extracted page content to clipboard as fallback',
    });
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'WRITE_CLIPBOARD', text, target: 'offscreen' },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve();
        }
      }
    );
  });
}
