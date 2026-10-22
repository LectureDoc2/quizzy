import { renderQuiz } from './math-renderer.js';
import { renderCodeInQuiz } from './code-renderer.js';
import { sanitizeQuiz } from './quiz-sanitizer.js';
import { validateQuiz } from './quiz-validator.js';

/**
 * Turn a quiz as authored into the quiz a room plays.
 *
 * Shared by the two doors a quiz can come through -- a presenter's
 * `create_room`, and the practice catalog the server loads from disk -- so that
 * a practice quiz cannot be held to a weaker standard than an uploaded one.
 *
 * Shape first, markup second. A quiz that is not shaped like a quiz must never
 * reach a room: the assumptions it would break are checked in scoring and in
 * the auto-end timer, and the timer runs outside every try/catch. See
 * quiz-validator.js.
 *
 * Quiz markup is authored by the lecturer and rendered as HTML, so it is
 * scrubbed (not escaped): the author is trusted, but should not be able to
 * break their own quiz by accident. See quiz-sanitizer.js for the exact threat
 * model.
 *
 * The three passes run in this order, and the order is load-bearing:
 *
 *   1. code   -- fenced blocks become <pre><code>, with every `&`, `<` and `>`
 *                inside them escaped.
 *   2. markup -- the sanitizer scrubs what the author wrote *around* the code.
 *                It runs second precisely because step 1 has already escaped
 *                the code: a Java sample containing <script>, or an HTML
 *                snippet being taught, would otherwise be swallowed by the
 *                blocklist.
 *   3. math   -- KaTeX runs last and skips the code regions step 1 produced,
 *                so `echo $PATH` is not read as a formula.
 *
 * Steps 1 and 2 both report through `warnings`.
 *
 * @param {unknown} quiz
 * @returns {{valid: true, quiz: object, warnings: string[]} |
 *           {valid: false, errors: string[]}}
 */
export function prepareQuiz(quiz) {
  const structure = validateQuiz(quiz);
  if (!structure.valid) return { valid: false, errors: structure.errors };

  const highlighted = renderCodeInQuiz(quiz);
  const sanitized = sanitizeQuiz(highlighted.quiz);
  return {
    valid: true,
    quiz: renderQuiz(sanitized.quiz),
    warnings: [...highlighted.warnings, ...sanitized.warnings]
  };
}
