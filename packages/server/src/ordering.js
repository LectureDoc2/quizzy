/**
 * Ordering questions: the participant puts the question's items in order.
 *
 *   "type": "ordering",
 *   "options": ["<code>byte</code>", "<code>long</code>", "<code>float</code>"]
 *
 * The author lists the items in the correct order. Participants must never see
 * that order, so the room shows them a shuffled one (see Room.startQuestion())
 * and maps their answer back. Reusing `options` for the items means they are
 * rendered and sanitized like multiple-choice options -- code, math and all --
 * without any of the render pipeline knowing about this type.
 *
 * Pure JavaScript, no Node imports, like short-answer.js.
 */

/** Bounds. Ten items already fill a phone screen twice over. */
export const ORDERING_LIMITS = {
  minOrderingItems: 2,
  maxOrderingItems: 10
};

/**
 * A random order of `n` items, as the list of item indices in display order:
 * position `i` shows item `order[i]`. Never the identity -- that is the correct
 * order, and a participant who submits without moving anything must not score.
 *
 * @param {number} n at least 2
 * @param {() => number} [random] returns a number in [0, 1); for tests
 * @returns {number[]}
 */
export function shuffledOrder(n, random = Math.random) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (n > 1 && isIdentity(order)) {
    // Rotating by one is never the identity, and as random as the rest.
    order.push(order.shift());
  }
  return order;
}

/** Whether `order` lists 0, 1, 2, ... in sequence: the correct order. */
export function isIdentity(order) {
  return order.every((value, index) => value === index);
}

/**
 * Whether `value` is an array holding each of 0 .. n-1 exactly once. Tolerates
 * any JSON value, since answers arrive from untrusted participants.
 */
export function isPermutation(value, n) {
  if (!Array.isArray(value) || value.length !== n) return false;
  const seen = new Set();
  for (const index of value) {
    if (!Number.isInteger(index) || index < 0 || index >= n || seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

/** The inverse permutation: where each item of `order` is shown. */
export function invertOrder(order) {
  const inverse = new Array(order.length);
  order.forEach((item, position) => {
    inverse[item] = position;
  });
  return inverse;
}
