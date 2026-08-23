/**
 * The authoring tools page: validate a quiz, encrypt a quiz, generate a secret.
 *
 * ## Why this is a page and not an endpoint
 *
 * Every operation here runs in the browser and nothing is uploaded. That is not
 * a convenience, it is the point. Validation only needs the file, and encryption
 * needs the file *and the password* -- and a password that protects a blob
 * published inside a deck is precisely the thing that should never be posted to
 * a server, appear in an access log, or sit in a reverse proxy's request buffer.
 * A `POST /api/encrypt` would have been a new route accepting an arbitrary body
 * and holding lecturers' passwords in memory; there is nothing it could do that
 * `crypto.subtle` in the author's own tab cannot.
 *
 * So the API server gains no route, Caddy gains no rule, and this page is a
 * static file like every other page in `dist/app/`.
 *
 * ## Why it imports the server's modules
 *
 * `validateQuiz` is the function the server runs before it will create a room,
 * and `checkSecret` is the one `tools/validate-quiz.js` runs on the command
 * line. Both are imported here rather than reimplemented, so "valid on the
 * tools page" cannot come to mean something different from "valid at
 * `create_room`". esbuild inlines them, and `@lecturedoc2/libcrypto` with them,
 * into `/js/quiz-tools.js`.
 *
 * ## Secure context
 *
 * `crypto.subtle` is undefined outside HTTPS and localhost, so encryption and
 * secret generation are unavailable there and say so up front. Validation is
 * pure JavaScript and keeps working.
 */
import { validateQuiz } from '../../src/quiz-validator.js';
import { checkSecret, generateSecret } from '../../src/quiz-secret-advice.js';
import { encryptQuiz, PBKDF2_ITERATIONS } from '../../src/quiz-encryption.js';

const $ = (id) => document.getElementById(id);

/** Every message on this page is built from text nodes; see renderMessage. */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Quiz files are untrusted input -- a title is lecturer-authored markup and the
 * validator quotes offending values back verbatim -- so nothing on this page
 * ever reaches innerHTML. The messages also carry the command line tool's
 * newlines and indentation, which `white-space: pre-wrap` in tools.css keeps.
 */
function renderMessage(parent, kind, text) {
  parent.appendChild(el('p', `message message--${kind}`, text));
}

/* ------------------------------------------------------------------ helpers */

const readAsText = (file) => file.text();

/** `analysis-quiz.de.json` -> `analysis-quiz.de.encrypted.txt`, as in quizzes/. */
function encryptedName(fileName) {
  return fileName.replace(/\.json$/i, '') + '.encrypted.txt';
}

/**
 * The whole verdict on one file: the structural check the server makes, plus
 * the `secret` advice it deliberately does not.
 */
function inspect(text) {
  let quiz;
  try {
    quiz = JSON.parse(text);
  } catch (err) {
    return { errors: [`is not valid JSON: ${err.message}`], warnings: [] };
  }

  const structure = validateQuiz(quiz);
  if (!structure.valid) return { quiz, errors: structure.errors, warnings: [] };

  const count = quiz.questions.length;
  return {
    quiz,
    errors: [],
    warnings: checkSecret(quiz),
    summary: `${count} question${count === 1 ? '' : 's'}` + (quiz.title ? ` — ${quiz.title}` : ''),
  };
}

/** A generated file reaches the disk the only way a static page can: a click. */
function download(fileName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Revoking immediately is safe: the click has already started the download.
  URL.revokeObjectURL(url);
}

/* ----------------------------------------------------------------- validate */

async function runValidation() {
  const output = $('validate-output');
  output.replaceChildren();

  const files = [...$('validate-files').files];
  if (files.length === 0) {
    renderMessage(output, 'error', 'Choose at least one quiz file first.');
    return;
  }

  for (const file of files) {
    const result = el('div', 'result');
    const { errors, warnings, summary } = inspect(await readAsText(file));

    // The three verdicts, and the three markers, of tools/validate-quiz.js.
    if (errors.length > 0) {
      result.appendChild(el('h3', 'result__name result__name--error', `✗ ${file.name}`));
      for (const error of errors) renderMessage(result, 'error', error);
    } else if (warnings.length > 0) {
      result.appendChild(el('h3', 'result__name result__name--warning', `! ${file.name}  (${summary})`));
      for (const warning of warnings) renderMessage(result, 'warning', warning);
    } else {
      result.appendChild(el('h3', 'result__name result__name--ok', `✓ ${file.name}  (${summary})`));
    }

    output.appendChild(result);
  }
}

