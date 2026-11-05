/**
 * Translations for the browser pages.
 *
 * The texts live in web/locales/<tag>.json: flat objects from a dotted key to
 * a string, or -- for text that depends on a number -- to an object of CLDR
 * plural forms ({ "one": ..., "other": ... }) chosen by `params.count`.
 * Placeholders are written {name}.
 *
 * The language is the browser's (navigator.languages), unless the page was
 * opened with ?lang=<tag>. Nothing is stored on the device: the parameter is
 * carried along on the pages' own links instead.
 *
 * This module touches no browser globals when it is imported, so that the
 * unit tests can load it in Node.
 */
import { FALLBACK_LOCALE, LOCALES } from '../locales/index.js';

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The first of `requested` that `supported` has, matched exactly or by its
 * primary language subtag ("de-AT" finds "de"), else `fallback`.
 *
 * @param {readonly string[]} requested Language tags, most preferred first.
 * @param {readonly string[]} supported
 * @param {string|null} fallback
 * @returns {string|null}
 */
export function negotiateLocale(requested, supported, fallback) {
  const byLowerCase = new Map(supported.map((tag) => [tag.toLowerCase(), tag]));
  for (const tag of requested) {
    if (typeof tag !== 'string' || tag === '') continue;
    const lower = tag.toLowerCase();
    const match = byLowerCase.get(lower) ?? byLowerCase.get(lower.split('-')[0]);
    if (match) return match;
  }
  return fallback;
}

/**
 * The language a page should use: a supported ?lang= first, then the
 * browser's preferences, then FALLBACK_LOCALE.
 *
 * @param {string} search The page's location.search.
 * @param {readonly string[]|undefined} languages navigator.languages.
 * @param {readonly string[]} [supported]
 * @returns {{locale: string, explicit: boolean}} `explicit` when ?lang= chose it.
 */
export function detectLocale(search, languages, supported = Object.keys(LOCALES)) {
  const requested = new URLSearchParams(search).get('lang');
  if (requested) {
    const locale = negotiateLocale([requested], supported, null);
    if (locale) return { locale, explicit: true };
  }
  return { locale: negotiateLocale(languages || [], supported, FALLBACK_LOCALE), explicit: false };
}

/** Escape text for use inside an HTML template. */
export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The translation functions for one language.
 *
 * Numbers in placeholders are formatted for that language, but grouped only
 * from five digits on ('min2'): an estimate of a year should read 1990, not
 * 1.990.
 *
 * @param {{locale: string, explicit?: boolean}} choice As from detectLocale().
 * @param {Record<string, object>} [resources] Resource files by language tag.
 */
export function createI18n({ locale, explicit = false }, resources = LOCALES) {
  const sources = [locale, FALLBACK_LOCALE]
    .filter((tag, i, all) => resources[tag] && all.indexOf(tag) === i)
    .map((tag) => ({ messages: resources[tag], plurals: new Intl.PluralRules(tag) }));
  const numbers = new Intl.NumberFormat(locale, { useGrouping: 'min2' });
  const lists = new Intl.ListFormat(locale, { type: 'conjunction' });

  const format = (value) => (typeof value === 'number' ? numbers.format(value) : String(value));
  const find = (key) => sources.find(({ messages }) => Object.hasOwn(messages, key));

  /**
   * The text for `key`, in this language if it has one, else in English,
   * else the key itself -- visibly wrong rather than blank.
   *
   * @param {string} key
   * @param {Record<string, unknown>} [params] Placeholder values; `count`
   *   also selects the plural form.
   */
  function t(key, params = {}) {
    const source = find(key);
    if (!source) return key;
    let text = source.messages[key];
    if (typeof text === 'object' && text !== null) {
      text = text[source.plurals.select(Number(params.count))] ?? text.other;
    }
    return String(text).replace(PLACEHOLDER, (placeholder, name) =>
      Object.hasOwn(params, name) ? format(params[name]) : placeholder
    );
  }

  return {
    locale,
    t,
    /** t(), escaped for an HTML template. */
    html: (key, params) => escapeHtml(t(key, params)),
    has: (key) => find(key) !== undefined,
    formatNumber: format,
    /** "1, 2 and 3", in this language. */
    formatList: (items) => lists.format(items.map(format)),
    /** { lang } when ?lang= chose the language, for the page's own links. */
    langParam: () => (explicit ? { lang: locale } : {})
  };
}

/**
 * Set the document's language and fill every [data-i18n] element -- the
 * static text of a page, <title> included -- through textContent, so that a
 * resource file can never inject markup.
 *
 * @param {ReturnType<typeof createI18n>} i18n
 * @param {Document} [doc]
 */
export function translatePage(i18n, doc = document) {
  doc.documentElement.lang = i18n.locale;
  for (const element of doc.querySelectorAll('[data-i18n]')) {
    element.textContent = i18n.t(element.dataset.i18n);
  }
}
