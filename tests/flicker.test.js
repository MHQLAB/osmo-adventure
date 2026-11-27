import test from 'node:test';
import assert from 'node:assert/strict';
import { FlickerMask } from '../src/vision/motion.js';

test('a persistently flickering cell is masked; a hand passing through is not', () => {
  const m = new FlickerMask({ cells: 20, window: 10, ratio: 0.6 });
  let last;
  for (let t = 0; t < 30; t++) { const f = new Uint8Array(20); f[3] = 1; last = m.update(f); }
  assert.equal(last, 0); assert.equal(m.maskedCount, 1);
  const hand = new Uint8Array(20); hand[7] = hand[8] = 1;
  assert.equal(m.update(hand), 2);
});

test('large persistent change is not masked (real problem, not flicker)', () => {
  const m = new FlickerMask({ cells: 20, window: 10, ratio: 0.6, maxMasked: 0.15 });
  let last; for (let t = 0; t < 20; t++) last = m.update(new Uint8Array(20).fill(1));
  assert.equal(m.maskedCount, 0); assert.equal(last, 20);
});
