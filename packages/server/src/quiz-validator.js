/**
 * Structural validation of a quiz, before it is allowed to create a room.
 *
 * The sanitizer next door answers a different question: it scrubs *markup* the
 * lecturer wrote, on the assumption that the lecturer is trusted and merely
 * fallible. This module answers "is this thing shaped like a quiz at all", and
 * it exists because the answer used to be discovered much later and much worse.
 *
 * A quiz reaches the server as arbitrary JSON. Scoring, the results view and the
 * auto-end timer all assume a particular shape -- `correctIndices` is an array,
 * `options` is an array of strings, `timeLimit` is a number. When that
 * assumption failed it failed inside a `setTimeout`, outside every `try`, which
 * in Node means the process exits: one lecturer's malformed JSON took down every
 * other lecture running on the same host.
 *
 * So the shape is checked once, here, at the only door a quiz can come through,
 * and a quiz that does not pass never becomes a room. The caller reports the
 * problems to the presenter, who is the one person able to fix them.
 *
 * Every limit below is also a denial-of-service bound. They are deliberately far
 * above anything a real lecture needs -- the point is to make the memory a
 * single `create_room` can pin down finite, not to be opinionated about teaching.
 */

import { SHORT_ANSWER_LIMITS, MATCH_MODES, expandAcceptedAnswer, matchOf } from './short-answer.js';
import { ORDERING_LIMITS } from './ordering.js';
import { locateJsonPath } from './json-location.js';

/** Bounds. Generous for a lecture, finite for an attacker. */
const LIMITS = {
  maxQuestions: 200,
  maxOptions: 26, // one per letter, which is already absurd on a projector
  maxTitleLength: 500,
  maxTextLength: 20000,
  maxOptionLength: 5000,
  maxTimeLimitSeconds: 3600,
  ...SHORT_ANSWER_LIMITS,
  ...ORDERING_LIMITS,
};

const QUESTION_TYPES = new Set(['multiple-choice', 'estimation', 'short-answer', 'ordering']);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} quiz
 * @returns {{valid: boolean, errors: string[]}} `errors` is empty iff valid.
 */
