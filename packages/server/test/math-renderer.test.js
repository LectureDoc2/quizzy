import { describe, it } from 'node:test';
import assert from 'node:assert';
import { renderMath, renderQuestion, renderQuiz } from '../src/math-renderer.js';

describe('Math Renderer', () => {
  it('renderMath renders inline math with \\( \\)', () => {
    const text = 'What is the derivative of \\( x^2 \\)?';
    const result = renderMath(text);
    assert.ok(result.includes('class="katex"'));
    assert.ok(!result.includes('\\( x^2 \\)' ));
  });

  it('renderMath renders display math with \\[ \\]', () => {
    const text = 'Solve: \\[ \\int x^2 \\, dx \\]';
    const result = renderMath(text);
    assert.ok(result.includes('class="katex"'));
    assert.ok(!result.includes('\\[ \\int'));
  });

  it('renderMath renders inline math with $ $', () => {
    const text = 'The value of $\\pi$ is approximately 3.14';
    const result = renderMath(text);
    assert.ok(result.includes('class="katex"'));
    assert.ok(!result.includes('$\\pi$'));
  });

  it('renderMath renders display math with $$ $$', () => {
    const text = 'Equation: $$E = mc^2$$';
    const result = renderMath(text);
    assert.ok(result.includes('class="katex"'));
    assert.ok(!result.includes('$$E = mc^2$$'));
  });

  it('renderMath leaves plain text unchanged', () => {
    const text = 'This is just plain text with no math.';
    const result = renderMath(text);
    assert.strictEqual(result, text);
  });

  it('renderQuestion renders math in text and options', () => {
    const question = {
      type: 'multiple-choice',
      text: 'What is \\( 2 + 2 \\)?',
      options: ['\\( 3 \\)', '\\( 4 \\)', '\\( 5 \\)'],
      correctIndices: [1]
    };
    const result = renderQuestion(question);
    assert.ok(result.text.includes('class="katex"'));
    assert.ok(result.options[0].includes('class="katex"'));
    assert.ok(result.options[1].includes('class="katex"'));
    assert.deepStrictEqual(result.correctIndices, [1]);
  });

  it('renderQuiz renders math in all questions', () => {
    const quiz = {
      title: 'Math Quiz',
      questions: [
        {
          type: 'multiple-choice',
          text: 'What is \\( x^2 \\)?',
          options: ['\\( 2x \\)', '\\( x \\)', '\\( x^2 \\)'],
          correctIndices: [0]
        },
        {
          type: 'estimation',
          text: 'Estimate \\( \\sqrt{2} \\).',
          correctAnswer: 1.41
        }
      ]
    };
    const result = renderQuiz(quiz);
    assert.strictEqual(result.title, 'Math Quiz');
    assert.ok(result.questions[0].text.includes('class="katex"'));
    assert.ok(result.questions[1].text.includes('class="katex"'));
    assert.ok(result.questions[0].options[0].includes('class="katex"'));
    assert.deepStrictEqual(result.questions[0].correctIndices, [0]);
    assert.strictEqual(result.questions[1].correctAnswer, 1.41);
  });

  it('renderMath handles malformed math gracefully', () => {
    const text = 'Some \\( invalid math here';
    const result = renderMath(text);
    // Should keep the original text since there's no closing delimiter
    assert.ok(result.includes('\\( invalid math here'));
  });
});
