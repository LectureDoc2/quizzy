import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeHtml, sanitizeQuiz } from '../src/quiz-sanitizer.js';
import { renderQuiz } from '../src/math-renderer.js';

describe('sanitizeHtml', () => {
  it('preserves ordinary formatting markup', () => {
    const input = '<p>What is <strong>2 + 2</strong>?<br>Choose <em>one</em>.</p>';
    assert.strictEqual(sanitizeHtml(input).html, input);
  });

  it('preserves inline SVG, including attributes and self-closing tags', () => {
    const input = '<svg viewBox="0 0 10 10" width="10"><circle cx="5" cy="5" r="4" /><path d="M0 0 L10 10"/></svg>';
    const { html, warnings } = sanitizeHtml(input);
    assert.match(html, /<svg viewBox="0 0 10 10" width="10">/);
    assert.match(html, /<circle cx="5" cy="5" r="4" \/>/);
    assert.strictEqual(warnings.length, 0);
  });

  it('leaves plain text with comparison operators alone', () => {
    const input = 'Is a < b and b > c?';
    assert.strictEqual(sanitizeHtml(input).html, input);
  });

  it('removes script elements together with their content', () => {
    const { html, warnings } = sanitizeHtml('<p>Hi</p><script>steal()</script><p>Bye</p>');
    assert.strictEqual(html, '<p>Hi</p><p>Bye</p>');
    assert.ok(warnings.some(w => w.includes('script')));
  });

  it('removes style elements, which would otherwise leak into the page', () => {
    const { html } = sanitizeHtml('<style>body{display:none}</style><p>Hi</p>');
    assert.strictEqual(html, '<p>Hi</p>');
  });

  it('removes inline event handlers but keeps the element', () => {
    const { html, warnings } = sanitizeHtml('<img src="a.png" onerror="alert(1)" alt="x">');
    assert.strictEqual(html, '<img src="a.png" alt="x">');
    assert.ok(warnings.some(w => w.includes('onerror')));
  });

  it('removes event handlers regardless of case and quoting style', () => {
    assert.strictEqual(sanitizeHtml('<div OnClick=alert(1) class="a">x</div>').html, '<div class="a">x</div>');
    assert.strictEqual(sanitizeHtml("<div onmouseover='x()'>y</div>").html, '<div>y</div>');
  });

  it('removes event handlers inside SVG', () => {
    const { html } = sanitizeHtml('<svg><circle r="4" onload="alert(1)"/></svg>');
    assert.ok(!html.includes('onload'));
    assert.ok(html.includes('<circle r="4" />'));
  });

  it('removes javascript: URLs, including obfuscated ones', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java&#115;cript:alert(1)'
    ]) {
      const { html } = sanitizeHtml(`<a href="${url}">click</a>`);
      assert.ok(!html.toLowerCase().includes('javascript'), `not removed: ${url}`);
    }
  });

  it('keeps benign URLs', () => {
    const input = '<a href="https://example.org/x?a=1&b=2">link</a>';
    assert.strictEqual(sanitizeHtml(input).html, input);
  });

  it('handles empty and non-string input', () => {
    assert.strictEqual(sanitizeHtml('').html, '');
    assert.strictEqual(sanitizeHtml(undefined).html, '');
  });
});

describe('sanitizeQuiz', () => {
  it('sanitizes question text and options, and labels the warnings', () => {
    const quiz = {
      title: 'T',
      questions: [
        { type: 'multiple-choice', text: '<p onclick="x()">Pick</p>', options: ['<b>A</b>', '<script>x()</script>B'] }
      ]
    };
    const { quiz: clean, warnings } = sanitizeQuiz(quiz);
    assert.strictEqual(clean.questions[0].text, '<p>Pick</p>');
    assert.deepStrictEqual(clean.questions[0].options, ['<b>A</b>', 'B']);
    assert.ok(warnings.some(w => w.startsWith('question 1:')));
    assert.ok(warnings.some(w => w.startsWith('question 1, option 2:')));
  });

  it('does not mutate the input quiz', () => {
    const quiz = { title: 'T', questions: [{ type: 'estimation', text: '<p onclick="x()">a</p>' }] };
    sanitizeQuiz(quiz);
    assert.strictEqual(quiz.questions[0].text, '<p onclick="x()">a</p>');
  });

  it('leaves other question fields (including correct answers) untouched', () => {
    const quiz = {
      title: 'T',
      questions: [{ type: 'estimation', text: 'a', correctAnswer: 42, timeLimit: 30 }]
    };
    const { quiz: clean } = sanitizeQuiz(quiz);
    assert.strictEqual(clean.questions[0].correctAnswer, 42);
    assert.strictEqual(clean.questions[0].timeLimit, 30);
  });

  it('reports no warnings for a clean quiz', () => {
    const quiz = { title: 'T', questions: [{ type: 'estimation', text: 'How many?', correctAnswer: 1 }] };
    assert.deepStrictEqual(sanitizeQuiz(quiz).warnings, []);
  });

  it('sanitizing before KaTeX leaves rendered math intact', () => {
    // The server sanitizes and then renders math, so KaTeX output is never
    // passed through the scrubber. This guards that ordering.
    const quiz = { title: 'T', questions: [{ type: 'estimation', text: 'Solve $x^2 + 1$<script>x()</script>' }] };
    const rendered = renderQuiz(sanitizeQuiz(quiz).quiz);
    assert.ok(rendered.questions[0].text.includes('katex'));
    assert.ok(!rendered.questions[0].text.includes('<script'));
  });
});
