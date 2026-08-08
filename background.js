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
const MAX_PENDING_PAYLOAD_ROUTES = 32;
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
let toolbarSettingsCacheReady = false;
const startupSettingsPromise = chrome.storage.sync.get([...TOOLBAR_SETTING_KEYS, 'customUrls']);
let pendingPayloadMutation = Promise.resolve();
let toolbarSettingsRevision = 0;
let latestScheduledToolbarRevision = -1;
let latestToolbarSettings = {};
let toolbarApplyGeneration = 0;
let toolbarApplyPromise = null;
let openModeRevision = 0;
let latestScheduledMenuRevision = -1;
let latestMenuOpenMode;
let menuApplyGeneration = 0;
let menuApplyPromise = null;
let latestEmbeddingCustomUrls = {};
let embeddingRefreshGeneration = 0;
let embeddingRefreshPromise = null;
let embeddingSettingsRevision = 0;
let latestScheduledEmbeddingRevision = -1;
let nextSummarizeInvocationSequence = 0;
const sidePanelInvocationSequences = new Map();

async function applyToolbarAction(
  settings = {},
  isCurrent = () => true,
  forceToolbarActionPersistence = false,
) {
  const toolbarAction = resolveToolbarAction(settings);
  const config = getToolbarChromeConfig(toolbarAction);

  const chromeResults = await Promise.allSettled([
    chrome.action.setPopup({ popup: config.popup }),
    chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: config.openPanelOnActionClick,
    }),
  ]);
  const failedChromeOperation = chromeResults.find((result) => result.status === 'rejected');
  if (failedChromeOperation) throw failedChromeOperation.reason;

  let persistedToolbarAction = false;
  if (isCurrent()
    && (forceToolbarActionPersistence || settings.toolbarAction !== toolbarAction)) {
    await chrome.storage.sync.set({ toolbarAction });
    persistedToolbarAction = true;
  }
  return { persistedToolbarAction };
}

function scheduleToolbarAction(settings = {}, settingsRevision = toolbarSettingsRevision) {
  if (settingsRevision < toolbarSettingsRevision
    || settingsRevision < latestScheduledToolbarRevision) {
    return toolbarApplyPromise || Promise.resolve();
  }
  latestScheduledToolbarRevision = settingsRevision;
  latestToolbarSettings = settings && typeof settings === 'object' ? { ...settings } : {};
  toolbarApplyGeneration += 1;

  if (!toolbarApplyPromise) {
    toolbarApplyPromise = (async () => {
      let completedGeneration = 0;
      let forceToolbarActionPersistence = false;
      while (completedGeneration < toolbarApplyGeneration) {
        const requestedGeneration = toolbarApplyGeneration;
        const requestedSettings = latestToolbarSettings;
        const toolbarAction = resolveToolbarAction(requestedSettings);
        cachedToolbarSettings = {
          ...(cachedToolbarSettings || {}),
          ...requestedSettings,
          toolbarAction,
        };
        toolbarSettingsCacheReady = true;
        try {
          const persistenceWasRequired = forceToolbarActionPersistence;
          const result = await applyToolbarAction(
            requestedSettings,
            () => requestedGeneration === toolbarApplyGeneration,
            forceToolbarActionPersistence,
          );
          const requestIsCurrent = requestedGeneration === toolbarApplyGeneration;
          forceToolbarActionPersistence = persistenceWasRequired
            ? !(result.persistedToolbarAction && requestIsCurrent)
            : result.persistedToolbarAction && !requestIsCurrent;
        } catch (error) {
          completedGeneration = requestedGeneration;
          if (requestedGeneration >= toolbarApplyGeneration) throw error;
          continue;
        }
        completedGeneration = requestedGeneration;
      }
    })().finally(() => {
      toolbarApplyPromise = null;
    });
  }

  return toolbarApplyPromise;
}

