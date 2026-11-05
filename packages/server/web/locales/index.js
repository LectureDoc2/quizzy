/**
 * The languages the participant pages speak, one resource file each.
 *
 * Adding a language: copy en.json to <tag>.json, translate every value, and
 * register it below. `test/i18n.test.js` then checks that the new file has
 * every key, every placeholder and every plural form that English has. See
 * DEVELOPMENT.md, "Translations".
 *
 * The files are imported rather than fetched, so esbuild inlines them into
 * each page bundle: no extra request, and no change to any page's CSP.
 */
import de from './de.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

/** Resource files by BCP 47 language tag. */
export const LOCALES = { en, de };

/** Used when the browser prefers none of LOCALES, and for any missing key. */
export const FALLBACK_LOCALE = 'en';
