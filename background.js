// Service Worker — orchestrates content extraction and AI provider navigation
// This file uses ES module syntax (manifest.json: "type": "module")

import { PROVIDERS, DEFAULT_PROMPTS } from './lib/providers.js';
import {
  normalizeOpenMode,
  resolveToolbarAction,
  getToolbarChromeConfig,
  resolveSummaryDestination,
} from './lib/settings.js';
import {
  CUSTOM_SCRIPT_IDS,
  resolveProviderUrl,
  buildEmbeddingRules,
  buildCustomContentScriptRegistrations,
} from './lib/provider-embedding.js';
import { createPendingPayload, matchPayloadRequest } from './lib/payload-routing.js';

const DEFAULT_MAX_CONTENT_CHARS = 12000;
const MANAGED_RULE_ID_MIN = 1000;
const MANAGED_RULE_ID_MAX = 2000;
const TOOLBAR_SETTING_KEYS = [
  'toolbarAction',
  'quickSummarize',
  'defaultProvider',
  'defaultPromptIndex',
  'openMode',
];

let cachedToolbarSettings = null;
const startupSettingsPromise = chrome.storage.sync.get([...TOOLBAR_SETTING_KEYS, 'customUrls']);
const pendingPayloadClaims = new Set();
let pendingPayloadMutation = Promise.resolve();

async function applyToolbarAction(settings = {}) {
  const toolbarAction = resolveToolbarAction(settings);
  const config = getToolbarChromeConfig(toolbarAction);
  cachedToolbarSettings = { ...(cachedToolbarSettings || {}), ...settings, toolbarAction };

  await Promise.all([
    chrome.action.setPopup({ popup: config.popup }),
    chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: config.openPanelOnActionClick,
    }),
  ]);

  if (settings.toolbarAction !== toolbarAction) {
    await chrome.storage.sync.set({ toolbarAction });
  }
}

async function syncEmbeddingConfiguration(customUrls = {}) {
  const desiredRules = buildEmbeddingRules(chrome.runtime.id, customUrls);
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const managedRuleIds = existingRules
    .filter((rule) => rule.id >= MANAGED_RULE_ID_MIN && rule.id < MANAGED_RULE_ID_MAX)
    .map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: managedRuleIds,
    addRules: desiredRules,
  });

  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [...CUSTOM_SCRIPT_IDS],
  });
  const registeredIds = registered
    .map((item) => item.id)
    .filter((id) => CUSTOM_SCRIPT_IDS.includes(id));
  if (registeredIds.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: registeredIds });
  }

  const desiredScripts = buildCustomContentScriptRegistrations(customUrls);
  if (desiredScripts.length > 0) {
    await chrome.scripting.registerContentScripts(desiredScripts);
  }
}

async function initializeExtension(settingsPromise) {
  const settings = await (settingsPromise
    || chrome.storage.sync.get([...TOOLBAR_SETTING_KEYS, 'customUrls']));
  cachedToolbarSettings = { ...(cachedToolbarSettings || {}), ...settings };
  await Promise.all([
    applyToolbarAction(settings),
    syncEmbeddingConfiguration(settings.customUrls || {}),
  ]);
}

