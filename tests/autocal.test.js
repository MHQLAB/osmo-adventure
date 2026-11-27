import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestOrientation } from '../src/vision/autoorient.js';
import { estimateIlluminant, illuminantCast } from '../src/vision/illuminant.js';
import { CellMotion } from '../src/vision/motion.js';
import { autoPlayArea, largestRectangle } from '../src/vision/roi.js';
import { planRoi } from '../src/vision/rectify.js';
import { zoomForCorners, remapCornersForZoom } from '../src/vision/geometry.js';

function img(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const p = (y * w + x) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255; }
  return d;
}
const lumaOf = (rgba) => { const o = new Uint8Array(rgba.length / 4); for (let i = 0; i < o.length; i++) o[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8; return o; };
const rng = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test('orientation: frame matching UI → no rotation + one horizontal flip (single mirror)', () => {
  assert.deepEqual(suggestOrientation({ vw: 720, vh: 1280, orientation: 'portrait' }), { rotation: 0, flipH: true, flipV: false, confidence: 'high', reason: 'frame-matches-ui' });
  assert.equal(suggestOrientation({ vw: 1920, vh: 1440, orientation: 'landscape' }).rotation, 0);
});

test('orientation: rotated frame (iPadOS 26 standalone bug) → 90° with low confidence', () => {
  const s = suggestOrientation({ vw: 1280, vh: 720, orientation: 'portrait' });
  assert.equal(s.rotation, 90); assert.equal(s.confidence, 'low');
});

test('illuminant: wooden table under white light is NOT a cast', () => {
  const r = rng(1);
  const rgba = img(120, 80, (x, y) => (x > 50 && x < 60 && y > 30 && y < 40) ? [235, 235, 232] : [185 + r() * 10, 132, 70]);
  const est = estimateIlluminant(rgba, { step: 1 });
  assert.ok(est.reliable); assert.ok(illuminantCast(est) < 0.05, String(illuminantCast(est)));
});

test('illuminant: white objects under warm light are a cast', () => {
  const rgba = img(120, 80, (x, y) => (x > 50 && x < 70 && y > 30 && y < 50) ? [240, 215, 175] : [120, 90, 60]);
  assert.ok(illuminantCast(estimateIlluminant(rgba, { step: 1 })) > 0.1);
});

test('illuminant: no neutral pixels → unreliable (no false warning)', () => {
  assert.equal(illuminantCast(estimateIlluminant(img(60, 40, () => [185, 132, 70]), { step: 1 })), null);
});

test('motion: sensor noise and global exposure change do not count as motion', () => {
  const r = rng(7); const w = 160, h = 90;
  const base = img(w, h, (x, y) => [100 + ((x * 7 + y * 3) % 40), 90, 80]);
  const m = new CellMotion({ cellThreshold: 10 });
  m.update(lumaOf(base), w, h);
  const noisy = img(w, h, (x, y) => [100 + ((x * 7 + y * 3) % 40) + (r() * 8 - 4), 90 + (r() * 8 - 4), 80]);
  assert.equal(m.update(lumaOf(noisy), w, h).changed, 0);
  const brighter = img(w, h, (x, y) => [125 + ((x * 7 + y * 3) % 40), 115, 105]);
  assert.equal(m.update(lumaOf(brighter), w, h).changed, 0);
});

test('motion: a hand entering one area is local motion; a whole-frame pan is global', () => {
  const w = 160, h = 90; const m = new CellMotion();
  const tex = (dx) => img(w, h, (x, y) => { const v = ((x + dx) * 13 + y * 7) % 97; return [v * 2, v * 2, v * 2]; });
  m.update(lumaOf(tex(0)), w, h);
  const hand = img(w, h, (x, y) => (x < 40 && y < 30) ? [230, 190, 160] : (() => { const v = (x * 13 + y * 7) % 97; return [v * 2, v * 2, v * 2]; })());
  const a = m.update(lumaOf(hand), w, h);
  assert.ok(a.changed > 0 && !a.global, JSON.stringify({ c: a.changed, g: a.global }));
  m.update(lumaOf(tex(0)), w, h);
  const b = m.update(lumaOf(tex(5)), w, h);
  assert.ok(b.global, String(b.fraction));
});

test('largestRectangle respects mustContain', () => {
  const cols = 6, rows = 4;
  const mask = Uint8Array.from([1,1,0,1,1,1, 1,1,0,1,1,1, 1,1,0,1,1,1, 1,1,0,0,0,0]);
  const r = largestRectangle(mask, cols, rows, [4, 1]);
  assert.deepEqual([r.x0, r.x1, r.y0, r.y1], [3, 5, 0, 2]);
});

test('autoPlayArea: finds the table between floor, reflector frame and dark bezel; pieces do not break it', () => {
  const w = 320, h = 180;
  const rgba = img(w, h, (x, y) => {
    if (x < 30) return [200, 30, 30];            // إطار العاكس الأحمر
    if (x >= 290) return [20, 15, 10];           // حافة معتمة
    if (y < 30) return [175, 160, 148];          // أرضية خلف الطاولة
    if (x > 140 && x < 170 && y > 80 && y < 95) return [40, 140, 210]; // قطعة زرقاء
    return [185, 132, 70];                       // خشب
  });
  const res = autoPlayArea(rgba, w, h);
  assert.ok(res);
  const [[x0, y0], , [x1, y1]] = res.corners;
  assert.ok(x0 > 30 / w && x0 < 50 / w, `x0 ${x0}`);
  assert.ok(x1 < 290 / w && x1 > 270 / w, `x1 ${x1}`);
  assert.ok(y0 > 30 / h && y0 < 50 / h, `y0 ${y0}`);
  assert.ok(y1 > 0.95, `y1 ${y1}`);
  assert.ok(res.confidence > 0.5);
});

test('autoPlayArea: works on a dark table too (no white table required)', () => {
  const w = 320, h = 180;
  const rgba = img(w, h, (x, y) => (y < 40 ? [230, 230, 228] : [60, 45, 40]));
  const res = autoPlayArea(rgba, w, h);
  assert.ok(res && res.corners[0][1] > 40 / h);
});

test('planRoi: crops to the area and never upsamples beyond native pixels', () => {
  const p = planRoi([[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]], 1920, 1440, 960);
  assert.equal(p.bw, 960); assert.equal(p.bh, 720);
  assert.equal(p.outW, 960); assert.equal(p.scale, 1);
  const q = planRoi([[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]], 1920, 1440, 320);
  assert.equal(q.outW, 320); assert.ok(Math.abs(q.scale - 1 / 3) < 1e-9);
  const small = planRoi([[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]], 640, 360, 960);
  assert.ok(small.outW <= 128 && small.scale === 1);
});

test('zoom: maximal centered zoom keeps corners inside; remap is consistent', () => {
  const c = [[0.3, 0.2], [0.7, 0.2], [0.7, 0.8], [0.3, 0.8]];
  const z = zoomForCorners(c, 10, 0);
  assert.ok(Math.abs(z - 0.5 / 0.3) < 1e-9);
  const after = remapCornersForZoom(c, 1, z);
  for (const [x, y] of after) assert.ok(x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9);
  assert.deepEqual(remapCornersForZoom(after, z, 1).map((p) => p.map((v) => +v.toFixed(9))), c);
  assert.equal(zoomForCorners(c, 1.2, 0), 1.2);
});