/* ------------------------------------------------------------------ encrypt */

async function runEncryption() {
  const output = $('encrypt-output');
  const button = $('encrypt-run');
  output.replaceChildren();

  const file = $('encrypt-file').files[0];
  const password = $('encrypt-password').value;
  const repeated = $('encrypt-password-repeat').value;

  if (!file) {
    renderMessage(output, 'error', 'Choose a quiz file first.');
    return;
  }
  if (password === '') {
    renderMessage(output, 'error', 'A password is required.');
    return;
  }
  /* Asked twice on purpose. A mistyped password here is not noticed until a
     lecture hall full of people cannot open the quiz, and by then the blob is
     already published in the deck. */
  if (password !== repeated) {
    renderMessage(output, 'error', 'The two passwords do not match.');
    return;
  }

  const text = await readAsText(file);
  const { errors, warnings, summary } = inspect(text);

  /* Errors block: an unusable quiz encrypted into an opaque blob is a problem
     that surfaces at the worst possible moment. Warnings do not, matching the
     command line tool's default -- a quiz without a secret is still a quiz. */
  if (errors.length > 0) {
    renderMessage(output, 'error', `${file.name} cannot be used and was not encrypted:`);
    for (const error of errors) renderMessage(output, 'error', error);
    return;
  }
  for (const warning of warnings) renderMessage(output, 'warning', warning);

  button.disabled = true;
  const progress = el(
    'p',
    'message message--info',
    `Deriving the key (${PBKDF2_ITERATIONS.toLocaleString('en')} PBKDF2 iterations). This takes a moment.`,
  );
  output.appendChild(progress);

  try {
    const encrypted = await encryptQuiz(text, password);
    const outputName = encryptedName(file.name);
    download(outputName, encrypted);
    progress.remove();
    renderMessage(output, 'ok', `✓ ${outputName} downloaded  (${summary})`);
    renderMessage(
      output,
      'info',
      'Reference it from the deck with:\n' +
        `    <ld-quiz encrypted quiz-url="${outputName}"></ld-quiz>`,
    );
  } catch (err) {
    progress.remove();
    renderMessage(output, 'error', `Encryption failed: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------- secret */

function runSecretGeneration() {
  const value = generateSecret();
  $('secret-value').textContent = value;
  $('secret-copy').disabled = false;
  $('secret-output').replaceChildren();
}

async function copySecret() {
  const output = $('secret-output');
  output.replaceChildren();
  try {
    await navigator.clipboard.writeText($('secret-value').textContent);
    renderMessage(output, 'ok', 'Copied.');
  } catch {
    // Clipboard access can be refused; the value is on screen either way.
    renderMessage(output, 'warning', 'The browser refused clipboard access — select the value and copy it.');
  }
}

/* --------------------------------------------------------------------- init */

/**
 * Without a secure context `crypto.subtle` does not exist, so encryption and
 * secret generation cannot work. Say that once, plainly, instead of letting the
 * buttons fail with a TypeError. Validation needs no crypto and stays enabled.
 */
function applySecureContextState() {
  if (window.isSecureContext) return;

  $('insecure-context').hidden = false;
  for (const id of ['encrypt-run', 'secret-run', 'secret-copy']) {
    $(id).disabled = true;
  }
}

$('validate-run').addEventListener('click', runValidation);
$('encrypt-run').addEventListener('click', runEncryption);
$('secret-run').addEventListener('click', runSecretGeneration);
$('secret-copy').addEventListener('click', copySecret);
$('iterations').textContent = PBKDF2_ITERATIONS.toLocaleString('en');
applySecureContextState();