void initializeExtension(startupSettingsPromise).catch((error) => {
  console.error('[PageMind] Initialization failed:', error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  for (const key of TOOLBAR_SETTING_KEYS) {
    if (changes[key]) {
      cachedToolbarSettings = {
        ...(cachedToolbarSettings || {}),
        [key]: changes[key].newValue,
      };
    }
  }

  if (changes.toolbarAction || changes.quickSummarize || changes.openMode) {
    void chrome.storage.sync.get(TOOLBAR_SETTING_KEYS)
      .then(applyToolbarAction)
      .catch((error) => console.error('[PageMind] Toolbar update failed:', error));
  }
  if (changes.openMode) {
    void createContextMenus(changes.openMode.newValue)
      .catch((error) => console.error('[PageMind] Context menu update failed:', error));
  }
  if (changes.customUrls) {
    void syncEmbeddingConfiguration(changes.customUrls.newValue || {})
      .catch((error) => console.error('[PageMind] Embedding update failed:', error));
  }
});

function startDirectSummaryFromAction(tab, settings) {
  const toolbarAction = resolveToolbarAction(settings);
  if (!getToolbarChromeConfig(toolbarAction).directSummarize) return;

  const sourceWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : undefined;
  const destination = normalizeOpenMode(settings.openMode);
  let panelOpen = Promise.resolve();
  if (destination === 'sidepanel') {
    try {
      panelOpen = chrome.sidePanel.open({
        windowId: sourceWindowId ?? chrome.windows.WINDOW_ID_CURRENT,
      });
    } catch (error) {
      console.error('[PageMind] Direct summarize failed:', error);
      return;
    }
  }

  void panelOpen.then(() => handleSummarize({
    provider: settings.defaultProvider || 'chatgpt',
    promptIndex: settings.defaultPromptIndex ?? 0,
    sourceWindowId,
    source: 'toolbar',
    destination,
  })).catch((error) => {
    console.error('[PageMind] Direct summarize failed:', error);
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (cachedToolbarSettings) {
    startDirectSummaryFromAction(tab, cachedToolbarSettings);
    return;
  }

  // Chrome extension API callbacks inherit the user gesture present when the
  // API was invoked, so this cold-worker lookup must start inside onClicked.
  chrome.storage.sync.get(TOOLBAR_SETTING_KEYS, (settings) => {
    if (chrome.runtime.lastError) {
      console.error('[PageMind] Toolbar settings failed:', chrome.runtime.lastError.message);
      return;
    }
    startDirectSummaryFromAction(tab, settings);
  });
});

// --- Context Menus ---
const SUMMARY_MENU_DESTINATIONS = new Map([
  ['summarize-page-sidepanel', 'sidepanel'],
  ['summarize-page-companion', 'companion'],
  ['summarize-page-newtab', 'newtab'],
]);

async function createContextMenus(configuredOpenMode) {
  let destination = configuredOpenMode;
  if (destination === undefined) {
    const settings = await chrome.storage.sync.get(['openMode']);
    destination = settings.openMode;
  }
  destination = normalizeOpenMode(destination);

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: `summarize-page-${destination}`,
    title: 'Summarize This Page',
    contexts: ['page', 'frame', 'selection', 'link'],
  });
  chrome.contextMenus.create({
    id: 'open-side-panel',
    title: 'Open PageMind Side Panel',
    contexts: ['page', 'frame', 'selection', 'link'],
  });
  chrome.contextMenus.create({
    id: 'open-settings',
    title: 'PageMind Settings',
    contexts: ['page', 'frame', 'selection', 'link'],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension().catch((error) => {
    console.error('[PageMind] Install initialization failed:', error);
  });
  void createContextMenus().catch((error) => {
    console.error('[PageMind] Context menu setup failed:', error);
  });
});

async function summarizeFromContextMenu(info, tab, destination, panelOpen) {
  try {
    const sourceWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : undefined;
    await panelOpen;
    const settings = await chrome.storage.sync.get([
      'defaultProvider',
      'defaultPromptIndex',
    ]);
    await handleSummarize({
      provider: settings.defaultProvider || 'chatgpt',
      promptIndex: settings.defaultPromptIndex ?? 0,
      selectedText: typeof info.selectionText === 'string' ? info.selectionText.trim() : '',
      sourceWindowId,
      source: 'context-menu',
      destination,
    });
  } catch (error) {
    console.error('[PageMind] Context menu action failed:', error);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const sourceWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : undefined;
  if (info?.menuItemId === 'open-side-panel') {
    try {
      void chrome.sidePanel.open({
        windowId: sourceWindowId ?? chrome.windows.WINDOW_ID_CURRENT,
      }).catch((error) => console.error('[PageMind] Side panel open failed:', error));
    } catch (error) {
      console.error('[PageMind] Side panel open failed:', error);
    }
    return;
  }
  if (info?.menuItemId === 'open-settings') {
    void chrome.runtime.openOptionsPage()
      .catch((error) => console.error('[PageMind] Settings open failed:', error));
    return;
  }

  const destination = SUMMARY_MENU_DESTINATIONS.get(info?.menuItemId);
  if (!destination) return;

  let panelOpen = Promise.resolve();
  if (destination === 'sidepanel') {
    try {
      panelOpen = chrome.sidePanel.open({
        windowId: sourceWindowId ?? chrome.windows.WINDOW_ID_CURRENT,
      });
    } catch (error) {
      console.error('[PageMind] Context menu action failed:', error);
      return;
    }
  }
  void summarizeFromContextMenu(info, tab, destination, panelOpen);
});

// --- Restore main window when companion is closed ---
chrome.windows.onRemoved.addListener(async (closedWindowId) => {
  try {
    const data = await chrome.storage.session.get(['companionWindowId', 'originalWindowBounds']);
    if (data.companionWindowId !== closedWindowId) return;

    await chrome.storage.session.remove(['companionWindowId', 'originalWindowBounds']);
    const bounds = data.originalWindowBounds;
    if (bounds) {
      await chrome.windows.update(bounds.id, {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        state: 'normal',
      }).catch(() => {});
    }
  } catch {
    // Non-fatal: companion cleanup should not break the service worker.
  }
});

function sendAsyncResponse(promise, sendResponse) {
  promise
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error?.message || String(error) }));
  return true;
}

