import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCustomContentScriptRegistrations,
  buildEmbeddingRules,
  CUSTOM_SCRIPT_IDS,
  isValidCustomProviderUrl,
  resolveProviderUrl,
} from '../lib/provider-embedding.js';

test('resolveProviderUrl preserves an HTTPS custom path and falls back for unsafe values', () => {
  assert.equal(
    resolveProviderUrl('chatgpt', { chatgpt: 'https://custom.example.com/my/chat' }),
    'https://custom.example.com/my/chat',
  );
  assert.equal(resolveProviderUrl('gemini', { gemini: 'http://custom.example.com/app' }), 'https://gemini.google.com/app');
  assert.equal(resolveProviderUrl('claude', { claude: 'not a url' }), 'https://claude.ai/new');
  assert.throws(() => resolveProviderUrl('unknown'), /Unknown provider/);
});

test('isValidCustomProviderUrl accepts empty values and HTTPS URLs only', () => {
  assert.equal(isValidCustomProviderUrl(), true);
  assert.equal(isValidCustomProviderUrl(''), true);
  assert.equal(isValidCustomProviderUrl('https://custom.example.com/path'), true);
  assert.equal(isValidCustomProviderUrl('http://custom.example.com/path'), false);
  assert.equal(isValidCustomProviderUrl('invalid'), false);
  assert.equal(isValidCustomProviderUrl(false), false);
});

test('buildEmbeddingRules scopes sub-frame header removals to extension initiators', () => {
  const rules = buildEmbeddingRules('abcdefghijklmnop', {
    gemini: 'https://custom.example.com/app',
    claude: 'http://unsafe.example.com/',
  });
  const hosts = rules.map((rule) => rule.condition.requestDomains[0]);

  assert.deepEqual(hosts, [...hosts].sort());
  assert.deepEqual(new Set(hosts), new Set([
    'chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'claude.ai', 'grok.com', 'custom.example.com',
  ]));
  assert.deepEqual(rules.map((rule) => rule.id), rules.map((_, index) => 1000 + index));
  for (const rule of rules) {
    assert.equal(rule.priority, 1);
    assert.deepEqual(rule.action, {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    });
    assert.deepEqual(rule.condition, {
      requestDomains: [rule.condition.requestDomains[0]],
      initiatorDomains: ['abcdefghijklmnop'],
      resourceTypes: ['sub_frame'],
    });
  }
});

test('custom registrations add isolated scripts, a Grok MAIN script, and no built-in duplicates', () => {
  const registrations = buildCustomContentScriptRegistrations({
    chatgpt: 'https://custom.example.com/chat',
    gemini: 'https://gemini.google.com/alternate',
    grok: 'https://grok-custom.example.com/',
    claude: 'http://unsafe.example.com/',
  });

  assert.deepEqual(registrations, [
    {
      id: 'pagemind-custom-chatgpt-isolated',
      matches: ['https://custom.example.com/*'],
      js: ['bridge.js', 'chatgpt-injector.js'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
      world: 'ISOLATED',
    },
    {
      id: 'pagemind-custom-grok-isolated',
      matches: ['https://grok-custom.example.com/*'],
      js: ['bridge.js', 'grok-injector.js'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
      world: 'ISOLATED',
    },
    {
      id: 'pagemind-custom-grok-main',
      matches: ['https://grok-custom.example.com/*'],
      js: ['grok-main.js'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
      world: 'MAIN',
    },
  ]);
  assert.deepEqual(CUSTOM_SCRIPT_IDS, [
    'pagemind-custom-chatgpt-isolated',
    'pagemind-custom-gemini-isolated',
    'pagemind-custom-claude-isolated',
    'pagemind-custom-grok-isolated',
    'pagemind-custom-grok-main',
  ]);
  assert.equal(Object.isFrozen(CUSTOM_SCRIPT_IDS), true);
});
