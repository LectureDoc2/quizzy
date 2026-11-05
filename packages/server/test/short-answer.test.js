import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  SHORT_ANSWER_LIMITS,
  answerLengths,
  cleanUp,
  expandAcceptedAnswer,
  groupAnswers,
  matchesAcceptedAnswer,
  maxLengthFor,
  measuredLength,
  normalizeAnswer
} from '../src/short-answer.js';

const overloading = () => ({
  type: 'short-answer',
  text: 'Same name, different parameter lists?',
  acceptedAnswers: [
    'Overloading [of Methods]',
    'Method Overloading',
    'Überladen [von Methoden]',
    'Überladung',
    'Methodenüberladung'
  ]
});

describe('expandAcceptedAnswer', () => {
  it('expands an optional part to both spellings, base form first', () => {
    assert.deepStrictEqual(expandAcceptedAnswer('Overloading [of Methods]'), {
      variants: ['Overloading', 'Overloading of Methods'],
      base: 'Overloading'
    });
  });

  it('leaves no stray space where an optional part was left out', () => {
    assert.deepStrictEqual(expandAcceptedAnswer('Method [Overloading] Rules').variants, [
      'Method Rules',
      'Method Overloading Rules'
    ]);
  });

  it('expands every combination of several optional parts', () => {
    assert.strictEqual(expandAcceptedAnswer('[a ]b[ c][ d]').variants.length, 8);
  });

  it('reads \\[ and \\] as literal brackets, and leaves any other backslash alone', () => {
    assert.deepStrictEqual(expandAcceptedAnswer('int\\[\\]').variants, ['int[]']);
    assert.deepStrictEqual(expandAcceptedAnswer('\\n').variants, ['\\n']);
    assert.deepStrictEqual(expandAcceptedAnswer('a\\\\b').variants, ['a\\b']);
  });

  it('rejects malformed brackets with a hint at the escape', () => {
    assert.match(expandAcceptedAnswer('int[]').error, /empty optional part/);
    assert.match(expandAcceptedAnswer('a [b [c]]').error, /nested/);
    assert.match(expandAcceptedAnswer('a [b').error, /without a matching "\]"/);
    assert.match(expandAcceptedAnswer('a] b').error, /without a matching "\["/);
  });

  it('rejects an answer that is empty once its optional parts are left out', () => {
    assert.match(expandAcceptedAnswer('').error, /empty/);
    assert.match(expandAcceptedAnswer('[Overloading]').error, /empty/);
    assert.match(expandAcceptedAnswer('"" [x]').error, /empty/);
  });

  it('refuses too many optional parts before expanding them', () => {
    const answer = 'x' + '[ y]'.repeat(SHORT_ANSWER_LIMITS.maxOptionalParts + 1);
    assert.match(expandAcceptedAnswer(answer).error, /more than 4 optional parts/);
    // 60 groups would be 2^60 variants; this must return at once.
    assert.ok(expandAcceptedAnswer('x' + '[y]'.repeat(60)).error);
  });
});

describe('normalizeAnswer', () => {
  it('ignores case, spacing, hyphens and quotes', () => {
    assert.strictEqual(normalizeAnswer('  Method-Overloading '), 'method overloading');
    assert.strictEqual(normalizeAnswer('"Method   Overloading"'), 'method overloading');
    assert.strictEqual(normalizeAnswer('method_overloading'), 'method overloading');
  });

  it('treats umlauts and their written-out form alike', () => {
    assert.strictEqual(normalizeAnswer('Überladen'), normalizeAnswer('Ueberladen'));
    assert.strictEqual(normalizeAnswer('Größe'), normalizeAnswer('GROESSE'));
    // A decomposed ü, as some editors save it.
    assert.strictEqual(normalizeAnswer('Überladen'), 'ueberladen');
  });

  it('drops other diacritics', () => {
    assert.strictEqual(normalizeAnswer('Café'), 'cafe');
  });
});

