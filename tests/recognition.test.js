// اختبارات محرك التعرف على مشاهد اصطناعية بإجابات معروفة.
// نجاحها يثبت منطق الخوارزمية فقط، لا دقة التعرف على القطع الحقيقية بكاميرا الآيباد.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScene } from './helpers/synth.js';
import { recognize } from '../src/recognition/recognize.js';
import { buildProgram, parseExpected, compareProgram, stepsToText } from '../src/recognition/program.js';

const ok = (r) => r.pieces.filter((p) => p.status !== 'ghost');

test('single walk piece: type, position, arrow up', async () => {
  const s = await renderScene({ pieces: [{ type: 'walk', x: 320, y: 240, angle: 0, dir: 'up' }] });
  const r = recognize(s.rgba, s.w, s.h);
  const ps = ok(r);
  assert.equal(ps.length, 1, JSON.stringify(ps.map((p) => p.type)));
  assert.equal(ps[0].type, 'walk');
  assert.ok(Math.abs(ps[0].cx - 320) < 20 && Math.abs(ps[0].cy - 240) < 12, `${ps[0].cx},${ps[0].cy}`);
  assert.equal(ps[0].arrow?.dir, 'up', JSON.stringify(ps[0].arrow));
  assert.equal(ps[0].status, 'ok', JSON.stringify(ps[0].reasons));
});

for (const dir of ['up', 'down', 'left', 'right']) {
  for (const angle of [0, 90, 30]) {
    test(`arrow ${dir} on piece rotated ${angle}°`, async () => {
      const s = await renderScene({ pieces: [{ type: 'walk', x: 320, y: 240, angle, dir }] });
      const p = ok(recognize(s.rgba, s.w, s.h)).find((q) => q.type === 'walk');
      assert.ok(p, 'walk not found');
      assert.equal(p.arrow?.dir, dir, JSON.stringify(p.arrow));
    });
  }
}

test('jump (red) and hand (orange) on wood: not confused with the table', async () => {
  const s = await renderScene({ pieces: [{ type: 'jump', x: 200, y: 150, dir: 'right' }, { type: 'hand', x: 420, y: 330, dir: 'left' }] });
  const ps = ok(recognize(s.rgba, s.w, s.h));
  assert.deepEqual(ps.map((p) => p.type).sort(), ['hand', 'jump']);
  assert.equal(ps.find((p) => p.type === 'jump').arrow.dir, 'right');
  assert.equal(ps.find((p) => p.type === 'hand').arrow.dir, 'left');
});

test('rest, magic, repeat and the three functions', async () => {
  const s = await renderScene({ w: 800, h: 520, pieces: [
    { type: 'rest', x: 140, y: 100 }, { type: 'magic', x: 400, y: 100 }, { type: 'repeat', x: 660, y: 100 },
    { type: 'function', icon: 'circle', x: 140, y: 330 }, { type: 'function', icon: 'square', x: 400, y: 330 }, { type: 'function', icon: 'star', x: 660, y: 330 },
  ] });
  const types = ok(recognize(s.rgba, s.w, s.h)).map((p) => p.type).sort();
  assert.deepEqual(types, ['func-circle', 'func-square', 'func-star', 'magic', 'repeat', 'rest']);
});

for (const digit of [2, 3, 4, 5]) {
  test(`number ${digit} attached to a walk piece (digit rotated 25°)`, async () => {
    const s = await renderScene({ pieces: [{ type: 'walk', x: 300, y: 240, dir: 'up' }, { type: 'number', digit, x: 300 + 2.1 * 22 * 0.5 + 40, y: 240, angle: 90, digitAngle: 25 }] });
    const r = recognize(s.rgba, s.w, s.h);
    const walk = ok(r).find((p) => p.type === 'walk');
    assert.equal(walk?.number?.digit, digit, JSON.stringify(r.numbers.map((n) => n.read)));
  });
}

test('chain of three connected pieces → ordered program from the iPad side (top)', async () => {
  const u = 22, step = 1.8 * u + 2; // متلاصقة على المحور الرأسي
  const s = await renderScene({ pieces: [
    { type: 'walk', x: 320, y: 120, angle: 90, dir: 'up' },
    { type: 'jump', x: 320, y: 120 + 4.2 * u + 2, angle: 90, dir: 'right' },
    { type: 'hand', x: 320, y: 120 + 2 * (4.2 * u + 2), angle: 90, dir: 'left' },
  ] });
  const r = recognize(s.rgba, s.w, s.h);
  const prog = buildProgram(r);
  assert.ok(prog.ok, JSON.stringify(prog.reasons));
  assert.equal(stepsToText(prog.steps), 'مشي أعلى، قفز يمين، يد يسار');
  assert.ok(step > 0);
});

test('two separate pieces → rejected as multiple chains', async () => {
  const s = await renderScene({ pieces: [{ type: 'walk', x: 150, y: 120, dir: 'up' }, { type: 'jump', x: 480, y: 380, dir: 'down' }] });
  const prog = buildProgram(recognize(s.rgba, s.w, s.h));
  assert.equal(prog.ok, false);
  assert.ok(prog.reasons.includes('multiple-chains'));
});

test('works on a dark table and on a white table (no special surface)', async () => {
  for (const bg of ['#3a2f2a', '#efefec']) {
    const s = await renderScene({ bg, grain: false, pieces: [{ type: 'walk', x: 320, y: 240, dir: 'left' }, { type: 'jump', x: 320, y: 360, dir: 'down' }] });
    const types = ok(recognize(s.rgba, s.w, s.h)).map((p) => p.type).sort();
    assert.deepEqual(types, ['jump', 'walk'], bg);
  }
});

test('empty table → no pieces, program rejected with reason', async () => {
  const s = await renderScene({ pieces: [] });
  const r = recognize(s.rgba, s.w, s.h);
  assert.equal(ok(r).length, 0);
  assert.deepEqual(buildProgram(r).reasons, ['no-pieces']);
});

test('expected-vs-actual parsing and comparison (Arabic and English, Arabic-Indic digits)', () => {
  const e = parseExpected('مشي أعلى ٣، قفز يمين، hand left');
  assert.deepEqual(e, [{ type: 'walk', dir: 'up', count: 3 }, { type: 'jump', dir: 'right', count: 1 }, { type: 'hand', dir: 'left', count: 1 }]);
  assert.equal(compareProgram(e, e).correct, true);
  const c = compareProgram(e, [{ type: 'walk', dir: 'up', count: 2 }, { type: 'jump', dir: 'right', count: 1 }]);
  assert.deepEqual(c.errors.map((x) => x.kind), ['count', 'missing']);
});
