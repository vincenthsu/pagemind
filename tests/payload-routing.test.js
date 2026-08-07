import assert from 'node:assert/strict';
import test from 'node:test';

import { createPendingPayload, matchPayloadRequest } from '../lib/payload-routing.js';

test('tab payload matches only its provider and tab request', () => {
  const payload = createPendingPayload({
    id: 'summary-1',
    text: 'Summarize this page',
    provider: 'chatgpt',
    target: { kind: 'tab', tabId: 42 },
  });

  assert.deepEqual(matchPayloadRequest(payload, { provider: 'chatgpt', context: 'tab', tabId: 42 }), {
    matched: true,
    expired: false,
  });
  assert.deepEqual(matchPayloadRequest(payload, { provider: 'claude', context: 'tab', tabId: 42 }), {
    matched: false,
    expired: false,
  });
  assert.deepEqual(matchPayloadRequest(payload, { provider: 'chatgpt', context: 'tab', tabId: 43 }), {
    matched: false,
    expired: false,
  });
});

test('side panel payload matches only its window side panel request', () => {
  const payload = createPendingPayload({
    id: 'summary-2',
    text: 'Explain this selection',
    provider: 'claude',
    target: { kind: 'sidepanel', windowId: 7 },
  });

  assert.deepEqual(matchPayloadRequest(payload, { provider: 'claude', context: 'sidepanel', windowId: 7 }), {
    matched: true,
    expired: false,
  });
  assert.deepEqual(matchPayloadRequest(payload, { provider: 'claude', context: 'sidepanel', windowId: 8 }), {
    matched: false,
    expired: false,
  });
  assert.deepEqual(matchPayloadRequest(payload, { provider: 'claude', context: 'nested', windowId: 7 }), {
    matched: false,
    expired: false,
  });
});

test('expired payload returns an expired non-match', () => {
  const now = 100_000;
  const payload = createPendingPayload({
    id: 'summary-3',
    text: 'Old request',
    provider: 'chatgpt',
    target: { kind: 'tab', tabId: 1 },
    createdAt: now - 60_001,
  });

  assert.deepEqual(matchPayloadRequest(payload, { provider: 'chatgpt', context: 'tab', tabId: 1 }, now), {
    matched: false,
    expired: true,
  });
});

test('tab target requires an integer tabId', () => {
  assert.throws(
    () => createPendingPayload({ id: 'x', text: 'Text', provider: 'chatgpt', target: { kind: 'tab' } }),
    /tabId/,
  );
});

test('side panel target requires an integer windowId', () => {
  assert.throws(
    () => createPendingPayload({ id: 'x', text: 'Text', provider: 'claude', target: { kind: 'sidepanel' } }),
    /windowId/,
  );
});

test('required fields and target kinds are validated', () => {
  const target = { kind: 'tab', tabId: 1 };

  assert.throws(() => createPendingPayload({ text: 'Text', provider: 'chatgpt', target }), /id/);
  assert.throws(() => createPendingPayload({ id: 'x', provider: 'chatgpt', target }), /text/);
  assert.throws(() => createPendingPayload({ id: 'x', text: 'Text', target }), /provider/);
  assert.throws(
    () => createPendingPayload({ id: 'x', text: 'Text', provider: 'chatgpt', target: { kind: 'popup' } }),
    /kind/,
  );
});