export function validateQuiz(quiz) {
  const errors = [];

  /* Report several problems at once. A lecturer fixing a quiz five minutes
     before a lecture should not have to rediscover the next error by trying
     again, so validation continues after the first failure wherever it can
     still make sense of the structure. */
  const fail = (message) => {
    if (errors.length < 20) errors.push(message);
  };

  if (!isPlainObject(quiz)) {
    return { valid: false, errors: ['The quiz must be a JSON object.'] };
  }

  if (quiz.title !== undefined) {
    if (typeof quiz.title !== 'string') {
      fail('title must be a string.');
    } else if (quiz.title.length > LIMITS.maxTitleLength) {
      fail(`title is longer than ${LIMITS.maxTitleLength} characters.`);
    }
  }

  /* Opts the quiz in to asking each participant whether their name and final
     score may appear in the lecturer's export. Strictly a boolean: a string
     "false" must not switch on something that collects personal data. */
  if (quiz.recordNamedResults !== undefined && typeof quiz.recordNamedResults !== 'boolean') {
    fail('recordNamedResults must be true or false.');
  }

  if (!Array.isArray(quiz.questions)) {
    return { valid: false, errors: [...errors, 'questions must be an array.'] };
  }
  if (quiz.questions.length === 0) {
    fail('questions is empty; a quiz needs at least one question.');
  }
  if (quiz.questions.length > LIMITS.maxQuestions) {
    return {
      valid: false,
      errors: [...errors, `questions has ${quiz.questions.length} entries, more than the limit of ${LIMITS.maxQuestions}.`],
    };
  }

  quiz.questions.forEach((question, index) => {
    const at = `question ${index + 1}`;

    if (!isPlainObject(question)) {
      fail(`${at}: must be a JSON object.`);
      return;
    }

    if (!QUESTION_TYPES.has(question.type)) {
      fail(`${at}: type must be one of ${[...QUESTION_TYPES].join(', ')} (got ${JSON.stringify(question.type)}).`);
      return; // the remaining checks are type-specific
    }

    if (typeof question.text !== 'string') {
      fail(`${at}: text must be a string.`);
    } else if (question.text.length > LIMITS.maxTextLength) {
      fail(`${at}: text is longer than ${LIMITS.maxTextLength} characters.`);
    }

    /* A missing time limit means "the presenter ends it", which is a normal way
       to run a question -- only a present-but-nonsensical value is an error. */
    if (question.timeLimit !== undefined && question.timeLimit !== null) {
      const limit = question.timeLimit;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        fail(`${at}: timeLimit must be a non-negative number of seconds.`);
      } else if (limit > LIMITS.maxTimeLimitSeconds) {
        fail(`${at}: timeLimit of ${limit}s exceeds the maximum of ${LIMITS.maxTimeLimitSeconds}s.`);
      }
    }

    if (question.type === 'multiple-choice') {
      if (!Array.isArray(question.options)) {
        fail(`${at}: options must be an array.`);
        return;
      }
      if (question.options.length < 2) {
        fail(`${at}: needs at least two options.`);
      }
      if (question.options.length > LIMITS.maxOptions) {
        fail(`${at}: has ${question.options.length} options, more than the limit of ${LIMITS.maxOptions}.`);
        return;
      }
      question.options.forEach((option, optionIndex) => {
        if (typeof option !== 'string') {
          fail(`${at}, option ${optionIndex + 1}: must be a string.`);
        } else if (option.length > LIMITS.maxOptionLength) {
          fail(`${at}, option ${optionIndex + 1}: is longer than ${LIMITS.maxOptionLength} characters.`);
        }
      });

      /* This is the field whose absence used to kill the process. */
      if (!Array.isArray(question.correctIndices)) {
        fail(`${at}: correctIndices must be an array of option indices.`);
        return;
      }
      for (const correctIndex of question.correctIndices) {
        if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= question.options.length) {
          fail(`${at}: correctIndices contains ${JSON.stringify(correctIndex)}, which is not an index of its options.`);
          break;
        }
      }
    }

    if (question.type === 'estimation') {
      if (typeof question.correctAnswer !== 'number' || !Number.isFinite(question.correctAnswer)) {
        fail(`${at}: correctAnswer must be a finite number.`);
      }
    }

    if (question.type === 'ordering') {
      /* Copied from a multiple-choice question, correctIndices would be
         ignored -- and the author would believe it says which order is right. */
      if (question.correctIndices !== undefined) {
        fail(`${at}: correctIndices does not apply to ordering questions; list the options in the correct order instead.`);
      }
      if (!Array.isArray(question.options)) {
        fail(`${at}: options must be an array, listing the items in the correct order.`);
        return;
      }
      if (question.options.length < LIMITS.minOrderingItems) {
        fail(`${at}: needs at least ${LIMITS.minOrderingItems} options to order.`);
      }
      if (question.options.length > LIMITS.maxOrderingItems) {
        fail(`${at}: has ${question.options.length} options, more than the limit of ${LIMITS.maxOrderingItems} for an ordering question.`);
        return;
      }
      /* Two identical items look the same on the participant's screen, so
         there is no telling which of them goes first -- yet scoring would. */
      const seen = new Map();
      question.options.forEach((option, optionIndex) => {
        if (typeof option !== 'string') {
          fail(`${at}, option ${optionIndex + 1}: must be a string.`);
        } else if (option.length > LIMITS.maxOptionLength) {
          fail(`${at}, option ${optionIndex + 1}: is longer than ${LIMITS.maxOptionLength} characters.`);
        } else {
          const key = option.trim();
          if (seen.has(key)) {
            fail(`${at}, option ${optionIndex + 1}: is the same as option ${seen.get(key) + 1}; the items of an ordering question must differ.`);
          } else {
            seen.set(key, optionIndex);
          }
        }
      });
    }

    /* The validator ignores properties it does not know, so a `fuzzy` left over
       from before `match` would quietly turn into fuzzy matching. */
    if (question.fuzzy !== undefined) {
      fail(`${at}: fuzzy was replaced by match: write "match": "strict" for "fuzzy": false, and leave it out for "fuzzy": true.`);
    }
    if (question.match !== undefined && question.type !== 'short-answer') {
      fail(`${at}: match only applies to short-answer questions.`);
    }

    if (question.type === 'short-answer') {
      if (question.match !== undefined && !MATCH_MODES.includes(question.match)) {
        fail(`${at}: match must be one of ${MATCH_MODES.map((m) => `"${m}"`).join(', ')}.`);
      }
      const match = matchOf(question);

      const accepted = question.acceptedAnswers;
      if (!Array.isArray(accepted)) {
        fail(`${at}: acceptedAnswers must be an array of strings.`);
        return;
      }
      if (accepted.length === 0) {
        fail(`${at}: acceptedAnswers is empty; at least one answer must be accepted.`);
      }
      if (accepted.length > LIMITS.maxAcceptedAnswers) {
        fail(`${at}: has ${accepted.length} accepted answers, more than the limit of ${LIMITS.maxAcceptedAnswers}.`);
        return;
      }

      let variants = 0;
      accepted.forEach((answer, answerIndex) => {
        const where = `${at}, accepted answer ${answerIndex + 1}`;
        if (typeof answer !== 'string') {
          fail(`${where}: must be a string.`);
          return;
        }
        if (answer.length > LIMITS.maxAcceptedAnswerLength) {
          fail(`${where}: is longer than ${LIMITS.maxAcceptedAnswerLength} characters.`);
          return;
        }
        const expanded = expandAcceptedAnswer(answer, match);
        if (expanded.error) {
          fail(`${where} ${JSON.stringify(answer)} ${expanded.error}`);
          return;
        }
        variants += expanded.variants.length;
      });
      if (variants > LIMITS.maxAnswerVariants) {
        fail(`${at}: the optional parts of acceptedAnswers expand to ${variants} spellings, more than the limit of ${LIMITS.maxAnswerVariants}.`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * The part of the quiz a message is about, as a JSON path: `question 21:
 * acceptedAnswers must be ...` is `['questions', 20, 'acceptedAnswers']`.
 *
 * It reads the prefixes the messages in this file start with (and that the
 * code renderer and the sanitizer use for their warnings): `question N`,
 * optionally `, option M` or `, accepted answer M`, then `: <property> ...`;
 * or a top-level property, as in `title must be a string.`. A word that is not
 * a property costs nothing: locateJsonPath stops at the deepest part it finds.
 *
 * @param {string} message
 * @returns {Array<string|number>}
 */
export function quizMessagePath(message) {
  const question = /^question (\d+)(?:, (option|accepted answer) (\d+))?(?:: (\w+))?/.exec(message);
  if (question) {
    const [, number, list, item, property] = question;
    const path = ['questions', Number(number) - 1];
    if (list) path.push(list === 'option' ? 'options' : 'acceptedAnswers', Number(item) - 1);
    else if (property) path.push(property);
    return path;
  }
  const property = /^(\w+) /.exec(message);
  return property ? [property[1]] : [];
}

/**
 * The messages about a quiz, each prefixed with the line in `text` -- the
 * quiz's source -- that it is about, and followed by that line with a caret:
 *
 *   line 140: question 21: acceptedAnswers must be an array of strings.
 *     140 |       "acceptedAnswers": "Ausdrücke",
 *         |       ^
 *
 * "question 21" alone leaves the author counting objects in a long file. A
 * message whose place cannot be found is returned as it is.
 *
 * @param {string} text
 * @param {string[]} messages
 * @returns {string[]}
 */
export function locateQuizMessages(text, messages) {
  return messages.map((message) => {
    const path = quizMessagePath(message);
    const place = path.length > 0 ? locateJsonPath(text, path) : null;
    if (!place) return message;
    return `line ${place.line}: ${message}\n${place.excerpt.replace(/^/gm, '  ')}`;
  });
}

export { LIMITS as QUIZ_LIMITS };
