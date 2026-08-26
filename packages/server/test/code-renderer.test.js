import { describe, it } from 'node:test';
import assert from 'node:assert';
import { renderCode, renderCodeInQuestion, renderCodeInQuiz, LANGUAGES } from '../src/code-renderer.js';
import { sanitizeHtml, sanitizeQuiz } from '../src/quiz-sanitizer.js';
import { renderMath } from '../src/math-renderer.js';

/** Convenience: a fenced block, written the way a lecturer would type it. */
const fence = (language, body) => '```' + language + '\n' + body + '\n```';

describe('Code Renderer', () => {
  describe('the supported languages', () => {
    /* The languages Michael asked for, by the name he would write. `html` is an
       alias of the xml grammar; there is no separate HTML grammar. */
    const REQUESTED = [
      ['bash', 'echo hello'],
      ['java', 'class A {}'],
      ['javascript', 'const a = 1;'],
      ['typescript', 'const a: number = 1;'],
      ['python', 'def f(): pass'],
      ['go', 'func main() {}'],
      ['rust', 'fn main() {}'],
      ['c', 'int main(void) { return 0; }'],
      ['cpp', 'int main() { return 0; }'],
      ['markdown', '# Title'],
      ['yaml', 'key: value'],
      ['json', '{"a": 1}'],
      ['html', '<p>hi</p>'],
      ['xml', '<a><b/></a>'],
      ['css', 'a { color: red; }']
    ];

    for (const [language, source] of REQUESTED) {
      it(`highlights ${language}`, () => {
        const { text, warnings } = renderCode(fence(language, source));
        assert.deepStrictEqual(warnings, [], `${language} produced warnings`);
        assert.match(text, /^<pre class="quiz-code"><code class="hljs language-[a-z+]+">/);
        assert.match(text, /<span class="hljs-/, `${language} produced no highlighting at all`);
        assert.ok(text.endsWith('</code></pre>'));
      });
    }

    it('registers exactly the intended grammar set', () => {
      assert.deepStrictEqual(
        Object.keys(LANGUAGES).sort(),
        ['bash', 'c', 'cpp', 'css', 'go', 'java', 'javascript', 'json',
         'markdown', 'python', 'rust', 'typescript', 'xml', 'yaml']
      );
    });
  });

  describe('language labels', () => {
    it('resolves aliases to the canonical grammar', () => {
      for (const [alias, canonical] of [['js', 'javascript'], ['ts', 'typescript'], ['py', 'python'],
                                        ['sh', 'bash'], ['c++', 'cpp'], ['golang', 'go'],
                                        ['rs', 'rust'], ['md', 'markdown'], ['yml', 'yaml'],
                                        ['html', 'xml']]) {
        const { text } = renderCode(fence(alias, 'x'));
        assert.match(text, new RegExp(`language-${canonical.replace('+', '\\+')}"`),
          `${alias} did not resolve to ${canonical}`);
      }
    });

    it('is case-insensitive about the label', () => {
      const { text, warnings } = renderCode(fence('Java', 'class A {}'));
      assert.deepStrictEqual(warnings, []);
      assert.match(text, /language-java"/);
    });

    it('ignores attributes written after the language', () => {
      const { text, warnings } = renderCode('```js {linenos}\nlet a = 1;\n```');
      assert.deepStrictEqual(warnings, []);
      assert.match(text, /language-javascript"/);
    });

    it('renders an unlabelled block as plain text, without complaining', () => {
      const { text, warnings } = renderCode('```\njust some output\n```');
      assert.deepStrictEqual(warnings, []);
      assert.strictEqual(text, '<pre class="quiz-code"><code class="hljs">just some output</code></pre>');
    });

    it('honours an explicit "text" label', () => {
      const { text, warnings } = renderCode(fence('text', 'not code'));
      assert.deepStrictEqual(warnings, []);
      assert.ok(!text.includes('language-'));
    });

    it('warns about an unknown language but still shows the code', () => {
      const { text, warnings } = renderCode(fence('brainfuck', '+++.'));
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /brainfuck/);
      assert.match(warnings[0], /not supported/);
      assert.ok(text.includes('+++.'), 'the code itself must survive');
      assert.ok(!text.includes('language-brainfuck'));
    });

    it('never guesses the language of an unlabelled block', () => {
      /* Auto-detection on a short snippet is a coin flip, and a wrong guess is
         worse than no colour at all on a projector. */
      const { text } = renderCode('```\npublic class A { int x = 1; }\n```');
      assert.ok(!text.includes('<span class="hljs-'), 'unlabelled code was highlighted anyway');
    });
  });

  describe('escaping', () => {
    it('escapes markup in a highlighted block', () => {
      const { text } = renderCode(fence('html', '<script>alert(1)</script>'));
      assert.ok(!text.includes('<script>'), 'a live <script> tag reached the output');
      assert.ok(text.includes('&lt;'));
    });

    it('escapes markup in a plain block', () => {
      const { text } = renderCode('```\n<b>bold</b> & <i>italic</i>\n```');
      assert.strictEqual(
        text,
        '<pre class="quiz-code"><code class="hljs">&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt;</code></pre>'
      );
    });

    it('escapes markup in an unknown-language block', () => {
      const { text } = renderCode(fence('brainfuck', '<img src=x>'));
      assert.ok(!text.includes('<img'));
      assert.ok(text.includes('&lt;img'));
    });
  });

  describe('fences', () => {
    it('leaves surrounding prose alone', () => {
      const { text } = renderCode('Before.\n' + fence('js', 'let a = 1;') + '\nAfter.');
      assert.ok(text.startsWith('Before.\n'));
      assert.ok(text.trimEnd().endsWith('After.'));
    });

    it('renders several blocks in one question', () => {
      const input = fence('js', 'let a = 1;') + '\n\nand\n\n' + fence('python', 'a = 1');
      const { text } = renderCode(input);
      assert.match(text, /language-javascript/);
      assert.match(text, /language-python/);
      assert.strictEqual(text.match(/<pre class="quiz-code">/g).length, 2);
    });

    it('lets a longer fence carry a shorter one as content', () => {
      /* This is how a Markdown *example* gets shown at all. */
      const input = '````markdown\n# Title\n```js\nlet a = 1;\n```\n````';
      const { text } = renderCode(input);
      assert.strictEqual(text.match(/<pre class="quiz-code">/g).length, 1);
      assert.match(text, /language-markdown/);
      assert.ok(text.includes('```js'), 'the inner fence must survive as content');
    });

    it('reads an unterminated fence as running to the end', () => {
      const { text } = renderCode('```python\nx = 1');
      assert.match(text, /language-python/);
      assert.ok(text.includes('x = '));
    });

    it('trims the blank lines the fence itself introduces', () => {
      const { text } = renderCode('```\nbody\n```');
      assert.ok(!text.includes('>\n'), 'leading newline survived');
      assert.ok(!text.includes('\n</code>'), 'trailing newline survived');
    });

    it('leaves text without any fence untouched', () => {
      const text = 'A question about $x^2$ with no code in it at all.';
      assert.strictEqual(renderCode(text).text, text);
    });

    it('requires the opening fence to start a line', () => {
      /* Markdown's rule, and the one that keeps a sentence like "type ``` to
         open a block" from swallowing the rest of the question. */
      const text = 'What does ```js let a = 1; ``` do?';
      assert.strictEqual(renderCode(text).text, text);
    });

    it('leaves a lone backtick alone', () => {
      const text = 'The ` character is a backtick.';
      assert.strictEqual(renderCode(text).text, text);
    });

    it('handles empty and non-string input', () => {
      assert.strictEqual(renderCode('').text, '');
      assert.strictEqual(renderCode(undefined).text, '');
      assert.strictEqual(renderCode(null).text, '');
      assert.deepStrictEqual(renderCode(undefined).warnings, []);
    });
  });

  describe('question and quiz level', () => {
    it('renders code in text and in every option', () => {
      const { question, warnings } = renderCodeInQuestion({
        type: 'multiple-choice',
        text: 'What does\n' + fence('js', 'let a = 1;') + '\ndo?',
        options: [fence('js', 'a = 1'), 'nothing', fence('nope', 'x')]
      });
      assert.deepStrictEqual(warnings, ['option 3: code block labelled "nope" uses a language that is not supported; rendered as plain text']);
      assert.match(question.text, /language-javascript/);
      assert.match(question.options[0], /language-javascript/);
      assert.strictEqual(question.options[1], 'nothing');
    });

    it('does not mutate the question it is given', () => {
      const original = { type: 'multiple-choice', text: fence('js', 'let a = 1;'), options: ['a', 'b'] };
      const copy = structuredClone(original);
      renderCodeInQuestion(original);
      assert.deepStrictEqual(original, copy);
    });

    it('labels warnings with the question they came from', () => {
      const { warnings } = renderCodeInQuiz({
        title: 'T',
        questions: [
          { type: 'multiple-choice', text: 'fine', options: ['a', 'b'] },
          { type: 'multiple-choice', text: fence('cobol', 'DISPLAY "HI".'), options: ['a', 'b'] }
        ]
      });
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /^question 2: /);
      assert.match(warnings[0], /cobol/);
    });

    it('preserves quiz fields it does not touch', () => {
      const { quiz } = renderCodeInQuiz({
        title: 'Title',
        someFutureField: 42,
        questions: [{ type: 'estimation', text: 'How many?', correctAnswer: 7, timeLimit: 30 }]
      });
      assert.strictEqual(quiz.title, 'Title');
      assert.strictEqual(quiz.someFutureField, 42);
      assert.strictEqual(quiz.questions[0].correctAnswer, 7);
      assert.strictEqual(quiz.questions[0].timeLimit, 30);
    });

    it('survives a quiz with no questions array', () => {
      const { quiz, warnings } = renderCodeInQuiz({ title: 'Empty' });
      assert.deepStrictEqual(quiz.questions, []);
      assert.deepStrictEqual(warnings, []);
    });
  });
});

/**
 * The three passes are composed in server.js in one specific order. These tests
 * pin the reasons that order exists; each of them fails if the passes are
 * swapped back.
 */
describe('Render pipeline order', () => {
  /** The room-open pipeline of server.js, in miniature. */
  const pipeline = (text) => {
    const highlighted = renderCode(text);
    const sanitized = sanitizeHtml(highlighted.text);
    return {
      html: renderMath(sanitized.html),
      warnings: [...highlighted.warnings, ...sanitized.warnings]
    };
  };

  it('keeps a <script> that is being *taught* out of the sanitizer\'s jaws', () => {
    /* Highlighting first escapes the sample, so by the time the blocklist runs
       there is no <script> element left to strip -- only text that reads like
       one. Sanitize first and the lecturer's slide silently loses its point. */
    const { html, warnings } = pipeline(fence('html', '<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;'), 'the sample was not escaped');
    assert.ok(html.includes('script'), 'the sample was stripped by the sanitizer');
    assert.deepStrictEqual(warnings, [], 'the sanitizer should have nothing to complain about');
  });

  it('keeps an inline event handler shown in a code sample', () => {
    const { html, warnings } = pipeline(fence('html', '<button onclick="f()">go</button>'));
    assert.ok(html.includes('onclick'), 'onclick was scrubbed out of a code sample');
    assert.deepStrictEqual(warnings, []);
  });

  it('still scrubs a <script> written *around* the code', () => {
    /* The safety net must not have been traded away for the above. */
    const { html, warnings } = pipeline('<script>alert(1)</script>\n' + fence('js', 'let a = 1;'));
    assert.ok(!html.includes('<script>'));
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /removed <script> element/);
  });

  it('does not read a shell variable as math', () => {
    /* `$PATH ... $HOME` used to be a KaTeX formula spanning the two, which ate
       the code in between. */
    const { html } = pipeline(fence('bash', 'echo $PATH\necho $HOME'));
    assert.ok(!html.includes('class="katex"'), '$ in a shell sample was rendered as math');
    assert.ok(html.includes('PATH'));
    assert.ok(html.includes('HOME'));
  });

  it('does not read a JS template literal as math', () => {
    const { html } = pipeline(fence('js', 'const s = `total: ${a + b}`;'));
    assert.ok(!html.includes('class="katex"'));
  });

  it('still renders math that sits next to a code block', () => {
    const { html } = pipeline('Given $x^2$, what does this print?\n' + fence('bash', 'echo $PATH'));
    assert.ok(html.includes('class="katex"'), 'math outside the code block was skipped');
    assert.strictEqual(html.match(/class="katex"/g).length, 1, 'math leaked into the code block');
    assert.ok(html.includes('PATH'));
  });

  it('leaves math alone inside an author-written <code> element', () => {
    /* Not a fenced block at all -- the same rule has to hold for HTML the
       author wrote by hand. */
    const html = renderMath('Prose $x^2$ and <code>a $b c</code>.');
    assert.strictEqual(html.match(/class="katex"/g).length, 1);
    assert.ok(html.includes('a $b c'));
  });

  it('renders the whole quiz through both passes without losing fields', () => {
    const highlighted = renderCodeInQuiz({
      title: 'Mixed',
      questions: [{
        type: 'multiple-choice',
        text: 'Given $n$, what does\n' + fence('go', 'for i := 0; i < n; i++ {}') + '\ndo?',
        options: [fence('go', 'i++'), 'nothing'],
        correctIndices: [0]
      }]
    });
    const sanitized = sanitizeQuiz(highlighted.quiz);
    const question = sanitized.quiz.questions[0];

    assert.deepStrictEqual([...highlighted.warnings, ...sanitized.warnings], []);
    assert.match(question.text, /language-go/);
    assert.ok(question.text.includes('&lt;'), 'the < in the for-loop was not escaped');
    assert.deepStrictEqual(question.correctIndices, [0]);
    assert.strictEqual(sanitized.quiz.title, 'Mixed');
  });
});
