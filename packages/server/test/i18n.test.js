import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createI18n, detectLocale, escapeHtml, negotiateLocale } from '../web/js/i18n.js';
import { FALLBACK_LOCALE, LOCALES } from '../web/locales/index.js';

const PLACEHOLDER = /\{(\w+)\}/g;

/** The placeholder names in a resource entry, plural forms included. */
function placeholders(entry) {
  const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
  return [...new Set(texts.flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1])))].sort();
}

describe('negotiateLocale', () => {
  const supported = ['en', 'de'];

  it('takes the first supported preference, exactly or by primary subtag', () => {
    assert.strictEqual(negotiateLocale(['de'], supported, 'en'), 'de');
    assert.strictEqual(negotiateLocale(['de-AT', 'en'], supported, 'en'), 'de');
    assert.strictEqual(negotiateLocale(['fr-FR', 'de-CH', 'en'], supported, 'en'), 'de');
    assert.strictEqual(negotiateLocale(['EN-gb'], supported, 'de'), 'en');
  });

  it('falls back when nothing matches', () => {
    assert.strictEqual(negotiateLocale(['fr', 'es'], supported, 'en'), 'en');
    assert.strictEqual(negotiateLocale([], supported, 'en'), 'en');
    assert.strictEqual(negotiateLocale(['', null], supported, null), null);
  });

  it('keeps the spelling of the supported tag', () => {
    assert.strictEqual(negotiateLocale(['pt-br'], ['en', 'pt-BR'], 'en'), 'pt-BR');
  });
});

describe('detectLocale', () => {
  it('follows the browser, and English when it prefers neither language', () => {
    assert.deepStrictEqual(detectLocale('', ['de-DE', 'en']), { locale: 'de', explicit: false });
    assert.deepStrictEqual(detectLocale('?room=AB12', ['fr-FR']), { locale: 'en', explicit: false });
    assert.deepStrictEqual(detectLocale('', undefined), { locale: 'en', explicit: false });
  });

  it('lets ?lang= override the browser', () => {
    assert.deepStrictEqual(detectLocale('?room=AB12&lang=en', ['de-DE']), { locale: 'en', explicit: true });
    assert.deepStrictEqual(detectLocale('?lang=de-AT', ['en-US']), { locale: 'de', explicit: true });
  });

  it('ignores a ?lang= it does not speak', () => {
    assert.deepStrictEqual(detectLocale('?lang=fr', ['de-DE']), { locale: 'de', explicit: false });
  });
});

