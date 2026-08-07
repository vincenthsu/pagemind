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