function serializePendingPayloadMutation(operation) {
  const result = pendingPayloadMutation.then(operation, operation);
  pendingPayloadMutation = result.then(() => undefined, () => undefined);
  return result;
}

function storePendingPayload(payload) {
  return serializePendingPayloadMutation(() => (
    chrome.storage.session.set({ pendingPayload: payload })
  ));
}

function removePendingPayloadIfExpected(expectedId) {
  if (typeof expectedId !== 'string' || expectedId.length === 0) return Promise.resolve(false);
  return serializePendingPayloadMutation(async () => {
    const { pendingPayload } = await chrome.storage.session.get(['pendingPayload']);
    if (pendingPayload?.id !== expectedId) return false;
    await chrome.storage.session.remove(['pendingPayload']);
    return true;
  });
}

function isPendingPayloadCurrent(expectedId) {
  if (typeof expectedId !== 'string' || expectedId.length === 0) return Promise.resolve(false);
  return serializePendingPayloadMutation(async () => {
    const { pendingPayload } = await chrome.storage.session.get(['pendingPayload']);
    return pendingPayload?.id === expectedId;
  });
}

async function consumePendingPayload(message, sender) {
  const { pendingPayload } = await chrome.storage.session.get(['pendingPayload']);
  if (message.context === 'tab' && sender.frameId !== 0) {
    return { payload: null };
  }
  if (message.context === 'sidepanel' && !isTrustedSidePanelSender(sender)) {
    return { payload: null };
  }
  const request = {
    provider: typeof message.provider === 'string' ? message.provider : '',
    context: message.context,
    windowId: Number.isInteger(message.windowId) ? message.windowId : undefined,
    tabId: Number.isInteger(sender.tab?.id) ? sender.tab.id : undefined,
  };
  const result = matchPayloadRequest(pendingPayload, request);

  if (result.expired) {
    await removePendingPayloadIfExpected(pendingPayload?.id);
  }
  if (!result.matched) return { payload: null };

  if (pendingPayloadClaims.has(pendingPayload.id)) return { payload: null };
  pendingPayloadClaims.add(pendingPayload.id);
  try {
    const removed = await removePendingPayloadIfExpected(pendingPayload.id);
    return { payload: removed ? pendingPayload : null };
  } finally {
    pendingPayloadClaims.delete(pendingPayload.id);
  }
}

function isTrustedSidePanelSender(sender) {
  if (sender.tab || typeof sender.url !== 'string') return false;
  try {
    const senderUrl = new URL(sender.url);
    const sidePanelUrl = new URL(chrome.runtime.getURL('sidepanel.html'));
    return senderUrl.origin === sidePanelUrl.origin && senderUrl.pathname === sidePanelUrl.pathname;
  } catch {
    return false;
  }
}

