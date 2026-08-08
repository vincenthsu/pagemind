import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
);

test('declares the native Side Panel contract', () => {
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'; frame-src https:;",
  );
});

test('injects the bridge into every isolated provider frame', () => {
  const isolatedScripts = manifest.content_scripts.filter(
    ({ world }) => world !== 'MAIN',
  );

  assert.deepEqual(isolatedScripts, [
    {
      matches: ['https://chat.openai.com/*', 'https://chatgpt.com/*'],
      js: ['injectors/bridge.js', 'injectors/chatgpt.js'],
      run_at: 'document_idle',
      all_frames: true,
    },
    {
      matches: ['https://gemini.google.com/*'],
      js: ['injectors/bridge.js', 'injectors/gemini.js'],
      run_at: 'document_idle',
      all_frames: true,
    },
    {
      matches: ['https://claude.ai/*'],
      js: ['injectors/bridge.js', 'injectors/claude.js'],
      run_at: 'document_idle',
      all_frames: true,
    },
    {
      matches: ['https://grok.com/*'],
      js: ['injectors/bridge.js', 'injectors/grok.js'],
      run_at: 'document_start',
      all_frames: true,
    },
  ]);
});

test('runs the Grok main-world injector in every frame', () => {
  const grokMain = manifest.content_scripts.find(
    ({ world }) => world === 'MAIN',
  );

  assert.deepEqual(grokMain, {
    matches: ['https://grok.com/*'],
    js: ['injectors/grok-main.js'],
    run_at: 'document_start',
    all_frames: true,
    world: 'MAIN',
  });
});
