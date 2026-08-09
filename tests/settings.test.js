import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExportPayload,
  getToolbarChromeConfig,
  normalizeOpenMode,
  resolveSummaryDestination,
  resolveToolbarAction,
  validateImportedSettings,
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

test('createExportPayload creates a structured payload containing version, timestamp, and settings', () => {
  const payload = createExportPayload({
    defaultProvider: 'gemini',
    customPrompts: ['Test prompt'],
    openMode: 'sidepanel',
  });

  assert.equal(payload.version, 1);
  assert.equal(typeof payload.exportedAt, 'string');
  assert.equal(payload.settings.defaultProvider, 'gemini');
  assert.deepEqual(payload.settings.customPrompts, ['Test prompt']);
  assert.equal(payload.settings.openMode, 'sidepanel');
});

test('validateImportedSettings validates and extracts settings from wrapped and flat objects', () => {
  assert.equal(validateImportedSettings(null), null);
  assert.equal(validateImportedSettings('invalid'), null);
  assert.equal(validateImportedSettings({ foo: 'bar' }), null);

  const wrapped = validateImportedSettings({
    version: 1,
    settings: { defaultProvider: 'claude', customPrompts: ['Prompt 1'] },
  });
  assert.deepEqual(wrapped, { defaultProvider: 'claude', customPrompts: ['Prompt 1'] });

  const flat = validateImportedSettings({ openMode: 'newtab', autoSubmit: false });
  assert.deepEqual(flat, { openMode: 'newtab', autoSubmit: false });
});

