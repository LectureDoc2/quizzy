/**
 * The one process in which KaTeX and highlight.js run.
 *
 * Quiz markup reaches the server from anyone who can open a WebSocket:
 * `create_room` needs no account, only a quiz. So the two third-party parsers
 * the pipeline relies on see input from strangers, and a bug in either -- a
 * regular expression that backtracks forever, a macro expansion that never
 * stops, a prototype it pollutes -- must not land in the process that holds
 * every running lecture. Nor should a compromised release of either package,
 * whose code runs the moment it is imported.
 *
 * Hence this file. It is started once per quiz, by render-sandbox.js (spawned
 * as a child process) or by systemd (socket activation, see DEPLOY.md), and
 * speaks the same tiny protocol either way:
 *
 *   stdin   the quiz as JSON, terminated by end-of-file
 *   stdout  {"ok": true, "questions": [{"text", "options"?}], "warnings": [...]}
 *           or {"ok": false, "errors": [...]}
 *
 * It returns only the rendered strings. The server keeps its own copy of
 * everything else -- types, correct answers, time limits -- so that nothing a
 * subverted worker says can change how a quiz is scored. See render-sandbox.js
 * for that side, and for the flags this process runs under.
 */

import { prepareQuiz } from './quiz-pipeline.js';

/**
 * Twice the server's 1 MB message limit. The request is the quiz re-serialized
 * by the server, which is normally smaller than the message it arrived in; the
 * margin is for escapes that serialize longer than they were written.
 */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function reply(message) {
  process.stdout.end(JSON.stringify(message));
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const request = await readRequest();
  if (request === null) {
    reply({ ok: false, errors: ['The quiz is too large.'] });
  } else {
    const prepared = prepareQuiz(JSON.parse(request));
    if (prepared.valid) {
      reply({
        ok: true,
        questions: prepared.quiz.questions.map(({ text, options }) => ({ text, options })),
        warnings: prepared.warnings
      });
    } else {
      reply({ ok: false, errors: prepared.errors });
    }
  }
} catch (err) {
  /* The details are for the operator's log, which the parent copies stderr
     into; the presenter gets a sentence they can act on. */
  console.error('render worker:', err);
  reply({ ok: false, errors: ['The quiz could not be prepared for display.'] });
}
