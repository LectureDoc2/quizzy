import katex from 'katex';

const DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false }
];

/**
 * Render all math in a text string using KaTeX.
 * Replaces math delimiters with rendered HTML.
 */
function renderMath(text) {
  if (!text) return text;

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
