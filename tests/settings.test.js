import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getToolbarChromeConfig,
  normalizeOpenMode,
  resolveSummaryDestination,
  resolveToolbarAction,
} from '../lib/settings.js';

test('normalizeOpenMode preserves supported modes and defaults invalid values to companion', () => {
  assert.equal(normalizeOpenMode('sidepanel'), 'sidepanel');
  assert.equal(normalizeOpenMode('companion'), 'companion');
  assert.equal(normalizeOpenMode('newtab'), 'newtab');
  assert.equal(normalizeOpenMode('invalid'), 'companion');
});

test('resolveToolbarAction migrates quickSummarize settings', () => {
  assert.equal(resolveToolbarAction({ quickSummarize: true }), 'summarize');
  assert.equal(resolveToolbarAction({ quickSummarize: false }), 'popup');
  assert.equal(resolveToolbarAction(), 'popup');
});

test('resolveToolbarAction prefers valid explicit actions and falls back invalid actions through legacy settings', () => {
  assert.equal(resolveToolbarAction({ toolbarAction: 'sidepanel', quickSummarize: true }), 'sidepanel');
  assert.equal(resolveToolbarAction({ toolbarAction: 'popup', quickSummarize: true }), 'popup');
  assert.equal(resolveToolbarAction({ toolbarAction: 'invalid', quickSummarize: true }), 'summarize');
  assert.equal(resolveToolbarAction({ toolbarAction: 'invalid', quickSummarize: false }), 'popup');
});

test('getToolbarChromeConfig returns the Chrome configuration for each toolbar action', () => {
  assert.deepEqual(getToolbarChromeConfig('popup'), {
    popup: 'popup.html',
    openPanelOnActionClick: false,
    directSummarize: false,
  });
  assert.deepEqual(getToolbarChromeConfig('summarize'), {
    popup: '',
    openPanelOnActionClick: false,
    directSummarize: true,
  });
  assert.deepEqual(getToolbarChromeConfig('sidepanel'), {
    popup: '',
    openPanelOnActionClick: true,
    directSummarize: false,
  });
});

test('resolveSummaryDestination lets the side panel source override open mode', () => {
  assert.equal(resolveSummaryDestination('companion', 'sidepanel'), 'sidepanel');
  assert.equal(resolveSummaryDestination('newtab', 'sidepanel'), 'sidepanel');
  assert.equal(resolveSummaryDestination('sidepanel', 'popup'), 'sidepanel');
  assert.equal(resolveSummaryDestination('newtab', 'popup'), 'newtab');
  assert.equal(resolveSummaryDestination('invalid', 'popup'), 'companion');
});