describe('cleanUp', () => {
  it('maps what keyboards substitute back to what was typed', () => {
    assert.strictEqual(cleanUp('\u201Cx\u201D \u2018y\u2019 \u201Ez\u201C'), '"x" \'y\' "z"');
    assert.strictEqual(cleanUp('i\u2014 \u2013 \u2212 1\u2026'), 'i-- - - 1...');
  });

  it('removes invisible characters and collapses spacing', () => {
    assert.strictEqual(cleanUp('\uFEFF a\u00A0\u00A0b\u200B\u00ADc\u2060 '), 'a bc');
  });

  it('composes, but keeps case and everything else', () => {
    assert.strictEqual(cleanUp('U\u0308berladen'), '\u00DCberladen');
    assert.strictEqual(cleanUp('hashCode //'), 'hashCode //');
  });
});

describe('normalizeAnswer in each mode', () => {
  it('reduces symbols in fuzzy and strict mode, and keeps them in exact mode', () => {
    for (const match of ['fuzzy', 'strict']) {
      assert.strictEqual(normalizeAnswer('//', match), '');
      assert.strictEqual(normalizeAnswer('/*', match), '*');
    }
    assert.strictEqual(normalizeAnswer(' // ', 'exact'), '//');
    assert.strictEqual(normalizeAnswer('Größe', 'exact'), 'Größe');
  });
});

describe('groupAnswers', () => {
  const entries = ['/*', '*', '/ *', 'Overloading', 'overloading'].map((answer) => ({ answer }));

  it('groups in the form matching saw', () => {
    const texts = (match) => groupAnswers(entries, { match }).groups.map((g) => `${g.count} ${g.text}`).sort();
    assert.deepStrictEqual(texts('fuzzy'), ['2 Overloading', '3 /*']);
    assert.deepStrictEqual(texts('exact'), ['1 *', '1 / *', '1 /*', '1 Overloading', '1 overloading']);
  });

  it('lists at most `limit` groups and counts the rest', () => {
    const { groups, otherCount } = groupAnswers(entries, { limit: 1, match: 'exact' });
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(otherCount, 4);
  });
});

describe('matchesAcceptedAnswer', () => {
  it('accepts every spelling the question lists, with or without optional parts', () => {
    const question = overloading();
    for (const answer of [
      'Overloading', 'overloading of methods', 'Method Overloading', 'method-overloading',
      'überladen', 'Ueberladen von Methoden', 'Überladung', 'Methodenueberladung'
    ]) {
      assert.ok(matchesAcceptedAnswer(question, answer), answer);
    }
  });

  it('forgives one typo in a longer term', () => {
    const question = overloading();
    assert.ok(matchesAcceptedAnswer(question, 'Overloadng')); // deletion
    assert.ok(matchesAcceptedAnswer(question, 'Overloadingg')); // insertion
    assert.ok(matchesAcceptedAnswer(question, 'Overlaoding')); // transposition
    assert.ok(matchesAcceptedAnswer(question, 'Overlpading')); // substitution
  });

  it('does not forgive two', () => {
    assert.ok(!matchesAcceptedAnswer(overloading(), 'Overlpadinf'));
    const encryption = { type: 'short-answer', acceptedAnswers: ['Encryption'] };
    assert.ok(!matchesAcceptedAnswer(encryption, 'Decryption'));
  });

  it('rejects a different term, and a list of guesses', () => {
    const question = overloading();
    assert.ok(!matchesAcceptedAnswer(question, 'Overriding'));
    assert.ok(!matchesAcceptedAnswer(question, 'Overloading oder Overriding'));
    assert.ok(!matchesAcceptedAnswer(question, ''));
    assert.ok(!matchesAcceptedAnswer(question, '   '));
  });

  it('forgives no typo in a short term', () => {
    const question = { type: 'short-answer', acceptedAnswers: ['static'] };
    assert.ok(matchesAcceptedAnswer(question, 'Static'));
    assert.ok(!matchesAcceptedAnswer(question, 'statik'));
  });

  it('forgives no typo in strict mode, and is otherwise as forgiving', () => {
    const question = { ...overloading(), match: 'strict' };
    assert.ok(matchesAcceptedAnswer(question, 'overloading'));
    assert.ok(matchesAcceptedAnswer(question, 'Ueberladen von Methoden'));
    assert.ok(!matchesAcceptedAnswer(question, 'Overloadng'));
  });

  it('compares exactly in exact mode, apart from spacing', () => {
    const comments = { type: 'short-answer', acceptedAnswers: ['/*', '/**'], match: 'exact' };
    assert.ok(matchesAcceptedAnswer(comments, '/*'));
    assert.ok(matchesAcceptedAnswer(comments, '  /** '));
    // What the other modes would reduce "/*" to.
    assert.ok(!matchesAcceptedAnswer(comments, '*'));
    assert.ok(!matchesAcceptedAnswer(comments, '/ *'));
    assert.ok(!matchesAcceptedAnswer({ ...comments, match: 'strict' }, '//'));
    assert.ok(matchesAcceptedAnswer({ ...comments, match: 'strict' }, '*'), 'the gap exact mode closes');

    const lineComment = { type: 'short-answer', acceptedAnswers: ['//'], match: 'exact' };
    assert.ok(matchesAcceptedAnswer(lineComment, '//'));
    assert.ok(!matchesAcceptedAnswer(lineComment, '/'));

    const identifier = { type: 'short-answer', acceptedAnswers: ['hashCode'], match: 'exact' };
    assert.ok(matchesAcceptedAnswer(identifier, 'hashCode'));
    assert.ok(!matchesAcceptedAnswer(identifier, 'hashcode'));
    assert.ok(!matchesAcceptedAnswer(identifier, 'hashCod'));
  });

  it('undoes keyboard substitutions in exact mode too', () => {
    const question = { type: 'short-answer', acceptedAnswers: ['"a" -- b...'], match: 'exact' };
    // iOS smart punctuation, a pasted no-break space and a zero-width space.
    assert.ok(matchesAcceptedAnswer(question, '\u201Ca\u201D\u00A0\u2014 b\u2026'));
    assert.ok(matchesAcceptedAnswer(question, '"a" --\u200B b...'));
  });

  it('treats an unknown mode as the default', () => {
    assert.ok(matchesAcceptedAnswer({ ...overloading(), match: 'nonsense' }, 'Overloadng'));
  });

  it('copes with a question that never went through the validator', () => {
    assert.ok(!matchesAcceptedAnswer({ type: 'short-answer' }, 'x'));
    assert.ok(!matchesAcceptedAnswer({ acceptedAnswers: [42, null, 'a [b'] }, 'a'));
    assert.ok(matchesAcceptedAnswer({ acceptedAnswers: [42, 'Ok'] }, 'ok'));
    assert.ok(!matchesAcceptedAnswer(overloading(), 42));
  });
});