async function getPendingPanelProvider(message) {
  const { pendingPayload } = await chrome.storage.session.get(['pendingPayload']);
  if (!Number.isInteger(message.windowId) || pendingPayload?.target?.kind !== 'sidepanel') {
    return { provider: null };
  }

  const result = matchPayloadRequest(pendingPayload, {
    provider: pendingPayload.provider,
    context: 'sidepanel',
    windowId: message.windowId,
  });
  if (result.expired) {
    await removePendingPayloadIfExpected(pendingPayload?.id);
  }
  if (!result.matched) return { provider: null };
  const isCurrent = await isPendingPayloadCurrent(pendingPayload.id);
  return { provider: isCurrent ? pendingPayload.provider : null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;

  if (message.type === 'SUMMARIZE') {
    return sendAsyncResponse(handleSummarize(message), sendResponse);
  }
  if (message.type === 'GET_PAYLOAD') {
    return sendAsyncResponse(consumePendingPayload(message, sender), sendResponse);
  }
  if (message.type === 'PANEL_READY') {
    return sendAsyncResponse(getPendingPanelProvider(message), sendResponse);
  }

  // PANEL_NAVIGATE is intentionally handled by the side-panel shell.
  return false;
});

async function handleSummarize({
  provider,
  promptIndex,
  selectedText = '',
  sourceWindowId,
  source,
  destination,
}) {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) {
    throw new Error(`Unknown provider: ${String(provider)}`);
  }

  const query = { active: true };
  if (Number.isInteger(sourceWindowId)) query.windowId = sourceWindowId;
  else query.currentWindow = true;
  const [activeTab] = await chrome.tabs.query(query);
  if (!Number.isInteger(activeTab?.id)) throw new Error('No active tab found');

  const tabUrl = typeof activeTab.url === 'string' ? activeTab.url : '';
  const isYouTube = tabUrl.includes('youtube.com/watch');
  let extractedContent;
  let finalSelectedText = typeof selectedText === 'string' ? selectedText.trim() : '';

  if (!finalSelectedText) {
    try {
      const selResults = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id, allFrames: true },
        func: () => window.getSelection().toString().trim(),
      });
      finalSelectedText = selResults
        .map((result) => result.result)
        .filter((value) => typeof value === 'string' && value)
        .join('\n\n')
        .trim();
    } catch {
      // Selection access is best-effort; page extraction still works without it.
    }
  }

  if (finalSelectedText) {
    extractedContent = `[Selected text from: ${activeTab.title || tabUrl}]\n\n${finalSelectedText}`;
  } else if (isYouTube) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content/youtube.js'],
      world: 'MAIN',
    });
    const result = results[0]?.result;
    if (result?.content) {
      extractedContent = result.content;
    } else if (result?.error) {
      extractedContent = `YouTube Video: ${activeTab.title || 'Unknown'}\n\n[${result.error}]`;
    } else {
      extractedContent = `YouTube Video: ${activeTab.title || 'Unknown'}\n\n[Could not extract transcript]`;
    }
  } else {
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
      extractedContent = `Page: ${activeTab.title || tabUrl}\n\n[Could not extract page content]`;
    }
  }

  if (typeof extractedContent !== 'string') {
    extractedContent = String(extractedContent ?? '');
  }

  const settings = await chrome.storage.sync.get([
    'customPrompts',
    'customUrls',
    'openMode',
    'autoSubmit',
    'includeUrl',
    'maxContentChars',
  ]);
  const allPrompts = [...(Array.isArray(settings.customPrompts) ? settings.customPrompts : []), ...DEFAULT_PROMPTS];
  const safePromptIndex = Number.isInteger(promptIndex) ? promptIndex : 0;
  const prompt = allPrompts[safePromptIndex] ?? DEFAULT_PROMPTS[0];
  const autoSubmit = settings.autoSubmit !== undefined ? settings.autoSubmit : true;
  const includeUrl = settings.includeUrl !== undefined ? settings.includeUrl : true;
  const maxContentChars = Number.isInteger(settings.maxContentChars) && settings.maxContentChars > 0
    ? settings.maxContentChars
    : DEFAULT_MAX_CONTENT_CHARS;
  const customUrls = settings.customUrls && typeof settings.customUrls === 'object'
    ? settings.customUrls
    : {};

  const truncated = extractedContent.length > maxContentChars
    ? `${extractedContent.slice(0, maxContentChars)}\n\n[Content truncated — article is too long]`
    : extractedContent;
  let fullMessage = prompt;
  if (includeUrl && tabUrl) fullMessage += `\n\nSource URL: ${tabUrl}`;
  fullMessage += `\n\n---\n\n${truncated}`;

  try {
    await writeToClipboard(fullMessage);
  } catch (error) {
    console.warn('[PageMind] Clipboard write failed:', error?.message || String(error));
  }

  const requestedDestination = resolveSummaryDestination(
    destination ?? settings.openMode,
    source,
  );
  const finalUrl = resolveProviderUrl(provider, customUrls);

  if (requestedDestination === 'sidepanel') {
    const windowId = Number.isInteger(sourceWindowId) ? sourceWindowId : activeTab.windowId;
    if (!Number.isInteger(windowId)) throw new Error('Side panel destination requires a window');
    const payload = createPendingPayload({
      id: crypto.randomUUID(),
      text: fullMessage,
      provider,
      autoSubmit,
      target: { kind: 'sidepanel', windowId },
    });
    await storePendingPayload(payload);
    await chrome.runtime.sendMessage({
      type: 'PANEL_NAVIGATE',
      windowId,
      provider,
      url: finalUrl,
    }).catch(() => {});
    return { success: true, destination: 'sidepanel', provider, url: finalUrl };
  }

  let targetTabId;
  if (requestedDestination === 'newtab') {
    const targetTab = await chrome.tabs.create({ url: finalUrl, active: true });
    targetTabId = targetTab?.id;
  } else {
    const companion = await openCompanionWindow(finalUrl, activeTab.windowId);
    targetTabId = companion?.tabs?.find((tab) => Number.isInteger(tab.id))?.id;
    if (!Number.isInteger(targetTabId) && Number.isInteger(companion?.id)) {
      const tabs = await chrome.tabs.query({ windowId: companion.id });
      targetTabId = tabs.find((tab) => Number.isInteger(tab.id))?.id;
    }
  }

  if (!Number.isInteger(targetTabId)) throw new Error('Provider tab was not created');
  const payload = createPendingPayload({
    id: crypto.randomUUID(),
    text: fullMessage,
    provider,
    autoSubmit,
    target: { kind: 'tab', tabId: targetTabId },
  });
  await storePendingPayload(payload);
  return { success: true, destination: requestedDestination, provider, url: finalUrl };
}

