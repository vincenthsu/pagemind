import { getDefaultPrompts, PROVIDERS } from './lib/providers.js';
import { isValidCustomProviderUrl, resolveProviderUrl } from './lib/provider-embedding.js';
import { applyI18n, applyLocaleSetting, t } from './lib/i18n.js';

export const FRAME_READY_TIMEOUT_MS = 12_000;
// Exceeds the slowest provider's bounded editor wait plus submit delay (24.5s).
export const DELIVERY_ACK_TIMEOUT_MS = 32_000;

function hasProvider(provider) {
  return typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider);
}

function errorMessage(error) {
  return error?.message || String(error);
}

export function createSidePanelController({
  document,
  window,
  chrome,
  clock = globalThis,
  readinessTimeoutMs = FRAME_READY_TIMEOUT_MS,
}) {
  const elements = {
    controls: document.getElementById('panelControls'),
    collapse: document.getElementById('collapseBtn'),
    reload: document.getElementById('reloadBtn'),
    openTab: document.getElementById('openTabBtn'),
    frame: document.getElementById('providerFrame'),
    fallback: document.getElementById('frameFallback'),
    fallbackMessage: document.getElementById('fallbackMessage'),
    retry: document.getElementById('retryFrameBtn'),
    fallbackNewTab: document.getElementById('fallbackNewTabBtn'),
    providerGrid: document.getElementById('providerGrid'),
    prompt: document.getElementById('promptSelect'),
    summarize: document.getElementById('summarizeBtn'),
    settings: document.getElementById('settingsBtn'),
    status: document.getElementById('statusMsg'),
    clipboardHint: document.getElementById('clipboardHint'),
    pageTitle: document.getElementById('pageTitle'),
    pageUrl: document.getElementById('pageUrl'),
  };

  const state = {
    initialized: false,
    selectedProvider: 'chatgpt',
    customUrls: {},
    prompts: getDefaultPrompts(),
    sidepanelNewChat: false,
    panelWindowId: null,
    sourceTabId: null,
    hasSelection: false,
    navigationGeneration: 0,
    providerReady: false,
    currentUrl: '',
    currentOrigin: '',
    readinessTimer: null,
    deliveryAckTimer: null,
    retainedPayload: null,
    runtimeNavigationGeneration: 0,
    customUrlsRevision: 0,
    consumeRequestGeneration: 0,
    latestSelectedConsumeGeneration: 0,
    payloadErrorVisible: false,
    pageInfoGeneration: 0,
  };

  function getRuntimeError() {
    return chrome.runtime?.lastError?.message;
  }

  function callbackCall(invoke) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        const runtimeError = getRuntimeError();
        if (runtimeError) reject(new Error(runtimeError));
        else resolve(value);
      };
      try {
        const result = invoke(finish);
        if (result && typeof result.then === 'function') {
          result.then(finish, (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  function sendRuntimeMessage(message) {
    return callbackCall((callback) => chrome.runtime.sendMessage(message, callback));
  }

  function setStatus(type, message) {
    state.payloadErrorVisible = false;
    elements.status.textContent = message;
    elements.status.classList.remove('visible', 'loading', 'success', 'error');
    if (message) elements.status.classList.add('visible', type);
  }

  function setPayloadError(message) {
    setStatus('error', message);
    state.payloadErrorVisible = true;
  }

  function clearPayloadError() {
    if (state.payloadErrorVisible) setStatus('', '');
  }

  function renderButtonLabel() {
    if (elements.summarize.disabled) {
      elements.summarize.textContent = t('panelSending');
    } else {
      elements.summarize.textContent = state.hasSelection
        ? t('panelSummarizeSelection')
        : t('panelSummarize');
    }
  }

  function setButtonDisabled(disabled) {
    elements.summarize.disabled = disabled;
    renderButtonLabel();
  }

  function renderProviderButtons() {
    document.querySelectorAll('.provider-btn').forEach((button) => {
      const selected = button.dataset.provider === state.selectedProvider;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function renderPrompts(lastPromptIndex) {
    elements.prompt.innerHTML = '';
    state.prompts.forEach((prompt, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
      if (index === lastPromptIndex) option.selected = true;
      elements.prompt.appendChild(option);
    });
    elements.prompt.value = String(lastPromptIndex);
  }

  async function loadSettings() {
    let data = {};
    try {
      data = await callbackCall((callback) => chrome.storage.sync.get(
        ['lastProvider', 'lastPromptIndex', 'customPrompts', 'customUrls', 'sidepanelNewChat', 'locale'],
        callback,
      ));
    } catch (error) {
      setStatus('error', t('panelErrorLoadSettings', errorMessage(error)));
    }
    if (!data || typeof data !== 'object') data = {};
    applyLocaleSetting(data, chrome);
    applyI18n(document);
    state.selectedProvider = hasProvider(data.lastProvider) ? data.lastProvider : 'chatgpt';
    state.sidepanelNewChat = typeof data.sidepanelNewChat === 'boolean' ? data.sidepanelNewChat : false;
    const customPrompts = Array.isArray(data.customPrompts)
      ? data.customPrompts.filter((prompt) => typeof prompt === 'string')
      : [];
    state.prompts = [...customPrompts, ...getDefaultPrompts()];
    state.customUrls = normalizeCustomUrls(data.customUrls);
    const requestedIndex = Number.isInteger(data.lastPromptIndex) && data.lastPromptIndex >= 0
      ? data.lastPromptIndex
      : 0;
    const lastPromptIndex = Math.min(requestedIndex, state.prompts.length - 1);
    renderPrompts(lastPromptIndex);
    renderProviderButtons();
  }

  function normalizeCustomUrls(value) {
    return value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      ? { ...value }
      : {};
  }

  async function refreshCustomUrls() {
    const revision = state.customUrlsRevision;
    const data = await callbackCall((callback) => chrome.storage.sync.get(['customUrls'], callback));
    if (revision === state.customUrlsRevision) {
      state.customUrls = normalizeCustomUrls(data?.customUrls);
    }
  }

  async function persistSelection(value) {
    try {
      await callbackCall((callback) => chrome.storage.sync.set(value, callback));
    } catch (error) {
      setStatus('error', t('panelErrorSaveSelection', errorMessage(error)));
    }
  }

  function resolveCurrentUrl(provider) {
    return resolveProviderUrl(provider, state.customUrls);
  }

  function acceptedNavigationUrl(provider, candidateUrl) {
    const resolvedUrl = resolveCurrentUrl(provider);
    if (typeof candidateUrl !== 'string') return resolvedUrl;
    try {
      const candidate = new URL(candidateUrl);
      return candidate.protocol === 'https:' && candidate.href === new URL(resolvedUrl).href
        ? candidate.href
        : resolvedUrl;
    } catch {
      return resolvedUrl;
    }
  }

  function hideFallback() {
    elements.fallback.classList.remove('visible');
  }

  function showFallback(message = t('panelFallbackNotLoaded')) {
    elements.fallbackMessage.textContent = message;
    elements.fallback.classList.add('visible');
  }

  function clearReadinessTimer() {
    if (state.readinessTimer) clock.clearTimeout(state.readinessTimer);
    state.readinessTimer = null;
  }

  function clearDeliveryAckTimer() {
    if (state.deliveryAckTimer) clock.clearTimeout(state.deliveryAckTimer);
    state.deliveryAckTimer = null;
  }

  function replaceProviderFrame() {
    const replacement = elements.frame.cloneNode(false);
    replacement.removeAttribute('src');
    elements.frame.replaceWith(replacement);
    elements.frame = replacement;
  }

  function customUrlWasRejected(provider, resolvedUrl) {
    const configuredUrl = state.customUrls[provider];
    if (configuredUrl === undefined || configuredUrl === '') return false;
    if (!isValidCustomProviderUrl(configuredUrl)) return true;
    try {
      return new URL(configuredUrl).href !== resolvedUrl;
    } catch {
      return true;
    }
  }

  function navigate(provider, candidateUrl) {
    if (!hasProvider(provider)) return;
    const url = acceptedNavigationUrl(provider, candidateUrl);
    const origin = new URL(url).origin;
    state.navigationGeneration += 1;
    const generation = state.navigationGeneration;
    state.selectedProvider = provider;
    state.currentUrl = url;
    state.currentOrigin = origin;
    state.providerReady = false;
    clearReadinessTimer();
    clearDeliveryAckTimer();
    hideFallback();
    renderProviderButtons();

    if (customUrlWasRejected(provider, url)) {
      setStatus('error', t('panelErrorCustomUrl', PROVIDERS[provider].label));
    }

    replaceProviderFrame();
    elements.frame.src = url;
    state.readinessTimer = clock.setTimeout(() => {
      if (
        state.navigationGeneration === generation
        && state.selectedProvider === provider
        && state.currentOrigin === origin
        && !state.providerReady
      ) showFallback();
    }, readinessTimeoutMs);
  }

  function postPayload(
    generation,
    provider,
    origin,
    payload,
    consumeGeneration,
    { preservePayloadError = false } = {},
  ) {
    if (
      state.navigationGeneration !== generation
      || state.selectedProvider !== provider
      || state.currentOrigin !== origin
      || !state.providerReady
      || consumeGeneration < state.latestSelectedConsumeGeneration
    ) return false;
    const frame = elements.frame;
    elements.frame.contentWindow.postMessage({
      type: 'PAGE_MIND_DELIVER',
      provider,
      windowId: state.panelWindowId,
      payloadId: payload.id,
      payload,
    }, origin);
    state.latestSelectedConsumeGeneration = Math.max(
      state.latestSelectedConsumeGeneration,
      consumeGeneration,
    );
    clearDeliveryAckTimer();
    state.deliveryAckTimer = clock.setTimeout(() => {
      if (
        elements.frame === frame
        && state.selectedProvider === provider
        && state.currentOrigin === origin
        && state.retainedPayload?.payload.id === payload.id
      ) {
        showFallback(t('panelFallbackNoAck'));
      }
    }, DELIVERY_ACK_TIMEOUT_MS);
    if (!preservePayloadError) clearPayloadError();
    hideFallback();
    return true;
  }

  function isCurrentNavigation(generation, provider, origin) {
    return state.navigationGeneration === generation
      && state.selectedProvider === provider
      && state.currentOrigin === origin;
  }

  function validPayload(payload) {
    return payload
      && typeof payload === 'object'
      && typeof payload.id === 'string'
      && payload.id.length > 0;
  }

  function pickDeliveryCandidate(retained, fresh) {
    if (!retained) return fresh;
    if (!fresh) return retained;
    if (retained.consumeGeneration > fresh.consumeGeneration) return retained;
    const retainedCreatedAt = retained.payload.createdAt;
    const freshCreatedAt = fresh.payload.createdAt;
    if (Number.isFinite(retainedCreatedAt) || Number.isFinite(freshCreatedAt)) {
      if (!Number.isFinite(retainedCreatedAt)) return fresh;
      if (!Number.isFinite(freshCreatedAt)) return retained;
      if (retainedCreatedAt !== freshCreatedAt) {
        return retainedCreatedAt > freshCreatedAt ? retained : fresh;
      }
    }
    return fresh;
  }

  function handlePayloadLookupFailure(generation, provider, origin, consumeGeneration, message) {
    if (
      consumeGeneration !== state.consumeRequestGeneration
      || !isCurrentNavigation(generation, provider, origin)
    ) return;
    setPayloadError(message);
    const retained = state.retainedPayload;
    if (
      retained?.provider === provider
      && retained.consumeGeneration >= state.latestSelectedConsumeGeneration
      && postPayload(
        generation,
        provider,
        origin,
        retained.payload,
        retained.consumeGeneration,
        { preservePayloadError: true },
      )
    ) return;
    showFallback(t('panelFallbackNoPayload'));
  }

  async function consumeAndDeliver(generation, provider, origin) {
    state.consumeRequestGeneration += 1;
    const consumeGeneration = state.consumeRequestGeneration;
    let response;
    try {
      response = await sendRuntimeMessage({
        type: 'GET_PAYLOAD',
        provider,
        context: 'sidepanel',
        windowId: state.panelWindowId,
      });
    } catch (error) {
      handlePayloadLookupFailure(
        generation,
        provider,
        origin,
        consumeGeneration,
        t('panelErrorRetrieveSummary', errorMessage(error)),
      );
      return;
    }
    if (response?.error) {
      handlePayloadLookupFailure(
        generation,
        provider,
        origin,
        consumeGeneration,
        t('panelErrorRetrieveSummary', response.error),
      );
      return;
    }
    if (
      consumeGeneration === state.consumeRequestGeneration
      && isCurrentNavigation(generation, provider, origin)
    ) {
      clearPayloadError();
      hideFallback();
    }
    const payload = response?.payload;
    if (consumeGeneration < state.latestSelectedConsumeGeneration) return;
    const fresh = validPayload(payload)
      ? { provider, payload, consumeGeneration }
      : null;
    const retained = state.retainedPayload?.provider === provider
      ? state.retainedPayload
      : null;
    const candidate = pickDeliveryCandidate(retained, fresh);
    if (!candidate) return;
    if (
      state.navigationGeneration !== generation
      || state.selectedProvider !== provider
      || state.currentOrigin !== origin
      || !state.providerReady
    ) {
      if (state.selectedProvider === provider) {
        if (
          !state.retainedPayload
          || candidate.consumeGeneration >= state.retainedPayload.consumeGeneration
          || pickDeliveryCandidate(state.retainedPayload, candidate) === candidate
        ) {
          state.retainedPayload = candidate;
        }
        if (state.providerReady) {
          const currentGeneration = state.navigationGeneration;
          const currentOrigin = state.currentOrigin;
          postPayload(
            currentGeneration,
            provider,
            currentOrigin,
            state.retainedPayload.payload,
            state.retainedPayload.consumeGeneration,
          );
        }
      }
      return;
    }
    state.retainedPayload = candidate;
    postPayload(
      generation,
      provider,
      origin,
      candidate.payload,
      candidate.consumeGeneration,
    );
  }

  async function handleFrameMessage(event) {
    const data = event.data;
    if (
      event.source !== elements.frame.contentWindow
      || event.origin !== state.currentOrigin
    ) return;
    if (data?.type === 'PAGE_MIND_DELIVERED') {
      if (
        data.provider !== state.selectedProvider
        || data.windowId !== state.panelWindowId
        || !Number.isInteger(data.windowId)
        || typeof data.payloadId !== 'string'
        || data.payloadId !== state.retainedPayload?.payload.id
        || state.retainedPayload.provider !== data.provider
      ) return;
      clearDeliveryAckTimer();
      state.retainedPayload = null;
      clearPayloadError();
      hideFallback();
      return;
    }
    if (data?.type !== 'PANEL_READY' || data.provider !== state.selectedProvider) return;
    const generation = state.navigationGeneration;
    const provider = state.selectedProvider;
    const origin = state.currentOrigin;
    state.providerReady = true;
    clearReadinessTimer();
    hideFallback();
    await consumeAndDeliver(generation, provider, origin);
  }

  function isTrustedRuntimeSender(sender) {
    if (sender?.id !== chrome.runtime.id || sender.tab || typeof sender.url !== 'string') return false;
    try {
      return new URL(sender.url).href === new URL(chrome.runtime.getURL('background.js')).href;
    } catch {
      return false;
    }
  }

  async function handleRuntimeMessage(message, sender) {
    if (
      !isTrustedRuntimeSender(sender)
      || message?.type !== 'PANEL_NAVIGATE'
      || message.windowId !== state.panelWindowId
      || !hasProvider(message.provider)
    ) return;
    state.runtimeNavigationGeneration += 1;
    const runtimeNavigationGeneration = state.runtimeNavigationGeneration;
    const localNavigationGeneration = state.navigationGeneration;
    try {
      await refreshCustomUrls();
    } catch (error) {
      if (
        runtimeNavigationGeneration === state.runtimeNavigationGeneration
        && localNavigationGeneration === state.navigationGeneration
      ) {
        setStatus('error', t('panelErrorRefreshUrls', errorMessage(error)));
        showFallback(t('panelFallbackNoSettings'));
      }
      return;
    }
    if (
      runtimeNavigationGeneration !== state.runtimeNavigationGeneration
      || localNavigationGeneration !== state.navigationGeneration
    ) return;
    const resolvedUrl = acceptedNavigationUrl(message.provider, message.url);
    if (
      !state.sidepanelNewChat
      && message.provider === state.selectedProvider
      && resolvedUrl === state.currentUrl
      && state.providerReady
    ) {
      await consumeAndDeliver(
        state.navigationGeneration,
        state.selectedProvider,
        state.currentOrigin,
      );
      return;
    }
    navigate(message.provider, resolvedUrl);
  }

  function queryActiveTab() {
    return callbackCall((callback) => chrome.tabs.query({
      active: true,
      windowId: state.panelWindowId,
    }, callback)).then((tabs) => tabs?.find((tab) => Number.isInteger(tab?.id)) ?? null);
  }

  async function readSelection(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => window.getSelection().toString().trim(),
      });
      return Array.isArray(results)
        ? results.map((result) => result?.result).filter((value) => typeof value === 'string' && value).join('\n\n').trim()
        : '';
    } catch {
      return '';
    }
  }

  async function refreshActiveTab() {
    state.pageInfoGeneration += 1;
    const generation = state.pageInfoGeneration;
    let tab;
    try {
      tab = await queryActiveTab();
    } catch {
      tab = null;
    }
    if (generation !== state.pageInfoGeneration) return null;
    state.sourceTabId = tab?.id ?? null;
    elements.pageTitle.textContent = tab?.title || t('panelNoActivePage');
    elements.pageUrl.textContent = tab?.url || '';
    if (!tab) {
      state.hasSelection = false;
      renderButtonLabel();
      return null;
    }
    const selection = await readSelection(tab.id);
    if (generation !== state.pageInfoGeneration || state.sourceTabId !== tab.id) return null;
    state.hasSelection = selection.length > 0;
    renderButtonLabel();
    return tab;
  }

  async function handleSummarize() {
    const requestProvider = state.selectedProvider;
    elements.clipboardHint.classList.remove('visible');
    setButtonDisabled(true);
    try {
      const tab = await refreshActiveTab();
      if (!Number.isInteger(tab?.id)) throw new Error(t('panelErrorNoActiveTab'));
      const selectedText = await readSelection(tab.id);
      const promptIndex = Number.parseInt(elements.prompt.value, 10);
      setStatus('loading', selectedText ? t('panelStatusSendingSelection') : t('panelStatusExtracting'));
      const response = await sendRuntimeMessage({
        type: 'SUMMARIZE',
        provider: requestProvider,
        promptIndex: Number.isInteger(promptIndex) ? promptIndex : 0,
        selectedText,
        source: 'sidepanel',
        destination: 'sidepanel',
        sourceTabId: tab.id,
        sourceWindowId: state.panelWindowId,
      });
      if (!response || typeof response !== 'object') {
        throw new Error(t('panelErrorUnexpectedResponse'));
      }
      if (response?.error) throw new Error(response.error);
      if (response?.superseded) {
        setStatus('success', t('panelStatusSuperseded'));
      } else if (response?.success) {
        setStatus('success', t('panelStatusSent', PROVIDERS[requestProvider].label));
        if (response.clipboardCopied === true) elements.clipboardHint.classList.add('visible');
      } else throw new Error(t('panelErrorUnexpectedResponse'));
    } catch (error) {
      setStatus('error', errorMessage(error));
    } finally {
      setButtonDisabled(false);
    }
  }

  async function openCurrentProvider() {
    try {
      const url = state.currentUrl || resolveCurrentUrl(state.selectedProvider);
      await callbackCall((callback) => chrome.tabs.create(
        { url, active: true },
        callback,
      ));
    } catch (error) {
      setStatus('error', t('panelErrorOpenProvider', errorMessage(error)));
    }
  }

  async function openSettings() {
    try {
      await chrome.runtime.openOptionsPage();
    } catch (error) {
      setStatus('error', t('panelErrorOpenSettings', errorMessage(error)));
    }
  }

  function setupEventListeners() {
    elements.providerGrid.addEventListener('click', (event) => {
      const button = event.target.closest('.provider-btn');
      const provider = button?.dataset.provider;
      if (!hasProvider(provider)) return;
      if (provider !== state.selectedProvider) navigate(provider);
      void persistSelection({ lastProvider: provider });
    });
    elements.prompt.addEventListener('change', () => {
      const promptIndex = Number.parseInt(elements.prompt.value, 10);
      void persistSelection({ lastPromptIndex: Number.isInteger(promptIndex) ? promptIndex : 0 });
    });
    elements.collapse.addEventListener('click', () => {
      const collapsed = elements.controls.classList.toggle('collapsed');
      elements.collapse.setAttribute('aria-expanded', String(!collapsed));
      const collapseLabel = t(collapsed ? 'panelExpandControls' : 'panelCollapseControls');
      elements.collapse.setAttribute('title', collapseLabel);
      elements.collapse.setAttribute('aria-label', collapseLabel);
      elements.collapse.dataset.i18nTitle = collapsed ? 'panelExpandControls' : 'panelCollapseControls';
      elements.collapse.dataset.i18nAriaLabel = elements.collapse.dataset.i18nTitle;
      elements.collapse.textContent = collapsed ? '⌄' : '⌃';
    });
    elements.reload.addEventListener('click', () => navigate(state.selectedProvider));
    elements.retry.addEventListener('click', () => { void retryProviderFrame(); });
    elements.openTab.addEventListener('click', () => { void openCurrentProvider(); });
    elements.fallbackNewTab.addEventListener('click', () => { void openCurrentProvider(); });
    elements.settings.addEventListener('click', () => { void openSettings(); });
    elements.summarize.addEventListener('click', handleSummarize);
    window.addEventListener('message', (event) => {
      void handleFrameMessage(event).catch((error) => {
        setStatus('error', t('panelErrorFrameMessage', errorMessage(error)));
      });
    });
    chrome.runtime.onMessage.addListener((message, sender) => {
      void handleRuntimeMessage(message, sender).catch((error) => {
        setStatus('error', t('panelErrorNavigation', errorMessage(error)));
      });
      return false;
    });
    chrome.tabs.onActivated.addListener(() => { void refreshActiveTab(); });
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo?.status === 'complete') void refreshActiveTab();
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync') {
        if (Object.hasOwn(changes, 'customUrls')) {
          state.customUrlsRevision += 1;
          state.customUrls = normalizeCustomUrls(changes.customUrls?.newValue);
        }
        if (Object.hasOwn(changes, 'sidepanelNewChat')) {
          state.sidepanelNewChat = typeof changes.sidepanelNewChat?.newValue === 'boolean'
            ? changes.sidepanelNewChat.newValue
            : false;
        }
      }
    });
  }

  async function resolvePanelWindowId() {
    const currentWindow = await callbackCall((callback) => chrome.windows.getCurrent(
      { populate: false },
      callback,
    ));
    if (!Number.isInteger(currentWindow?.id)) throw new Error(t('panelErrorWindowId'));
    return currentWindow.id;
  }

  async function discoverPendingProvider() {
    const response = await sendRuntimeMessage({
      type: 'PANEL_READY',
      windowId: state.panelWindowId,
    });
    if (response?.error) throw new Error(response.error);
    return hasProvider(response?.provider) ? response.provider : null;
  }

  async function retryProviderFrame() {
    const navigationGeneration = state.navigationGeneration;
    const runtimeNavigationGeneration = state.runtimeNavigationGeneration;
    try {
      if (!Number.isInteger(state.panelWindowId)) {
        state.panelWindowId = await resolvePanelWindowId();
      }
      const pendingProvider = await discoverPendingProvider();
      if (
        navigationGeneration !== state.navigationGeneration
        || runtimeNavigationGeneration !== state.runtimeNavigationGeneration
      ) return;
      if (!state.payloadErrorVisible) setStatus('', '');
      navigate(pendingProvider ?? state.selectedProvider);
      await refreshActiveTab();
    } catch (error) {
      if (
        navigationGeneration !== state.navigationGeneration
        || runtimeNavigationGeneration !== state.runtimeNavigationGeneration
      ) return;
      setStatus('error', t('panelErrorPendingSummaries', errorMessage(error)));
      showFallback(t('panelFallbackNoPending'));
    }
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    setupEventListeners();
    await loadSettings();
    try {
      state.panelWindowId = await resolvePanelWindowId();
    } catch (error) {
      setStatus('error', errorMessage(error));
      showFallback(t('panelFallbackNoWindow'));
      return;
    }

    let pendingProvider = null;
    let discoveryError = null;
    const discoveryNavigationGeneration = state.navigationGeneration;
    const discoveryRuntimeNavigationGeneration = state.runtimeNavigationGeneration;
    try {
      pendingProvider = await discoverPendingProvider();
    } catch (error) {
      if (
        discoveryNavigationGeneration === state.navigationGeneration
        && discoveryRuntimeNavigationGeneration === state.runtimeNavigationGeneration
      ) {
        discoveryError = error;
        setStatus('error', t('panelErrorPendingSummaries', errorMessage(error)));
      }
    }
    if (
      discoveryNavigationGeneration === state.navigationGeneration
      && discoveryRuntimeNavigationGeneration === state.runtimeNavigationGeneration
    ) {
      navigate(pendingProvider ?? state.selectedProvider);
      if (discoveryError) showFallback(t('panelFallbackNoPending'));
    }
    await refreshActiveTab();
  }

  return Object.freeze({ initialize });
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const controller = createSidePanelController({ document, window, chrome });
    void controller.initialize().catch((error) => {
      console.error('[PageMind] Side panel initialization failed:', error);
    });
  }, { once: true });
}