describe('createI18n', () => {
  const resources = {
    en: {
      greeting: 'Hello {name}',
      items: { one: '{count} item', other: '{count} items' },
      onlyEnglish: 'English only',
      markup: '<b>{name}</b>'
    },
    de: {
      greeting: 'Hallo {name}',
      items: { one: '{count} Element', other: '{count} Elemente' }
    }
  };

  it('fills placeholders and leaves unknown ones visible', () => {
    const { t } = createI18n({ locale: 'de' }, resources);
    assert.strictEqual(t('greeting', { name: 'Ada' }), 'Hallo Ada');
    assert.strictEqual(t('greeting'), 'Hallo {name}');
  });

  it('chooses the plural form by count', () => {
    const { t } = createI18n({ locale: 'de' }, resources);
    assert.strictEqual(t('items', { count: 1 }), '1 Element');
    assert.strictEqual(t('items', { count: 0 }), '0 Elemente');
    assert.strictEqual(t('items', { count: 3 }), '3 Elemente');
  });

  it('falls back to English, then to the key itself', () => {
    const i18n = createI18n({ locale: 'de' }, resources);
    assert.strictEqual(i18n.t('onlyEnglish'), 'English only');
    assert.strictEqual(i18n.t('missing.key'), 'missing.key');
    assert.strictEqual(i18n.has('onlyEnglish'), true);
    assert.strictEqual(i18n.has('missing.key'), false);
  });

  it('formats numbers for the language, without grouping a year', () => {
    const de = createI18n({ locale: 'de' }, resources);
    assert.strictEqual(de.formatNumber(1990), '1990');
    assert.strictEqual(de.formatNumber(12345.5), '12.345,5');
    assert.strictEqual(de.t('items', { count: 12345 }), '12.345 Elemente');
    assert.strictEqual(createI18n({ locale: 'en' }, resources).formatNumber(12345.5), '12,345.5');
  });

  it('joins lists in the language', () => {
    assert.strictEqual(createI18n({ locale: 'de' }, resources).formatList([1, 2, 3]), '1, 2 und 3');
    assert.strictEqual(createI18n({ locale: 'en' }, resources).formatList([1, 2]), '1 and 2');
  });

  it('escapes for HTML templates', () => {
    const { html } = createI18n({ locale: 'en' }, resources);
    assert.strictEqual(html('markup', { name: '"x" & y' }), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    assert.strictEqual(escapeHtml("<'>"), '&lt;&#39;&gt;');
  });

  it('carries ?lang= on links only when it chose the language', () => {
    assert.deepStrictEqual(createI18n({ locale: 'de', explicit: true }, resources).langParam(), { lang: 'de' });
    assert.deepStrictEqual(createI18n({ locale: 'de' }, resources).langParam(), {});
  });
});

describe('resource files', () => {
  const reference = LOCALES[FALLBACK_LOCALE];

  it('include the fallback language', () => {
    assert.ok(reference, `${FALLBACK_LOCALE}.json must be registered in web/locales/index.js`);
  });

  it('have every key the participant pages ask for by name', () => {
    // Any quoted 'namespace.key' in the sources, so `t(a ? 'x.y' : 'x.z')` is
    // covered too. Keys built at run time (`error.${code}`) are not.
    const namespaces = new Set(Object.keys(reference).map((key) => key.split('.')[0]));
    const sources = ['js/quiz-client.js', 'js/practice-list.js', 'join.html', 'practice.html'];
    for (const source of sources) {
      const text = readFileSync(new URL(`../web/${source}`, import.meta.url), 'utf8');
      for (const [, key] of text.matchAll(/['"`]([a-zA-Z]+(?:\.\w+)+)['"`]/g)) {
        // 'practice.html' is a file name, not a key.
        if (!namespaces.has(key.split('.')[0]) || /\.(html|js|json|css)$/.test(key)) continue;
        assert.ok(Object.hasOwn(reference, key), `${source} uses ${key}, which ${FALLBACK_LOCALE}.json lacks`);
      }
    }
  });

  it('translate every error code the server sends', () => {
    // Presenter-only: the participant pages never show them.
    const presenterOnly = new Set(['invalid_quiz']);
    for (const source of ['server.js', 'name-validator.js', 'rooms.js']) {
      const text = readFileSync(new URL(`../src/${source}`, import.meta.url), 'utf8');
      for (const [, code] of text.matchAll(/code: '(\w+)'/g)) {
        if (presenterOnly.has(code)) continue;
        assert.ok(Object.hasOwn(reference, `error.${code}`), `${source} sends ${code}, which has no error.${code}`);
      }
    }
  });

  for (const [locale, messages] of Object.entries(LOCALES)) {
    describe(`${locale}.json`, () => {
      it('has exactly the keys of the fallback language', () => {
        assert.deepStrictEqual(Object.keys(messages).sort(), Object.keys(reference).sort());
      });

      it('uses the same placeholders as the fallback language', () => {
        for (const [key, entry] of Object.entries(messages)) {
          if (!Object.hasOwn(reference, key)) continue;
          assert.deepStrictEqual(placeholders(entry), placeholders(reference[key]), `placeholders of ${key}`);
        }
      });

      it('has every plural form the language needs, and only strings otherwise', () => {
        const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        for (const [key, entry] of Object.entries(messages)) {
          if (typeof entry === 'string') {
            assert.notStrictEqual(entry.trim(), '', `${key} is empty`);
            continue;
          }
          assert.strictEqual(typeof entry, 'object', `${key} must be a string or plural forms`);
          assert.strictEqual(
            typeof reference[key], 'object', `${key} is plural here but not in ${FALLBACK_LOCALE}.json`
          );
          for (const category of categories) {
            assert.strictEqual(typeof entry[category], 'string', `${key} lacks the "${category}" form`);
          }
          for (const category of Object.keys(entry)) {
            assert.ok(categories.includes(category), `${key} has a "${category}" form ${locale} does not use`);
          }
        }
      });
    });
  }
});
