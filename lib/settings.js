export const OPEN_MODES = Object.freeze(['sidepanel', 'companion', 'newtab']);
export const TOOLBAR_ACTIONS = Object.freeze(['popup', 'summarize', 'sidepanel']);

export function normalizeOpenMode(value) {
  return OPEN_MODES.includes(value) ? value : 'companion';
}

export function resolveToolbarAction(settings = {}) {
  if (TOOLBAR_ACTIONS.includes(settings.toolbarAction)) {
    return settings.toolbarAction;
  }

  return settings.quickSummarize === true ? 'summarize' : 'popup';
}

export function getToolbarChromeConfig(value) {
  switch (value) {
    case 'summarize':
      return {
        popup: '',
        openPanelOnActionClick: false,
        directSummarize: true,
      };
    case 'sidepanel':
      return {
        popup: '',
        openPanelOnActionClick: true,
        directSummarize: false,
      };
    default:
      return {
        popup: 'popup.html',
        openPanelOnActionClick: false,
        directSummarize: false,
      };
  }
}

export function resolveSummaryDestination(openMode, source) {
  return source === 'sidepanel' ? 'sidepanel' : normalizeOpenMode(openMode);
}

export function createExportPayload(settings = {}) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      defaultProvider: settings.defaultProvider ?? 'chatgpt',
      lastProvider: settings.lastProvider ?? settings.defaultProvider ?? 'chatgpt',
      defaultPromptIndex: settings.defaultPromptIndex ?? 0,
      lastPromptIndex: settings.lastPromptIndex ?? settings.defaultPromptIndex ?? 0,
      customPrompts: Array.isArray(settings.customPrompts) ? [...settings.customPrompts] : [],
      customUrls: settings.customUrls && typeof settings.customUrls === 'object' && !Array.isArray(settings.customUrls) ? { ...settings.customUrls } : {},
      openMode: settings.openMode ?? 'companion',
      toolbarAction: settings.toolbarAction ?? 'popup',
      autoSubmit: settings.autoSubmit ?? true,
      includeUrl: settings.includeUrl ?? true,
      sidepanelNewChat: settings.sidepanelNewChat ?? false,
      maxContentChars: settings.maxContentChars ?? 12000,
      locale: settings.locale ?? 'auto',
    },
  };
}

export function validateImportedSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const raw = (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings))
    ? data.settings
    : data;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const knownKeys = [
    'defaultProvider', 'lastProvider', 'defaultPromptIndex', 'lastPromptIndex',
    'customPrompts', 'customUrls', 'openMode', 'toolbarAction', 'autoSubmit',
    'includeUrl', 'sidepanelNewChat', 'maxContentChars', 'quickSummarize', 'locale',
  ];

  const hasKnownKey = knownKeys.some((key) => Object.hasOwn(raw, key));
  if (!hasKnownKey) {
    return null;
  }

  return raw;
}

