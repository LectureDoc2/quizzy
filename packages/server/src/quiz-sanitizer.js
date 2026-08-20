/**
 * Safety net for lecturer-authored quiz markup.
 *
 * Question text and options are deliberately rendered as HTML (they may contain
 * inline SVG, tables, code, and KaTeX output), so they cannot be escaped. The
 * threat model here is NOT a malicious quiz author: whoever writes the quiz
 * already controls the presentation, and by holding the quiz JSON they already
 * hold the presenter token. The purpose of this module is to stop an author
 * from accidentally breaking their own quiz -- pasting markup that carries a
 * stray event handler, a <script> block copied along with a snippet from the
 * web, or a <style> rule that leaks out and wrecks the surrounding page.
 *
 * Consequently this is a *blocklist*, and a blocklist on HTML is not a security
 * boundary. It must never be relied upon to make untrusted input safe.
 * Untrusted input (anything originating from a participant) is escaped or
 * inserted via textContent instead, and never passes through here.
 */

/** Elements dropped together with their content. */
const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'link',
  'meta',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'template'
]);

/** Attributes whose value is treated as a URL. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'data']);

/** URL schemes that execute code rather than fetch a resource. */
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|livescript|data:text\/html)/i;

/** Matches a start or end tag, tolerating quoted attribute values containing '>'. */
const TAG_PATTERN = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

/** Matches a single attribute: name, optional ="value" / ='value' / =value. */
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

/**
 * Normalize an attribute value far enough to recognize a disguised scheme:
 * strip quotes, decode HTML entities, and remove whitespace/control characters
 * that browsers ignore when parsing a URL (e.g. "java\tscript:").
 */
function normalizeUrlValue(rawValue) {
  if (rawValue === undefined) return '';
  let value = rawValue;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '')
    .replace(/&newline;/gi, '');
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0020\u00a0\u007f]/g, '').toLowerCase();
}

/**
 * Remove forbidden elements together with the content they wrap.
 * Unbalanced or self-closing occurrences are removed as bare tags.
 */
function stripForbiddenElements(html, warnings) {
  let result = html;
  for (const tag of FORBIDDEN_ELEMENTS) {
    const withContent = new RegExp(`<${tag}\\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    const bare = new RegExp(`<\\/?${tag}\\b(?:"[^"]*"|'[^']*'|[^>"'])*\\/?>`, 'gi');
    result = result.replace(withContent, () => {
      warnings.push(`removed <${tag}> element`);
      return '';
    });
    result = result.replace(bare, () => {
      warnings.push(`removed <${tag}> element`);
      return '';
    });
  }
  return result;
}

/** Rewrite the attribute list of a single tag, dropping unsafe attributes. */
function cleanAttributes(tagName, attributeText, warnings) {
  let cleaned = '';
  let match;
  ATTRIBUTE_PATTERN.lastIndex = 0;
  while ((match = ATTRIBUTE_PATTERN.exec(attributeText)) !== null) {
    const [, name, rawValue] = match;
    const lowerName = name.toLowerCase();

    if (lowerName.startsWith('on')) {
      warnings.push(`removed inline event handler ${lowerName}="..." from <${tagName}>`);
      continue;
    }

    if (URL_ATTRIBUTES.has(lowerName) && DANGEROUS_SCHEME.test(normalizeUrlValue(rawValue))) {
      warnings.push(`removed ${lowerName} with an executable URL scheme from <${tagName}>`);
      continue;
    }

    cleaned += rawValue === undefined ? ` ${name}` : ` ${name}=${rawValue}`;
  }
  return cleaned;
}

/**
 * Sanitize a single HTML fragment authored by the lecturer.
 *
 * @param {string} html
 * @returns {{html: string, warnings: string[]}}
 */
function sanitizeHtml(html) {
  const warnings = [];
  if (typeof html !== 'string' || html === '') {
    return { html: typeof html === 'string' ? html : '', warnings };
  }

  const withoutForbidden = stripForbiddenElements(html, warnings);

  TAG_PATTERN.lastIndex = 0;
  const result = withoutForbidden.replace(TAG_PATTERN, (tag, tagName, attributeText) => {
    if (tag.startsWith('</')) return tag;
    const selfClosing = /\/>$/.test(tag);
    const cleanedAttributes = cleanAttributes(tagName, attributeText, warnings);
    return `<${tagName}${cleanedAttributes}${selfClosing ? ' /' : ''}>`;
  });

  return { html: result, warnings };
}

/**
 * Sanitize every author-controlled HTML field of a quiz.
 * Returns a new quiz object plus a human-readable list of what was changed, so
 * the presenter can be told about markup that was silently dropped.
 *
 * @param {object} quiz
 * @returns {{quiz: object, warnings: string[]}}
 */
function sanitizeQuiz(quiz) {
  const warnings = [];

  const questions = (quiz.questions || []).map((question, index) => {
    const sanitized = { ...question };
    const label = `question ${index + 1}`;

    const text = sanitizeHtml(question.text);
    sanitized.text = text.html;
    warnings.push(...text.warnings.map(w => `${label}: ${w}`));

    if (Array.isArray(question.options)) {
      sanitized.options = question.options.map((option, optionIndex) => {
        const cleaned = sanitizeHtml(option);
        warnings.push(...cleaned.warnings.map(w => `${label}, option ${optionIndex + 1}: ${w}`));
        return cleaned.html;
      });
    }

    return sanitized;
  });

  return { quiz: { ...quiz, questions }, warnings };
}

export { sanitizeHtml, sanitizeQuiz, FORBIDDEN_ELEMENTS };
