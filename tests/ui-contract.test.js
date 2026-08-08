import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const optionsHtml = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const optionsJs = await readFile(new URL('../options.js', import.meta.url), 'utf8');
const backgroundJs = await readFile(new URL('../background.js', import.meta.url), 'utf8');

function radioValues(name) {
  return [...optionsHtml.matchAll(new RegExp(`<input\\s+type="radio"\\s+name="${name}"\\s+value="([^"]+)"`, 'g'))]
    .map((match) => match[1]);
}

function checkedRadioCount(name) {
  return [...optionsHtml.matchAll(new RegExp(`<input\\s+type="radio"\\s+name="${name}"[^>]*`, 'g'))]
    .filter(([input]) => /\schecked(?:\s|>|$)/.test(input)).length;
}

test('options expose exactly three provider windows and toolbar actions', () => {
  assert.deepEqual(radioValues('openMode'), ['sidepanel', 'companion', 'newtab']);
  assert.deepEqual(radioValues('toolbarAction'), ['popup', 'summarize', 'sidepanel']);
  assert.equal(checkedRadioCount('openMode'), 1);
  assert.equal(checkedRadioCount('toolbarAction'), 1);
  assert.doesNotMatch(optionsHtml, /quickSummarizeToggle|Quick Summarize/);
});

test('options explain Side Panel and toolbar behavior', () => {
  assert.match(optionsHtml, /native\s+Chrome Side Panel/i);
  assert.match(optionsHtml, /new-tab\s+fallback/i);
  assert.match(optionsHtml, /Right-click actions remain\s+available in every mode\./);
  assert.match(optionsHtml, /default provider and prompt/i);
  assert.match(optionsHtml, /without starting a summary/i);
});

test('options migrate and persist normalized provider-window and toolbar choices', () => {
  assert.match(optionsJs, /import\s*{\s*normalizeOpenMode\s*,\s*resolveToolbarAction\s*}\s*from '\.\/lib\/settings\.js';/);
  assert.match(optionsJs, /let toolbarAction = 'popup';/);
  assert.match(optionsJs, /'toolbarAction'[\s\S]*'quickSummarize'/);
  assert.match(optionsJs, /openMode = normalizeOpenMode\(settings\.openMode\);/);
  assert.match(optionsJs, /toolbarAction = resolveToolbarAction\(settings\);/);
  assert.match(optionsJs, /input\[name="openMode"\]\[value="\$\{openMode\}"\]/);
  assert.match(optionsJs, /input\[name="toolbarAction"\]\[value="\$\{toolbarAction\}"\]/);
  assert.match(optionsJs, /input\[name="openMode"\], input\[name="toolbarAction"\]/);
  assert.match(optionsJs, /openMode: normalizeOpenMode\(selectedMode\)/);
  assert.match(optionsJs, /toolbarAction: resolveToolbarAction\(\{ toolbarAction: selectedToolbarAction \}\)/);
  assert.doesNotMatch(optionsJs, /quickSummarizeToggle/);

  const saveSettings = optionsJs.slice(optionsJs.indexOf('function saveSettings()'));
  assert.doesNotMatch(saveSettings, /quickSummarize/);
});

test('context menu keeps summary, Side Panel, and settings actions', () => {
  for (const id of ['summarize-page', 'open-side-panel', 'open-settings']) {
    assert.match(backgroundJs, new RegExp(id));
  }
});
