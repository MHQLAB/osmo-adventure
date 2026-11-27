import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemap, remapRGBA, outputSize, estimateAspect } from '../src/vision/rectify.js';
import { analyze, motionScore, assessQuality, StabilityGate, lumaDownsample } from '../src/vision/quality.js';
import { AdaptiveScheduler } from '../src/vision/adaptive.js';

function img(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y); const p = (y * w + x) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
  }
  return d;
}

test('rectify: full-frame corners reproduce the image', () => {
  const w = 40, h = 30;
  const src = img(w, h, (x, y) => [x * 6, y * 8, 100]);
  const map = buildRemap([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], w, h, w, h);
  const out = remapRGBA(src, new Uint8ClampedArray(w * h * 4), map);
  assert.deepEqual(out, src);
});

test('rectify: sub-rectangle crop picks the right pixels', () => {
  const w = 40, h = 30;
  const src = img(w, h, (x, y) => [x, y, 0]);
  const map = buildRemap([[10, 5], [29, 5], [29, 24], [10, 24]], w, h, 20, 20);
  const out = remapRGBA(src, new Uint8ClampedArray(20 * 20 * 4), map);
  assert.equal(out[0], 10); assert.equal(out[1], 5);
  const last = (20 * 20 - 1) * 4; assert.equal(out[last], 29); assert.equal(out[last + 1], 24);
});

test('rectify: out-of-bounds samples become black, not garbage', () => {
  const map = buildRemap([[-10, -10], [50, -10], [50, 40], [-10, 40]], 40, 30, 10, 10);
  assert.equal(map[0], -1);
});

test('outputSize and estimateAspect', () => {
  assert.deepEqual(outputSize(2, 400), { w: 400, h: 200 });
  assert.deepEqual(outputSize(0.5, 400), { w: 200, h: 400 });
  assert.ok(Math.abs(estimateAspect([[0, 0], [200, 0], [200, 100], [0, 100]]) - 2) < 1e-9);
});

test('quality: flat dark image is flagged dark+blur+flat', () => {
  const m = analyze(img(64, 48, () => [10, 10, 10]), 64, 48);
  const codes = assessQuality(m).map((i) => i.code);
  assert.ok(codes.includes('dark')); assert.ok(codes.includes('blur')); assert.ok(codes.includes('flat'));
});

test('quality: well-lit checkerboard passes main checks', () => {
  const m = analyze(img(64, 48, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [200, 200, 200] : [60, 60, 60]), 64, 48);
  const codes = assessQuality(m).map((i) => i.code);
  assert.ok(!codes.includes('dark') && !codes.includes('bright') && !codes.includes('blur') && !codes.includes('flat'), codes.join());
});

test('quality: cast comes from illuminant estimate, not table color', () => {
  const m = analyze(img(32, 32, () => [185, 132, 70]), 32, 32);
  assert.ok(!assessQuality(m).some((i) => i.code === 'cast'));
  assert.ok(assessQuality({ ...m, illumCast: 0.2 }).some((i) => i.code === 'cast'));
});

test('motionScore', () => {
  const a = lumaDownsample(img(16, 16, () => [100, 100, 100]), 16, 16).data;
  const b = lumaDownsample(img(16, 16, () => [110, 110, 110]), 16, 16).data;
  assert.equal(motionScore(a, a), 0);
  assert.ok(motionScore(a, b) > 9);
  assert.equal(motionScore(null, a), Infinity);
});

test('StabilityGate requires sustained stillness', () => {
  const g = new StabilityGate({ threshold: 3, stableMs: 500 });
  assert.equal(g.update(1, 0).stable, false);
  assert.equal(g.update(1, 400).stable, false);
  assert.equal(g.update(1, 600).stable, true);
  assert.equal(g.update(10, 700).stable, false); // حركة تعيد العداد
  assert.equal(g.update(1, 800).stable, false);
  assert.equal(g.update(1, 1300).stable, true);
});

test('AdaptiveScheduler degrades when slow and recovers when fast', () => {
  const s = new AdaptiveScheduler({ budgetMs: 10, level: 2 });
  for (let i = 0; i < 10; i++) s.report(40);
  assert.ok(s.level < 2);
  const lvl = s.level;
  for (let i = 0; i < 200; i++) s.report(1);
  assert.ok(s.level >= lvl);
  assert.equal(s.shouldProcess(1000), true);
  assert.equal(s.shouldProcess(1001), false);
});
