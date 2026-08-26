import katex from 'katex';

const DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false }
];

/**
 * Regions this module must not touch.
 *
 * `$` is a math delimiter here and a variable sigil in half the languages a
 * lecture ever shows: `echo $PATH` in bash, `${x}` in a template literal, `$_`
 * in Perl. Before code blocks were rendered server-side nobody noticed, because
 * a `$` in prose is almost always math. Now that code-renderer.js runs first and
 * wraps every sample in `<pre><code>`, those regions are recognisable, and math
 * rendering skips them: a bash snippet must survive being next to a formula.
 *
 * The backreference keeps `<pre>` matching to its own `</pre>` rather than to
 * the `</code>` nested inside it. The attribute alternation tolerates a quoted
 * attribute value containing `>`, the same way quiz-sanitizer.js does.
 */
const CODE_REGION = /<(pre|code)\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Render all math in a fragment that is known to contain no code region.
 */
function renderMathFragment(text) {
  let result = '';
  let i = 0;

  while (i < text.length) {
    let found = false;

    for (const delim of DELIMITERS) {
      if (text.substring(i, i + delim.left.length) === delim.left) {
        const endPos = text.indexOf(delim.right, i + delim.left.length);
        if (endPos !== -1) {
          const mathExpr = text.substring(i + delim.left.length, endPos);
          try {
            const rendered = katex.renderToString(mathExpr, {
              displayMode: delim.display,
              throwOnError: false
            });
            result += rendered;
          } catch (err) {
            // Fallback: keep original text if rendering fails
            result += text.substring(i, endPos + delim.right.length);
          }
          i = endPos + delim.right.length;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      result += text[i];
      i++;
    }
  }

  return result;
}

/**
 * Render all math in a text string using KaTeX.
 * Replaces math delimiters with rendered HTML, leaving code blocks alone.
 */
function renderMath(text) {
  if (!text) return text;

  let result = '';
  let cursor = 0;
  let match;

  CODE_REGION.lastIndex = 0;
  while ((match = CODE_REGION.exec(text)) !== null) {
    result += renderMathFragment(text.slice(cursor, match.index));
    result += match[0]; // verbatim: already-rendered code
    cursor = match.index + match[0].length;
  }

  return result + renderMathFragment(text.slice(cursor));
}

/**
 * Render math in a single question object.
 */
function renderQuestion(question) {
  const rendered = { ...question };
  rendered.text = renderMath(question.text);
  if (question.options) {
    rendered.options = question.options.map(opt => renderMath(opt));
  }
  return rendered;
}

/**
 * Render math in a complete quiz object.
 * Returns a new quiz object with all math rendered as HTML.
 */
function renderQuiz(quiz) {
  return {
    ...quiz,
    questions: quiz.questions.map(q => renderQuestion(q))
  };
}

export { renderMath, renderQuestion, renderQuiz };