describe('answer lengths', () => {
  it('span the base forms as written, and allow the longest variant plus ten percent', () => {
    // Base forms 11, 18, 9, 10, 18; the longest variant is
    // "Überladen von Methoden", 23 characters as "Ueberladen von Methoden".
    assert.deepStrictEqual(answerLengths(overloading()), {
      answerLength: { min: 9, max: 18 },
      maxLength: 26
    });
  });

  it('add at least one character', () => {
    assert.strictEqual(maxLengthFor(5), 6);
    assert.strictEqual(maxLengthFor(10), 11);
    assert.strictEqual(maxLengthFor(11), 13);
    // 0.1 * 30 is 3.0000000000000004 in floating point.
    assert.strictEqual(maxLengthFor(30), 33);
  });

  it('leave room for umlauts written out', () => {
    const question = { type: 'short-answer', acceptedAnswers: ['Größe'] };
    assert.deepStrictEqual(answerLengths(question), {
      answerLength: { min: 5, max: 5 },
      maxLength: 8
    });
    assert.ok(measuredLength('Groesse') <= 8);
  });

  it('count neither escapes nor a decomposed umlaut twice', () => {
    assert.deepStrictEqual(
      answerLengths({ type: 'short-answer', acceptedAnswers: ['int\\[\\]'] }).answerLength,
      { min: 5, max: 5 }
    );
    assert.deepStrictEqual(
      answerLengths({ type: 'short-answer', acceptedAnswers: ['Übung'] }).answerLength,
      { min: 5, max: 5 }
    );
  });

  it('measure an answer the same way, ignoring the space a phone keyboard adds', () => {
    assert.strictEqual(measuredLength('Overloading '), 11);
    assert.strictEqual(measuredLength(' Method   Overloading'), 18);
    assert.strictEqual(measuredLength('Überladen'), 10);
  });
});
