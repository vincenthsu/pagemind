import { PROVIDERS } from './providers.js';

export const PROVIDER_HOSTS = Object.freeze({
  chatgpt: Object.freeze(['chatgpt.com', 'chat.openai.com']),
  gemini: Object.freeze(['gemini.google.com']),
  claude: Object.freeze(['claude.ai']),
  grok: Object.freeze(['grok.com']),
});

const PROVIDER_IDS = Object.keys(PROVIDERS);
const BUILTIN_HOST_OWNERS = new Map(
  Object.entries(PROVIDER_HOSTS).flatMap(([provider, hosts]) => hosts.map((host) => [host, provider])),
);

function parseHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function getAcceptedCustomUrls(customUrls) {
  const customUrlsByProvider = new Map();
  const providersByCustomHost = new Map();

  for (const provider of PROVIDER_IDS) {
    const customUrl = parseHttpsUrl(customUrls[provider]);
    if (!customUrl) {
      continue;
    }

    const builtInOwner = BUILTIN_HOST_OWNERS.get(customUrl.hostname);
    if (builtInOwner && builtInOwner !== provider) {
      continue;
    }

    customUrlsByProvider.set(provider, customUrl);
    if (!builtInOwner) {
      const providers = providersByCustomHost.get(customUrl.hostname) ?? [];
      providers.push(provider);
      providersByCustomHost.set(customUrl.hostname, providers);
    }
  }

  for (const providers of providersByCustomHost.values()) {
    if (providers.length > 1) {
      for (const provider of providers) {
        customUrlsByProvider.delete(provider);
      }
    }
  }

  return customUrlsByProvider;
}

export function resolveProviderUrl(provider, customUrls = {}) {
  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  return getAcceptedCustomUrls(customUrls).get(provider)?.href ?? PROVIDERS[provider].url;
}

export function isValidCustomProviderUrl(value) {
  return value == null || value === '' || Boolean(parseHttpsUrl(value));
}

export function buildEmbeddingRules(extensionId, customUrls = {}) {
  const hosts = new Set(Object.values(PROVIDER_HOSTS).flat());

  for (const customUrl of getAcceptedCustomUrls(customUrls).values()) {
    hosts.add(customUrl.hostname);
  }

  return [...hosts]
    .sort()
    .map((host, index) => ({
      id: 1000 + index,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: {
        requestDomains: [host],
        initiatorDomains: [extensionId],
        resourceTypes: ['sub_frame'],
      },
    }));
}

export const CUSTOM_SCRIPT_IDS = Object.freeze([
  ...PROVIDER_IDS.map((provider) => `pagemind-custom-${provider}-isolated`),
  'pagemind-custom-grok-main',
]);

export function buildCustomContentScriptRegistrations(customUrls = {}) {
  const registrations = [];
  const acceptedCustomUrls = getAcceptedCustomUrls(customUrls);

  for (const provider of PROVIDER_IDS) {
    const customUrl = acceptedCustomUrls.get(provider);
    if (!customUrl || PROVIDER_HOSTS[provider].includes(customUrl.hostname)) {
      continue;
    }

    const matches = [`https://${customUrl.hostname}/*`];
    const registration = {
      id: `pagemind-custom-${provider}-isolated`,
      matches,
      js: ['injectors/bridge.js', `injectors/${provider}.js`],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
      world: 'ISOLATED',
    };
    registrations.push(registration);

    if (provider === 'grok') {
      registrations.push({
        ...registration,
        id: 'pagemind-custom-grok-main',
        js: ['injectors/grok-main.js'],
        world: 'MAIN',
      });
    }
  }

  return registrations;
}
