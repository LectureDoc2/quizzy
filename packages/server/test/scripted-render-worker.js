/**
 * A render worker that misbehaves on request, for render-sandbox.test.js.
 *
 * The quiz's title says how. It runs under exactly the flags the real worker
 * gets (render-sandbox.js passes them to any `workerPath`), so `probe` reports
 * what a compromised renderer would actually be allowed to do.
 */
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const quiz = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const reply = (message) =>
  process.stdout.end(typeof message === 'string' ? message : JSON.stringify(message));

/** What an honest worker would send, with every string replaced by `text`. */
const rendered = (text = 'rendered') => quiz.questions.map((question) => ({
  text,
  ...(Array.isArray(question.options) ? { options: question.options.map(() => text) } : {})
}));

const attempt = (action) => {
  try {
    action();
    return 'allowed';
  } catch (err) {
    return err.code || err.name;
  }
};

switch (quiz.title) {
  case 'spin': // a parser that never comes back
    for (;;) { /* busy */ }
  case 'silent': // never replies, never exits
    setInterval(() => {}, 1000);
    break;
  case 'flood': {
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const pump = () => {
      while (process.stdout.write(chunk)) { /* until the pipe is full */ }
      process.stdout.once('drain', pump);
    };
    pump();
    break;
  }
  case 'not-json':
    reply('<html>');
    break;
  case 'too-few':
    reply({ ok: true, questions: rendered().slice(1), warnings: [] });
    break;
  case 'bad-options':
    reply({ ok: true, questions: rendered().map((q) => ({ ...q, options: ['only one'] })), warnings: [] });
    break;
  case 'not-strings':
    reply({ ok: true, questions: rendered().map((q) => ({ ...q, text: { toString: 1 } })), warnings: [] });
    break;
  case 'tamper':
    reply({
      ok: true,
      questions: rendered('tampered').map((q) => ({
        ...q, type: 'estimation', correctIndices: [1], correctAnswer: 0, timeLimit: 1
      })),
      warnings: [],
      quiz: { title: 'replaced', questions: [] }
    });
    break;
  case 'refuse':
    reply({ ok: false, errors: ['x'.repeat(5000)] });
    break;
  case 'probe':
    reply({
      ok: true,
      questions: rendered(JSON.stringify({
        read: attempt(() => readFileSync('/etc/hosts')),
        write: attempt(() => writeFileSync('/tmp/quizzy-render-probe', 'x')),
        spawn: attempt(() => execFileSync('/bin/echo', ['hello'])),
        pollute: attempt(() => { Object.prototype.polluted = true; }),
        evaluate: attempt(() => new Function('return 1')()),
        env: Object.keys(process.env)
      })),
      warnings: []
    });
    break;
  default:
    reply({ ok: true, questions: rendered(), warnings: [] });
}
