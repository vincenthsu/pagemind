export const PAYLOAD_TTL_MS = 60_000;

function hasRequiredFields(payload) {
  return Boolean(payload?.id && payload.text && payload.provider);
}

function isValidTarget(target) {
  return (target?.kind === 'tab' && Number.isInteger(target.tabId))
    || (target?.kind === 'sidepanel' && Number.isInteger(target.windowId));
}

export function createPendingPayload({
  id,
  text,
  provider,
  autoSubmit,
  target,
  createdAt = Date.now(),
}) {
  if (!id) throw new TypeError('Payload id is required');
  if (!text) throw new TypeError('Payload text is required');
  if (!provider) throw new TypeError('Payload provider is required');
  if (!Number.isFinite(createdAt)) throw new TypeError('Payload createdAt must be finite');

  if (target?.kind === 'tab') {
    if (!Number.isInteger(target.tabId)) throw new TypeError('Tab payload target requires an integer tabId');
  } else if (target?.kind === 'sidepanel') {
    if (!Number.isInteger(target.windowId)) throw new TypeError('Side panel payload target requires an integer windowId');
  } else {
    throw new TypeError('Payload target kind must be tab or sidepanel');
  }

  const payloadTarget = target.kind === 'tab'
    ? { kind: 'tab', tabId: target.tabId }
    : { kind: 'sidepanel', windowId: target.windowId };

  return Object.freeze({
    id,
    text,
    provider,
    autoSubmit,
    target: Object.freeze(payloadTarget),
    createdAt,
  });
}

export function matchPayloadRequest(payload, request, now = Date.now()) {
  if (payload == null) return { matched: false, expired: false };
  if (!hasRequiredFields(payload) || !Number.isFinite(payload.createdAt) || !isValidTarget(payload.target)) {
    return { matched: false, expired: true };
  }

  const age = now - payload.createdAt;
  if (!Number.isFinite(now) || !Number.isFinite(age) || age < 0 || age > PAYLOAD_TTL_MS) {
    return { matched: false, expired: true };
  }
  if (payload.provider !== request?.provider) return { matched: false, expired: false };

  if (payload.target.kind === 'tab') {
    return {
      matched: request?.context === 'tab' && payload.target.tabId === request.tabId,
      expired: false,
    };
  }

  if (payload.target.kind === 'sidepanel') {
    return {
      matched: request?.context === 'sidepanel' && payload.target.windowId === request.windowId,
      expired: false,
    };
  }

  return { matched: false, expired: true };
}
