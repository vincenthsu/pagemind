// Runtime message lookup shared by every extension surface.
// Locale resolution order: explicit `locale` setting → browser UI language → English.
// Catalogs are bundled as modules (not chrome.i18n) so the user can override the
// language independently of the browser UI locale.

import en from './locales/en.js';
import zhTW from './locales/zh_TW.js';

export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh_TW']);

const CATALOGS = Object.freeze({ en, zh_TW: zhTW });
const I18N_ATTRIBUTES = Object.freeze([
  ['data-i18n-title', 'title'],
  ['data-i18n-aria-label', 'aria-label'],
  ['data-i18n-placeholder', 'placeholder'],
]);

let activeLocale = DEFAULT_LOCALE;

export function normalizeLocale(value) {
  if (typeof value !== 'string' || value === '' || value === 'auto') return null;
  const tag = value.replace(/-/g, '_');
  if (SUPPORTED_LOCALES.includes(tag)) return tag;
  const lower = tag.toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh_tw') || lower.startsWith('zh_hant')
    || lower.startsWith('zh_hk') || lower.startsWith('zh_mo')) return 'zh_TW';
  if (lower.startsWith('en')) return 'en';
  return null;
}

export function resolveLocale(setting, uiLanguage) {
  return normalizeLocale(setting) ?? normalizeLocale(uiLanguage) ?? DEFAULT_LOCALE;
}

export function setLocale(locale) {
  activeLocale = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

export function localeTag(locale = activeLocale) {
  return locale.replace(/_/g, '-');
}

function uiLanguage(chromeApi) {
  try {
    return chromeApi?.i18n?.getUILanguage?.() ?? null;
  } catch {
    return null;
  }
}

// Applies the locale from an already-loaded settings object so no extra
// storage round-trip is required on any page.
export function applyLocaleSetting(settings, chromeApi = globalThis.chrome) {
  const stored = settings && typeof settings === 'object' ? settings.locale : undefined;
  return setLocale(resolveLocale(stored, uiLanguage(chromeApi)));
}

export function t(key, ...substitutions) {
  const template = CATALOGS[activeLocale]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key];
  if (typeof template !== 'string') return key;
  if (substitutions.length === 0) return template;
  return template.replace(/\$([1-9])/g, (match, index) => {
    const value = substitutions[Number(index) - 1];
    return value === undefined ? match : String(value);
  });
}

export function applyI18n(doc = globalThis.document) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return;
  try {
    if (doc.documentElement) doc.documentElement.lang = localeTag();
    for (const element of doc.querySelectorAll('[data-i18n]') ?? []) {
      const key = element.getAttribute?.('data-i18n');
      if (key) element.textContent = t(key);
    }
    for (const [attribute, target] of I18N_ATTRIBUTES) {
      for (const element of doc.querySelectorAll(`[${attribute}]`) ?? []) {
        const key = element.getAttribute?.(attribute);
        if (key) element.setAttribute(target, t(key));
      }
    }
  } catch {
    // Localization is cosmetic; never block page initialization.
  }
}
