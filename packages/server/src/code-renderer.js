/**
 * Server-side syntax highlighting for lecturer-authored quiz markup.
 *
 * The design mirrors math-renderer.js deliberately: the author writes a
 * lightweight delimiter in the quiz JSON, the server turns it into HTML exactly
 * once (when the room opens), and the browser only ever needs a stylesheet. No
 * highlighting library is shipped to participants, and nothing has to run on a
 * phone that is already busy holding a lecture hall's worth of WebSockets.
 *
 * The delimiter is a Markdown-style fence, chosen because it survives JSON
 * string escaping without ceremony and because lecturers already type it:
 *
 *     ```java
 *     public record Point(int x, int y) {}
 *     ```
 *
 * A fence is three or more backticks; the closing fence needs at least as many
 * as the opening one. That is what makes a Markdown *example* containing a
 * fenced block expressible -- open with four backticks and the three-backtick
 * lines inside are content, not structure.
 *
 * ## Why this module must run before the sanitizer
 *
 * highlight.js escapes `&`, `<` and `>` in everything it emits, and so does the
 * plain-text path below. By the time quiz-sanitizer.js sees a code block, the
 * only real tags left are our own `<pre>`, `<code>` and `<span class="hljs-*">`,
 * all of which it passes through untouched. Run in the other order, a Java
 * sample containing `<script>` or an HTML lecture snippet would be eaten by the
 * sanitizer's blocklist -- silently, and only for the authors most likely to
 * paste such a thing on purpose. See the ordering in server.js.
 *
 * ## Why the language is never guessed
 *
 * highlight.js can auto-detect, and on a three-line snippet it is a coin flip
 * between C, C++ and Java. A wrong guess is worse than no highlighting on a
 * projector, so an unlabelled block is rendered as plain text and an unknown
 * label produces a warning the presenter actually sees.
 */

import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * The supported languages, registered explicitly rather than by importing the
 * `highlight.js` barrel: that one pulls in ~190 grammars, most of a megabyte of
 * them, for no benefit to a quiz server.
 *
 * `xml` is highlight.js's name for the grammar that also covers HTML; there is
 * no separate HTML grammar to register.
 */
const LANGUAGES = {
  bash, c, cpp, css, go, java, javascript, json,
  markdown, python, rust, typescript, xml, yaml
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

/**
 * Spellings a lecturer is likely to type, mapped to the grammar that handles
 * them. Everything here is an *author-facing* convenience; the canonical names
 * are the keys of LANGUAGES.
 */
const ALIASES = new Map(Object.entries({
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  js: 'javascript',
  mjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  python3: 'python',
  golang: 'go',
  rs: 'rust',
  md: 'markdown',
  yml: 'yaml',
  html: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  jsonc: 'json'
}));

/** Language labels that explicitly mean "do not highlight this". */
const PLAIN_LANGUAGES = new Set(['text', 'plain', 'plaintext', 'txt', 'none', 'nohighlight']);

/**
 * A fenced block: an opening fence at the start of a line, an optional info
 * string, the body, and a closing fence of at least the same length. An
 * unterminated fence runs to the end of the text -- the same forgiving reading
 * Markdown gives it, and the one that loses the least of the author's content.
 */
const FENCE_PATTERN = /^([ \t]*)(`{3,})[ \t]*([^\n`]*)\n([\s\S]*?)(?:^[ \t]*\2`*[ \t]*$|(?![\s\S]))/gm;

/** Escape text that will sit inside an element, never inside an attribute. */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resolve an author-written info string to a registered grammar.
 *
 * @param {string} info the raw text after the opening fence
 * @returns {{language: string|null, unknown: string|null}} `language` is null
 *   for a block that should be rendered as plain text; `unknown` carries the
 *   label back to the caller when it was a label we simply do not know.
 */
function resolveLanguage(info) {
  /* Markdown allows attributes after the language ("```js {highlight=2}").
     Only the first word is the language; the rest is not ours to interpret. */
  const label = info.trim().split(/[\s,{]/, 1)[0].toLowerCase();

  if (label === '') return { language: null, unknown: null };
  if (PLAIN_LANGUAGES.has(label)) return { language: null, unknown: null };

  const canonical = ALIASES.get(label) || label;
  if (Object.hasOwn(LANGUAGES, canonical)) return { language: canonical, unknown: null };

  return { language: null, unknown: label };
}

/**
 * Trailing newline handling: the body captured by FENCE_PATTERN keeps the
 * newline that precedes the closing fence, and a `<pre>` would render it as a
 * blank final line. Leading blank lines are the same accident in the other
 * direction.
 */
function trimBlockBody(body) {
  return body.replace(/^\n+/, '').replace(/\s+$/, '');
}

/**
 * Render every fenced code block in a text string.
 *
 * @param {string} text
 * @returns {{text: string, warnings: string[]}}
 */
function renderCode(text) {
  if (typeof text !== 'string' || text === '') {
    return { text: typeof text === 'string' ? text : '', warnings: [] };
  }

  const warnings = [];
  FENCE_PATTERN.lastIndex = 0;

  const rendered = text.replace(FENCE_PATTERN, (_match, _indent, _fence, info, body) => {
    const source = trimBlockBody(body);
    const { language, unknown } = resolveLanguage(info);

    if (unknown !== null) {
      warnings.push(`code block labelled "${unknown}" uses a language that is not supported; rendered as plain text`);
    }

    if (language === null) {
      return `<pre class="quiz-code"><code class="hljs">${escapeHtml(source)}</code></pre>`;
    }

    let html;
    try {
      /* `ignoreIllegals` keeps a grammar's "this cannot be Rust" rule from
         throwing on a deliberately incomplete lecture snippet -- which is what
         most slide code is. Worst case the colours degrade; nothing is lost. */
      html = hljs.highlight(source, { language, ignoreIllegals: true }).value;
    } catch {
      /* Defensive: a grammar bug must not cost the lecturer their question. */
      warnings.push(`code block labelled "${language}" could not be highlighted; rendered as plain text`);
      return `<pre class="quiz-code"><code class="hljs">${escapeHtml(source)}</code></pre>`;
    }

    return `<pre class="quiz-code"><code class="hljs language-${language}">${html}</code></pre>`;
  });

  return { text: rendered, warnings };
}

/**
 * Render the code blocks of a single question.
 *
 * @param {object} question
 * @returns {{question: object, warnings: string[]}}
 */
function renderCodeInQuestion(question) {
  const warnings = [];
  const rendered = { ...question };

  const text = renderCode(question.text);
  rendered.text = text.text;
  warnings.push(...text.warnings);

  if (Array.isArray(question.options)) {
    rendered.options = question.options.map((option, index) => {
      const cleaned = renderCode(option);
      warnings.push(...cleaned.warnings.map(w => `option ${index + 1}: ${w}`));
      return cleaned.text;
    });
  }

  return { question: rendered, warnings };
}

/**
 * Render the code blocks of a complete quiz.
 *
 * Shaped like sanitizeQuiz's return value on purpose: both feed the same
 * presenter-visible warning channel, and the room-open path composes them.
 *
 * @param {object} quiz
 * @returns {{quiz: object, warnings: string[]}}
 */
function renderCodeInQuiz(quiz) {
  const warnings = [];

  const questions = (quiz.questions || []).map((question, index) => {
    const rendered = renderCodeInQuestion(question);
    warnings.push(...rendered.warnings.map(w => `question ${index + 1}: ${w}`));
    return rendered.question;
  });

  return { quiz: { ...quiz, questions }, warnings };
}

export { renderCode, renderCodeInQuestion, renderCodeInQuiz, LANGUAGES, ALIASES };
