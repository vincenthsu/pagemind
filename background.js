// Service Worker — orchestrates content extraction and AI provider navigation
// This file uses ES module syntax (manifest.json: "type": "module")

import { PROVIDERS, DEFAULT_PROMPTS } from './lib/providers.js';

const DEFAULT_MAX_CONTENT_CHARS = 12000;

// --- Context Menus ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'summarize-page',
    title: 'Summarize This Page',
    contexts: ['page', 'frame', 'selection', 'link'],
  });
  chrome.contextMenus.create({
    id: 'open-settings',
    title: 'AI Summarizer Settings',
    contexts: ['page', 'frame', 'selection', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'summarize-page') {
    try {
      const settings = await chrome.storage.sync.get(['defaultProvider', 'defaultPromptIndex']);
      const provider = settings.defaultProvider || 'chatgpt';
      const promptIndex = settings.defaultPromptIndex ?? 0;
      await handleSummarize({ provider, promptIndex });
    } catch (err) {
      console.error('[AI Summarizer] Context menu summarize failed:', err);
    }
  } else if (info.menuItemId === 'open-settings') {
    chrome.runtime.openOptionsPage();
  }
});

// --- Restore main window when companion is closed ---
chrome.windows.onRemoved.addListener(async (closedWindowId) => {
  try {
    const data = await chrome.storage.session.get(['companionWindowId', 'originalWindowBounds']);
    if (data.companionWindowId !== closedWindowId) return;

    // Clear companion tracking
    await chrome.storage.session.remove(['companionWindowId', 'originalWindowBounds']);

    // Restore original window bounds
    const bounds = data.originalWindowBounds;
    if (bounds) {
      await chrome.windows.update(bounds.id, {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        state: 'normal',
      }).catch(() => { });
    }
  } catch { /* non-fatal */ }
});

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

  // Get the selected prompt and settings in one call
  const settings = await chrome.storage.sync.get(['customPrompts', 'openMode', 'autoSubmit', 'includeUrl', 'maxContentChars']);
  const allPrompts = [...(settings.customPrompts || []), ...DEFAULT_PROMPTS];
  const prompt = allPrompts[promptIndex] ?? DEFAULT_PROMPTS[0];
  const autoSubmit = settings.autoSubmit !== undefined ? settings.autoSubmit : true;
  const includeUrl = settings.includeUrl !== undefined ? settings.includeUrl : true;
  const maxContentChars = settings.maxContentChars || DEFAULT_MAX_CONTENT_CHARS;

  // Truncate content if needed
  const truncated = extractedContent.length > maxContentChars
    ? extractedContent.slice(0, maxContentChars) + '\n\n[Content truncated — article is too long]'
    : extractedContent;

  // Build full message: prompt + optional URL + content
  let fullMessage = prompt;
  if (includeUrl && tabUrl) {
    fullMessage += `\n\nSource URL: ${tabUrl}`;
  }
  fullMessage += `\n\n---\n\n${truncated}`;

  // Store payload in session storage (ephemeral, cleared after injection)
  await chrome.storage.session.set({
    pendingPayload: {
      text: fullMessage,
      provider,
      autoSubmit,
      createdAt: Date.now(),
    },
  });

  // Also write to clipboard as fallback (via offscreen document)
  try {
    await writeToClipboard(fullMessage);
  } catch (e) {
    console.warn('[AI Summarizer] Clipboard write failed:', e.message);
  }

  // Check open mode setting
  const openMode = settings.openMode || 'companion';

  if (openMode === 'newtab') {
    await chrome.tabs.create({ url: providerConfig.url, active: true });
  } else {
    await openCompanionWindow(providerConfig.url, activeTab.windowId);
  }

  return { success: true };
}

// --- Companion Window ---
// Resizes the main browser window to make room, then opens the AI provider
// as a full-height popup window snapped to the right edge.
async function openCompanionWindow(url, sourceWindowId) {
  const PANEL_WIDTH = 480;

  let currentWin;
  try {
    currentWin = sourceWindowId
      ? await chrome.windows.get(sourceWindowId)
      : await chrome.windows.getCurrent({ populate: false });
  } catch {
    currentWin = null;
  }

  if (!currentWin || currentWin.left == null) {
    // Fallback: open in a new tab
    await chrome.tabs.create({ url, active: true });
    return;
  }

  // Close any existing companion window first
  try {
    const stored = await chrome.storage.session.get(['companionWindowId']);
    if (stored.companionWindowId) {
      await chrome.windows.remove(stored.companionWindowId).catch(() => { });
      // Small delay to let the window close and onRemoved fire before we overwrite the saved bounds
      await new Promise((r) => setTimeout(r, 150));
      // Re-fetch currentWin in case onRemoved already restored it
      currentWin = await chrome.windows.get(sourceWindowId || currentWin.id).catch(() => currentWin);
    }
  } catch { /* non-fatal */ }

  // Save original bounds so we can restore on companion close
  const originalBounds = {
    id: currentWin.id,
    left: currentWin.left,
    top: currentWin.top,
    width: currentWin.width,
    height: currentWin.height,
  };

  // Shrink the main window to sit beside the companion panel
  const mainWidth = Math.max(400, currentWin.width - PANEL_WIDTH);
  await chrome.windows.update(currentWin.id, {
    state: 'normal',
    left: currentWin.left,
    top: currentWin.top,
    width: mainWidth,
    height: currentWin.height,
  });

  // Open companion panel flush against the right edge of the (now-resized) main window
  const companionLeft = currentWin.left + mainWidth;
  const newWin = await chrome.windows.create({
    url,
    type: 'popup',
    width: PANEL_WIDTH,
    height: currentWin.height,
    left: companionLeft,
    top: currentWin.top,
    focused: true,
  });

  // Persist tracking data
  await chrome.storage.session.set({
    companionWindowId: newWin.id,
    originalWindowBounds: originalBounds,
  });
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
