import { PROVIDERS } from './providers.js';

export const PROVIDER_HOSTS = {
  chatgpt: ['chatgpt.com', 'chat.openai.com'],
  gemini: ['gemini.google.com'],
  claude: ['claude.ai'],
  grok: ['grok.com'],
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

function parseHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function resolveProviderUrl(provider, customUrls = {}) {
  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  return parseHttpsUrl(customUrls[provider])?.href ?? PROVIDERS[provider].url;
}

export function isValidCustomProviderUrl(value) {
  return value == null || value === '' || Boolean(parseHttpsUrl(value));
}

export function buildEmbeddingRules(extensionId, customUrls = {}) {
  const hosts = new Set(Object.values(PROVIDER_HOSTS).flat());

  for (const provider of PROVIDER_IDS) {
    const customUrl = parseHttpsUrl(customUrls[provider]);
    if (customUrl) {
      hosts.add(customUrl.hostname);
    }
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

  for (const provider of PROVIDER_IDS) {
    const customUrl = parseHttpsUrl(customUrls[provider]);
    if (!customUrl || PROVIDER_HOSTS[provider].includes(customUrl.hostname)) {
      continue;
    }

    const matches = [`https://${customUrl.hostname}/*`];
    const registration = {
      id: `pagemind-custom-${provider}-isolated`,
      matches,
      js: ['bridge.js', `${provider}-injector.js`],
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
        js: ['grok-main.js'],
        world: 'MAIN',
      });
    }
  }

  return registrations;
}
