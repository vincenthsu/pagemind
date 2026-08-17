import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import en from '../lib/locales/en.js';
import zhTW from '../lib/locales/zh_TW.js';
import { DEFAULT_PROMPT_KEYS, DEFAULT_PROMPTS, getDefaultPrompts } from '../lib/providers.js';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  applyI18n,
  applyLocaleSetting,
  getLocale,
  localeTag,
  normalizeLocale,
  resolveLocale,
  setLocale,
  t,
} from '../lib/i18n.js';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test.afterEach(() => setLocale(DEFAULT_LOCALE));

test('every supported locale defines the same message keys', () => {
  const catalogs = { en, zh_TW: zhTW };
  assert.deepEqual(Object.keys(catalogs).sort(), [...SUPPORTED_LOCALES].sort());
  const expected = Object.keys(en).sort();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), expected, `${locale} key mismatch`);
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.notEqual(value.trim(), '', `${locale}.${key} must not be empty`);
      assert.deepEqual(
        [...value.matchAll(/\$([1-9])/g)].map(([, index]) => index).sort(),
        [...en[key].matchAll(/\$([1-9])/g)].map(([, index]) => index).sort(),
        `${locale}.${key} placeholder mismatch`,
      );
    }
  }
});

test('manifest localizes its description through _locales', async () => {
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.description, '__MSG_extDescription__');
  for (const locale of SUPPORTED_LOCALES) {
    const messages = JSON.parse(
      await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'),
    );
    assert.equal(typeof messages.extDescription?.message, 'string');
    assert.notEqual(messages.extDescription.message.trim(), '');
  }
});

test('built-in prompts stay index-stable while following the active locale', () => {
  assert.equal(DEFAULT_PROMPTS.length, DEFAULT_PROMPT_KEYS.length);
  assert.deepEqual(DEFAULT_PROMPTS, DEFAULT_PROMPT_KEYS.map((key) => en[key]));

  setLocale('en');
  assert.deepEqual(getDefaultPrompts(), DEFAULT_PROMPTS);

  setLocale('zh_TW');
  const localized = getDefaultPrompts();
  assert.equal(localized.length, DEFAULT_PROMPTS.length);
  assert.deepEqual(localized, DEFAULT_PROMPT_KEYS.map((key) => zhTW[key]));
  assert.notEqual(localized[0], DEFAULT_PROMPTS[0]);
  for (const prompt of localized) assert.notEqual(prompt.trim(), '');
});

test('normalizeLocale accepts supported tags and rejects everything else', () => {
  assert.equal(normalizeLocale('zh_TW'), 'zh_TW');
  assert.equal(normalizeLocale('zh-TW'), 'zh_TW');
  assert.equal(normalizeLocale('zh-Hant-TW'), 'zh_TW');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('auto'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale('ja'), null);
  assert.equal(normalizeLocale(undefined), null);
});

test('resolveLocale prefers the stored setting, then the UI language, then English', () => {
  assert.equal(resolveLocale('zh_TW', 'en-US'), 'zh_TW');
  assert.equal(resolveLocale('auto', 'zh-TW'), 'zh_TW');
  assert.equal(resolveLocale(undefined, 'ja'), 'en');
  assert.equal(resolveLocale('nope', 'nope'), 'en');
});

test('applyLocaleSetting resolves through the chrome UI language', () => {
  const chromeApi = { i18n: { getUILanguage: () => 'zh-TW' } };
  assert.equal(applyLocaleSetting({}, chromeApi), 'zh_TW');
  assert.equal(getLocale(), 'zh_TW');
  assert.equal(localeTag(), 'zh-TW');
  assert.equal(applyLocaleSetting({ locale: 'en' }, chromeApi), 'en');
  assert.equal(applyLocaleSetting(null, { i18n: { getUILanguage() { throw new Error('nope'); } } }), 'en');
});

test('t substitutes placeholders and falls back to English then the key', () => {
  setLocale('zh_TW');
  assert.equal(t('panelStatusSent', 'Gemini'), '已傳送至 Gemini。');
  setLocale('en');
  assert.equal(t('panelStatusSent', 'Gemini'), 'Sent to Gemini.');
  assert.equal(t('panelStatusSent'), 'Sent to $1.');
  assert.equal(t('does-not-exist'), 'does-not-exist');
});

test('applyI18n localizes text, attributes, and the document language', () => {
  const created = [];
  const element = (attributes) => {
    const node = {
      attributes,
      textContent: '',
      getAttribute: (name) => attributes[name] ?? null,
      setAttribute(name, value) { attributes[name] = value; },
    };
    created.push(node);
    return node;
  };
  const text = element({ 'data-i18n': 'panelSummarize' });
  const titled = element({ 'data-i18n-title': 'settings' });
  const labelled = element({ 'data-i18n-aria-label': 'panelProviderGroup' });
  const placeholder = element({ 'data-i18n-placeholder': 'optionsAddPrompt' });
  const doc = {
    documentElement: { lang: 'en' },
    querySelectorAll(selector) {
      return created.filter((node) => Object.hasOwn(node.attributes, selector.slice(1, -1)));
    },
  };

  setLocale('zh_TW');
  applyI18n(doc);

  assert.equal(doc.documentElement.lang, 'zh-TW');
  assert.equal(text.textContent, zhTW.panelSummarize);
  assert.equal(titled.attributes.title, zhTW.settings);
  assert.equal(labelled.attributes['aria-label'], zhTW.panelProviderGroup);
  assert.equal(placeholder.attributes.placeholder, zhTW.optionsAddPrompt);
});

test('applyI18n tolerates documents without query support', () => {
  applyI18n(undefined);
  applyI18n({});
});
