import test from 'node:test';
import assert from 'node:assert/strict';
import { PIECES, inventory, totalPieces, byColor } from '../src/content/pieces.js';

test('inventory matches the physical set (31 pieces)', () => {
  assert.equal(totalPieces(), 31);
  const inv = inventory();
  assert.deepEqual([inv.walk, inv.jump, inv.hand, inv.rest, inv.repeat, inv.magic], [6, 3, 3, 2, 2, 1]);
  assert.deepEqual([inv['num-2'], inv['num-3'], inv['num-4'], inv['num-5']], [3, 3, 3, 2]);
});

test('ids unique; only walk/jump/hand carry arrows', () => {
  assert.equal(new Set(PIECES.map((p) => p.id)).size, PIECES.length);
  assert.deepEqual(PIECES.filter((p) => p.hasArrow).map((p) => p.id).sort(), ['hand', 'jump', 'walk']);
});

test('color alone is ambiguous for some pieces (recognition must use symbol)', () => {
  assert.ok(byColor('teal').length > 1);
  assert.ok(byColor('yellow').length > 1);
});
