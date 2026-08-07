import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
);

test('declares the native Side Panel contract', () => {
  assert.equal(manifest.minimum_chrome_version, '114');
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.equal(manifest.action.default_popup, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /frame-src https:/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval/);
});

test('injects the bridge into every isolated provider frame', () => {
  const isolatedScripts = manifest.content_scripts.filter(
    ({ world }) => world !== 'MAIN',
  );

  assert.equal(isolatedScripts.length, 4);
  for (const script of isolatedScripts) {
    assert.equal(script.all_frames, true);
    assert.equal(script.js[0], 'injectors/bridge.js');
  }
});

test('runs the Grok main-world injector in every frame', () => {
  const grokMain = manifest.content_scripts.find(
    ({ world }) => world === 'MAIN',
  );

  assert.equal(grokMain.all_frames, true);
  assert.deepEqual(grokMain.js, ['injectors/grok-main.js']);
});