// --- Companion Window ---
async function openCompanionWindow(url, sourceWindowId) {
  const PANEL_WIDTH = 480;
  let currentWin;
  try {
    currentWin = Number.isInteger(sourceWindowId)
      ? await chrome.windows.get(sourceWindowId)
      : await chrome.windows.getCurrent({ populate: false });
  } catch {
    currentWin = null;
  }

  if (!currentWin || currentWin.left == null || currentWin.width == null) {
    const tab = await chrome.tabs.create({ url, active: true });
    return {
      id: Number.isInteger(tab?.windowId) ? tab.windowId : undefined,
      tabs: tab ? [tab] : [],
    };
  }

  try {
    const stored = await chrome.storage.session.get(['companionWindowId']);
    if (Number.isInteger(stored.companionWindowId)) {
      await chrome.windows.remove(stored.companionWindowId).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
      currentWin = await chrome.windows
        .get(sourceWindowId ?? currentWin.id)
        .catch(() => currentWin);
    }
  } catch {
    // Existing companion cleanup is best-effort.
  }

  const originalBounds = {
    id: currentWin.id,
    left: currentWin.left,
    top: currentWin.top,
    width: currentWin.width,
    height: currentWin.height,
  };
  const mainWidth = Math.max(400, currentWin.width - PANEL_WIDTH);
  await chrome.windows.update(currentWin.id, {
    state: 'normal',
    left: currentWin.left,
    top: currentWin.top,
    width: mainWidth,
    height: currentWin.height,
  });

  const newWin = await chrome.windows.create({
    url,
    type: 'popup',
    width: PANEL_WIDTH,
    height: currentWin.height,
    left: currentWin.left + mainWidth,
    top: currentWin.top,
    focused: true,
  });
  if (!Number.isInteger(newWin?.id)) throw new Error('Companion window was not created');

  await chrome.storage.session.set({
    companionWindowId: newWin.id,
    originalWindowBounds: originalBounds,
  });
  return newWin;
}

// --- Clipboard via Offscreen Document ---
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
      },
    );
  });
}