function scheduleContextMenus(openMode, menuRevision = openModeRevision) {
  if (menuRevision < openModeRevision || menuRevision < latestScheduledMenuRevision) {
    return menuApplyPromise || Promise.resolve();
  }
  latestScheduledMenuRevision = menuRevision;
  latestMenuOpenMode = openMode;
  menuApplyGeneration += 1;

  if (!menuApplyPromise) {
    menuApplyPromise = (async () => {
      let completedGeneration = 0;
      while (completedGeneration < menuApplyGeneration) {
        const requestedGeneration = menuApplyGeneration;
        const requestedOpenMode = latestMenuOpenMode;
        try {
          await createContextMenus(
            requestedOpenMode,
            () => requestedGeneration === menuApplyGeneration,
          );
        } catch (error) {
          completedGeneration = requestedGeneration;
          if (requestedGeneration >= menuApplyGeneration) throw error;
          continue;
        }
        completedGeneration = requestedGeneration;
      }
    })().finally(() => {
      menuApplyPromise = null;
    });
  }

  return menuApplyPromise;
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

function scheduleEmbeddingConfiguration(customUrls = {}, settingsRevision = embeddingSettingsRevision) {
  if (settingsRevision < latestScheduledEmbeddingRevision) {
    return embeddingRefreshPromise || Promise.resolve();
  }
  latestScheduledEmbeddingRevision = settingsRevision;
  latestEmbeddingCustomUrls = customUrls && typeof customUrls === 'object'
    ? { ...customUrls }
    : {};
  embeddingRefreshGeneration += 1;

  if (!embeddingRefreshPromise) {
    embeddingRefreshPromise = (async () => {
      let completedGeneration = 0;
      while (completedGeneration < embeddingRefreshGeneration) {
        const requestedGeneration = embeddingRefreshGeneration;
        const requestedCustomUrls = latestEmbeddingCustomUrls;
        try {
          await syncEmbeddingConfiguration(requestedCustomUrls);
        } catch (error) {
          completedGeneration = requestedGeneration;
          if (requestedGeneration >= embeddingRefreshGeneration) throw error;
          continue;
        }
        completedGeneration = requestedGeneration;
      }
    })().finally(() => {
      embeddingRefreshPromise = null;
    });
  }

  return embeddingRefreshPromise;
}

async function initializeExtension(settingsPromise, { initializeMenus = false } = {}) {
  const requestedToolbarRevision = toolbarSettingsRevision;
  const requestedMenuRevision = openModeRevision;
  const requestedEmbeddingRevision = embeddingSettingsRevision;
  const settings = await (settingsPromise
    || chrome.storage.sync.get([...TOOLBAR_SETTING_KEYS, 'customUrls']));
  const operations = [
    scheduleToolbarAction(settings, requestedToolbarRevision),
    scheduleEmbeddingConfiguration(settings.customUrls || {}, requestedEmbeddingRevision),
  ];
  if (initializeMenus) {
    operations.push(scheduleContextMenus(settings.openMode, requestedMenuRevision));
  }
  await Promise.all(operations);
}

void initializeExtension(startupSettingsPromise).catch((error) => {
  console.error('[PageMind] Initialization failed:', error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  const changedToolbarKeys = TOOLBAR_SETTING_KEYS.filter((key) => changes[key]);
  if (changedToolbarKeys.length > 0) {
    toolbarSettingsRevision += 1;
    const requestedToolbarRevision = toolbarSettingsRevision;
    cachedToolbarSettings = changedToolbarKeys.reduce((settings, key) => ({
      ...settings,
      [key]: changes[key].newValue,
    }), cachedToolbarSettings || {});
    void chrome.storage.sync.get(TOOLBAR_SETTING_KEYS)
      .then((settings) => scheduleToolbarAction(settings, requestedToolbarRevision))
      .catch((error) => console.error('[PageMind] Toolbar update failed:', error));
  }
  if (changes.openMode) {
    openModeRevision += 1;
    void scheduleContextMenus(changes.openMode.newValue, openModeRevision)
      .catch((error) => console.error('[PageMind] Context menu update failed:', error));
  }
  if (changes.customUrls) {
    embeddingSettingsRevision += 1;
    void scheduleEmbeddingConfiguration(changes.customUrls.newValue || {}, embeddingSettingsRevision)
      .catch((error) => console.error('[PageMind] Embedding update failed:', error));
  }
});

function startDirectSummaryFromAction(tab, settings) {
  const toolbarAction = resolveToolbarAction(settings);
  if (!getToolbarChromeConfig(toolbarAction).directSummarize) return;

  const sourceWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : undefined;
  const sourceTabId = Number.isInteger(tab?.id) ? tab.id : undefined;
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
    sourceTabId,
    sourceWindowId,
    source: 'toolbar',
    destination,
  })).catch((error) => {
    console.error('[PageMind] Direct summarize failed:', error);
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (toolbarSettingsCacheReady && cachedToolbarSettings) {
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

async function createContextMenus(configuredOpenMode, isCurrent = () => true) {
  let destination = configuredOpenMode;
  if (destination === undefined) {
    const settings = await chrome.storage.sync.get(['openMode']);
    destination = settings.openMode;
  }
  destination = normalizeOpenMode(destination);

  await chrome.contextMenus.removeAll();
  if (!isCurrent()) return;
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
  void initializeExtension(undefined, { initializeMenus: true }).catch((error) => {
    console.error('[PageMind] Install initialization failed:', error);
  });
});

async function summarizeFromContextMenu(info, tab, destination, panelOpen) {
  try {
    const sourceWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : undefined;
    const sourceTabId = Number.isInteger(tab?.id) ? tab.id : undefined;
    await panelOpen;
    const settings = await chrome.storage.sync.get([
      'defaultProvider',
      'defaultPromptIndex',
    ]);
    await handleSummarize({
      provider: settings.defaultProvider || 'chatgpt',
      promptIndex: settings.defaultPromptIndex ?? 0,
      selectedText: typeof info.selectionText === 'string' ? info.selectionText.trim() : '',
      sourceTabId,
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
  sidePanelInvocationSequences.delete(closedWindowId);
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

function payloadRouteKey(target) {
  if (target?.kind === 'tab' && Number.isInteger(target.tabId)) return `tab:${target.tabId}`;
  if (target?.kind === 'sidepanel' && Number.isInteger(target.windowId)) {
    return `sidepanel:${target.windowId}`;
  }
  return null;
}

function requestRouteKey(request) {
  if (request?.context === 'tab' && Number.isInteger(request.tabId)) return `tab:${request.tabId}`;
  if (request?.context === 'sidepanel' && Number.isInteger(request.windowId)) {
    return `sidepanel:${request.windowId}`;
  }
  return null;
}

function payloadRequest(payload) {
  if (payload?.target?.kind === 'tab') {
    return { provider: payload.provider, context: 'tab', tabId: payload.target.tabId };
  }
  return {
    provider: payload?.provider,
    context: 'sidepanel',
    windowId: payload?.target?.windowId,
  };
}

async function readPendingPayloadRoutes(now = Date.now()) {
  const data = await chrome.storage.session.get(['pendingPayloads', 'pendingPayload']);
  const routes = {};
  let dirty = data.pendingPayload !== undefined;

  if (data.pendingPayloads && typeof data.pendingPayloads === 'object' && !Array.isArray(data.pendingPayloads)) {
    for (const payload of Object.values(data.pendingPayloads)) {
      const key = payloadRouteKey(payload?.target);
      if (!key || matchPayloadRequest(payload, payloadRequest(payload), now).expired) {
        dirty = true;
        continue;
      }
      routes[key] = payload;
    }
  } else if (data.pendingPayloads !== undefined) {
    dirty = true;
  }

  if (data.pendingPayload) {
    const legacyKey = payloadRouteKey(data.pendingPayload.target);
    if (legacyKey
      && !routes[legacyKey]
      && !matchPayloadRequest(data.pendingPayload, payloadRequest(data.pendingPayload), now).expired) {
      routes[legacyKey] = data.pendingPayload;
    }
  }
  return { dirty, hadLegacy: data.pendingPayload !== undefined, routes };
}

async function persistPendingPayloadRoutes(state) {
  await chrome.storage.session.set({ pendingPayloads: state.routes });
  if (state.hadLegacy) await chrome.storage.session.remove(['pendingPayload']);
}

async function removePendingPayloadRouteFromStorage(payload) {
  const key = payloadRouteKey(payload?.target);
  if (!key) return false;
  const state = await readPendingPayloadRoutes();
  if (state.routes[key]?.id !== payload.id) {
    if (state.dirty) await persistPendingPayloadRoutes(state);
    return false;
  }
  delete state.routes[key];
  state.dirty = true;
  await persistPendingPayloadRoutes(state);
  return true;
}

function removePendingPayloadRouteIfExpected(payload) {
  return serializePendingPayloadMutation(() => removePendingPayloadRouteFromStorage(payload));
}

function capPendingPayloadRoutes(routes, protectedKey) {
  const excess = Object.keys(routes).length - MAX_PENDING_PAYLOAD_ROUTES;
  if (excess <= 0) return;
  const oldestKeys = Object.entries(routes)
    .filter(([key]) => key !== protectedKey)
    .sort(([leftKey, left], [rightKey, right]) => (
      left.createdAt - right.createdAt || leftKey.localeCompare(rightKey)
    ))
    .slice(0, excess)
    .map(([key]) => key);
  for (const key of oldestKeys) delete routes[key];
}

function storePendingPayload(payload, isCurrent) {
  return serializePendingPayloadMutation(async () => {
    if (isCurrent && !isCurrent()) return false;
    const state = await readPendingPayloadRoutes();
    if (isCurrent && !isCurrent()) return false;
    const key = payloadRouteKey(payload.target);
    state.routes[key] = payload;
    capPendingPayloadRoutes(state.routes, key);
    await persistPendingPayloadRoutes(state);
    if (isCurrent && !isCurrent()) {
      await removePendingPayloadRouteFromStorage(payload);
      return false;
    }
    return true;
  });
}

function registerSidePanelInvocation(windowId, invocationSequence) {
  const currentSequence = sidePanelInvocationSequences.get(windowId);
  if (Number.isInteger(currentSequence) && currentSequence >= invocationSequence) return false;
  sidePanelInvocationSequences.set(windowId, invocationSequence);
  return true;
}

function isCurrentSidePanelInvocation(windowId, invocationSequence) {
  return sidePanelInvocationSequences.get(windowId) === invocationSequence;
}

async function consumePendingPayload(message, sender) {
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
  return serializePendingPayloadMutation(async () => {
    const snapshot = await readPendingPayloadRoutes();
    const key = requestRouteKey(request);
    const snapshotPayload = key ? snapshot.routes[key] : null;
    const snapshotResult = matchPayloadRequest(snapshotPayload, request);

    // Re-read immediately before mutation so an entry written after the first
    // snapshot is never removed or delivered as the older route payload.
    const state = await readPendingPayloadRoutes();
    const payload = key ? state.routes[key] : null;
    const result = snapshotResult.matched
      ? matchPayloadRequest(payload, request)
      : { matched: false, expired: false };
    if (snapshotResult.matched && result.matched && payload.id === snapshotPayload.id) {
      delete state.routes[key];
      state.dirty = true;
    }
    if (state.dirty) await persistPendingPayloadRoutes(state);
    return {
      payload: snapshotResult.matched && result.matched && payload.id === snapshotPayload.id
        ? payload
        : null,
    };
  });
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

async function getPendingPanelProvider(message, sender) {
  if (!isTrustedSidePanelSender(sender) || !Number.isInteger(message.windowId)) {
    return { provider: null };
  }
  return serializePendingPayloadMutation(async () => {
    await readPendingPayloadRoutes();
    // PANEL_READY also revalidates after its first snapshot so it cannot
    // reveal or clean up a route that has since been superseded.
    const state = await readPendingPayloadRoutes();
    const payload = state.routes[`sidepanel:${message.windowId}`];
    if (state.dirty) await persistPendingPayloadRoutes(state);
    return { provider: payload?.provider || null };
  });
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
    return sendAsyncResponse(getPendingPanelProvider(message, sender), sendResponse);
  }

  // PANEL_NAVIGATE is intentionally handled by the side-panel shell.
  return false;
});

async function handleSummarize({
  provider,
  promptIndex,
  selectedText = '',
  sourceTabId,
  sourceWindowId,
  source,
  destination,
}) {
  nextSummarizeInvocationSequence += 1;
  const invocationSequence = nextSummarizeInvocationSequence;

  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) {
    throw new Error(`Unknown provider: ${String(provider)}`);
  }

  let activeTab;
  if (Number.isInteger(sourceTabId)) {
    activeTab = await chrome.tabs.get(sourceTabId);
    if (Number.isInteger(sourceWindowId) && activeTab?.windowId !== sourceWindowId) {
      throw new Error('Source tab does not belong to the source window');
    }
  } else {
    const query = { active: true };
    if (Number.isInteger(sourceWindowId)) query.windowId = sourceWindowId;
    else query.currentWindow = true;
    [activeTab] = await chrome.tabs.query(query);
  }
  if (!Number.isInteger(activeTab?.id)) throw new Error('No active tab found');

  const tabUrl = typeof activeTab.url === 'string' ? activeTab.url : '';
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
  const requestedDestination = resolveSummaryDestination(
    destination ?? settings.openMode,
    source,
  );
  const finalUrl = resolveProviderUrl(provider, customUrls);
  const supersededResult = {
    success: true,
    superseded: true,
    destination: 'sidepanel',
    provider,
    url: finalUrl,
  };
  let sidePanelInvocation;
  if (requestedDestination === 'sidepanel') {
    const windowId = Number.isInteger(sourceWindowId) ? sourceWindowId : activeTab.windowId;
    if (!Number.isInteger(windowId)) throw new Error('Side panel destination requires a window');
    const registered = registerSidePanelInvocation(windowId, invocationSequence);
    sidePanelInvocation = {
      windowId,
      invocationSequence,
      isCurrent: () => isCurrentSidePanelInvocation(windowId, invocationSequence),
    };
    if (!registered) return supersededResult;
  }
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

  const truncated = extractedContent.length > maxContentChars
    ? `${extractedContent.slice(0, maxContentChars)}\n\n[Content truncated — article is too long]`
    : extractedContent;
  let fullMessage = prompt;
  if (includeUrl && tabUrl) fullMessage += `\n\nSource URL: ${tabUrl}`;
  fullMessage += `\n\n---\n\n${truncated}`;

  if (sidePanelInvocation && !sidePanelInvocation.isCurrent()) return supersededResult;
  try {
    await writeToClipboard(fullMessage);
  } catch (error) {
    console.warn('[PageMind] Clipboard write failed:', error?.message || String(error));
  }
  if (sidePanelInvocation && !sidePanelInvocation.isCurrent()) return supersededResult;

  if (requestedDestination === 'sidepanel') {
    const { windowId, isCurrent } = sidePanelInvocation;
    const payload = createPendingPayload({
      id: crypto.randomUUID(),
      text: fullMessage,
      provider,
      autoSubmit,
      target: { kind: 'sidepanel', windowId },
    });
    const stored = await storePendingPayload(payload, isCurrent);
    if (!stored || !isCurrent()) {
      if (stored) await removePendingPayloadRouteIfExpected(payload);
      return supersededResult;
    }
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
