import test from 'node:test';
import assert from 'node:assert/strict';
import {
  homographyFromPoints, applyHomography, orderCorners, isConvexQuad, quadArea,
  orientationTransform, mapPoint, normalizeRotation,
} from '../src/vision/geometry.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('homography maps the 4 source points exactly', () => {
  const src = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const dst = [[12, 30], [210, 20], [230, 180], [5, 170]];
  const H = homographyFromPoints(src, dst);
  src.forEach((p, i) => { const [u, v] = applyHomography(H, ...p); close(u, dst[i][0]); close(v, dst[i][1]); });
});

test('identity homography', () => {
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const H = homographyFromPoints(pts, pts);
  const [u, v] = applyHomography(H, 0.3, 0.7); close(u, 0.3); close(v, 0.7);
});

test('degenerate points throw', () => {
  assert.throws(() => homographyFromPoints([[0, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]]));
});

test('orderCorners returns TL,TR,BR,BL regardless of input order', () => {
  const shuffled = [[90, 95], [10, 8], [5, 92], [95, 10]];
  assert.deepEqual(orderCorners(shuffled), [[10, 8], [95, 10], [90, 95], [5, 92]]);
});

test('convexity and area', () => {
  assert.equal(isConvexQuad([[0, 0], [10, 0], [10, 10], [0, 10]]), true);
  assert.equal(isConvexQuad([[0, 0], [10, 10], [10, 0], [0, 10]]), false); // متقاطع
  close(quadArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
});

test('normalizeRotation', () => {
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
});

test('orientationTransform: corners land inside output for all 16 combos', () => {
  const w = 640, h = 480;
  for (const rotation of [0, 90, 180, 270]) for (const flipH of [false, true]) for (const flipV of [false, true]) {
    const { outW, outH, matrix } = orientationTransform(w, h, { rotation, flipH, flipV });
    for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
      const [u, v] = mapPoint(matrix, x, y);
      assert.ok(u > -1e-9 && u < outW + 1e-9 && v > -1e-9 && v < outH + 1e-9, `${rotation},${flipH},${flipV}: ${u},${v}`);
    }
  }
});

test('orientationTransform: rotate 90 clockwise moves top-left to top-right', () => {
  const { outW, outH, matrix } = orientationTransform(640, 480, { rotation: 90 });
  assert.equal(outW, 480); assert.equal(outH, 640);
  const [u, v] = mapPoint(matrix, 0, 0); close(u, 480); close(v, 0);
});

test('orientationTransform: flipH mirrors x', () => {
  const { matrix } = orientationTransform(640, 480, { flipH: true });
  const [u, v] = mapPoint(matrix, 0, 0); close(u, 640); close(v, 0);
});

test('orientationTransform: 180 equals flipH+flipV', () => {
  const a = orientationTransform(640, 480, { rotation: 180 }).matrix;
  const b = orientationTransform(640, 480, { flipH: true, flipV: true }).matrix;
  a.forEach((v, i) => close(v, b[i]));
});
