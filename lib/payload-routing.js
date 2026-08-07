export const PAYLOAD_TTL_MS = 60_000;

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

  if (target?.kind === 'tab') {
    if (!Number.isInteger(target.tabId)) throw new TypeError('Tab payload target requires an integer tabId');
  } else if (target?.kind === 'sidepanel') {
    if (!Number.isInteger(target.windowId)) throw new TypeError('Side panel payload target requires an integer windowId');
  } else {
    throw new TypeError('Payload target kind must be tab or sidepanel');
  }

  return { id, text, provider, autoSubmit, target, createdAt };
}

export function matchPayloadRequest(payload, request, now = Date.now()) {
  if (payload == null) return { matched: false, expired: false };
  if (now - payload.createdAt > PAYLOAD_TTL_MS) return { matched: false, expired: true };
  if (payload.provider !== request?.provider) return { matched: false, expired: false };

  if (payload.target.kind === 'tab') {
    return {
      matched: request?.context === 'tab' && payload.target.tabId === request.tabId,
      expired: false,
    };
  }

  return {
    matched: request?.context === 'sidepanel' && payload.target.windowId === request.windowId,
    expired: false,
  };
}
