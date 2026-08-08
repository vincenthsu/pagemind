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

test('createdAt must be finite', () => {
  const basePayload = {
    id: 'x',
    text: 'Text',
    provider: 'chatgpt',
    target: { kind: 'tab', tabId: 1 },
  };

  assert.throws(() => createPendingPayload({ ...basePayload, createdAt: Number.NaN }), /createdAt/);
  assert.throws(() => createPendingPayload({ ...basePayload, createdAt: Infinity }), /createdAt/);
});

test('created payload snapshots an immutable target', () => {
  const target = { kind: 'tab', tabId: 42 };
  const payload = createPendingPayload({
    id: 'summary-4',
    text: 'Keep this tab',
    provider: 'chatgpt',
    target,
  });
  target.tabId = 99;

  assert.notEqual(payload.target, target);
  assert.equal(Object.isFrozen(payload.target), true);
  assert.deepEqual(matchPayloadRequest(payload, { provider: 'chatgpt', context: 'tab', tabId: 42 }), {
    matched: true,
    expired: false,
  });
});

test('payloads at the TTL boundary remain eligible', () => {
  const now = 100_000;
  const payload = createPendingPayload({
    id: 'summary-5',
    text: 'Boundary request',
    provider: 'chatgpt',
    target: { kind: 'tab', tabId: 1 },
    createdAt: now - 60_000,
  });

  assert.deepEqual(matchPayloadRequest(payload, { provider: 'chatgpt', context: 'tab', tabId: 1 }, now), {
    matched: true,
    expired: false,
  });
});

test('malformed persisted timestamps are expired cleanup candidates', () => {
  const payload = {
    id: 'summary-6',
    text: 'Persisted request',
    provider: 'chatgpt',
    target: { kind: 'tab', tabId: 1 },
  };
  const request = { provider: 'chatgpt', context: 'tab', tabId: 1 };

  for (const [createdAt, now] of [[Number.NaN, 100], [Infinity, 100], [100, Number.NaN], [100, Infinity], [101, 100]]) {
    assert.deepEqual(matchPayloadRequest({ ...payload, createdAt }, request, now), {
      matched: false,
      expired: true,
    });
  }
});

test('malformed persisted payload targets are expired cleanup candidates', () => {
  const payload = {
    id: 'summary-7',
    text: 'Persisted request',
    provider: 'chatgpt',
    createdAt: 100,
  };
  const request = { provider: 'chatgpt', context: 'sidepanel', windowId: 7 };

  for (const target of [{ kind: 'unknown' }, { kind: 'tab' }, { kind: 'tab', tabId: 1.5 }, { kind: 'sidepanel' }, { kind: 'sidepanel', windowId: 7.5 }]) {
    assert.deepEqual(matchPayloadRequest({ ...payload, target }, request, 100), {
      matched: false,
      expired: true,
    });
  }
});

test('malformed persisted required fields are expired cleanup candidates', () => {
  const payload = {
    id: 'summary-8',
    text: 'Persisted request',
    provider: 'chatgpt',
    target: { kind: 'tab', tabId: 1 },
    createdAt: 100,
  };
  const request = { provider: 'chatgpt', context: 'tab', tabId: 1 };

  for (const field of ['id', 'text', 'provider']) {
    assert.deepEqual(matchPayloadRequest({ ...payload, [field]: '' }, request, 100), {
      matched: false,
      expired: true,
    });
  }
});
