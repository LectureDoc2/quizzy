import { describe, it } from 'node:test';
import assert from 'node:assert';
import { invertOrder, isIdentity, isPermutation, shuffledOrder } from '../src/ordering.js';

/** A small seeded generator, so that a failure can be reproduced. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('shuffledOrder', () => {
  it('is a permutation, and never the correct order', () => {
    const random = seeded(42);
    for (let n = 2; n <= 10; n++) {
      for (let run = 0; run < 500; run++) {
        const order = shuffledOrder(n, random);
        assert.ok(isPermutation(order, n), JSON.stringify(order));
        assert.ok(!isIdentity(order), `n=${n}: ${JSON.stringify(order)}`);
      }
    }
  });

  it('rotates a shuffle that came out as the identity', () => {
    // A generator that always returns 0.999... swaps nothing: the identity.
    assert.deepStrictEqual(shuffledOrder(4, () => 0.9999), [1, 2, 3, 0]);
    assert.deepStrictEqual(shuffledOrder(2, () => 0.9999), [1, 0]);
  });

  it('reaches every other order', () => {
    const random = seeded(7);
    const seen = new Set();
    for (let run = 0; run < 2000; run++) seen.add(shuffledOrder(3, random).join());
    // 3! = 6 orders, less the correct one.
    assert.deepStrictEqual([...seen].sort(), ['0,2,1', '1,0,2', '1,2,0', '2,0,1', '2,1,0']);
  });
});

describe('isPermutation', () => {
  it('accepts each index exactly once', () => {
    assert.strictEqual(isPermutation([2, 0, 1], 3), true);
    assert.strictEqual(isPermutation([0], 1), true);
  });

  it('rejects anything else a participant might send', () => {
    for (const value of [
      [], [0, 1], [0, 1, 2, 3], [0, 0, 1], [0, 1, 3], [0, 1, -1], [0, 1, 1.5],
      ['0', '1', '2'], [0, 1, null], null, undefined, 42, '012', { 0: 0, 1: 1, 2: 2, length: 3 }
    ]) {
      assert.strictEqual(isPermutation(value, 3), false, JSON.stringify(value));
    }
  });
});

describe('invertOrder', () => {
  it('says where each item is shown', () => {
    // Position 0 shows item 2, position 1 item 0, position 2 item 1.
    assert.deepStrictEqual(invertOrder([2, 0, 1]), [1, 2, 0]);
    assert.deepStrictEqual(invertOrder(invertOrder([3, 1, 0, 2])), [3, 1, 0, 2]);
  });
});
