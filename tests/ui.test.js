import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, crc32 } from '../src/ui/zip.js';
import { STEPS, evaluateAttempt, summarize } from '../src/ui/guided.js';
import { stepArt } from '../src/ui/pieceArt.js';
import { findSeparator } from '../src/vision/roi.js';

test('crc32 known value', () => { assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); });

test('zip is readable by a standard unzip (python zipfile)', () => {
  const zip = createZip([{ name: 'report.json', data: '{"a":1}' }, { name: 'صور/x.bin', data: new Uint8Array([1, 2, 3, 250]) }]);
  const dir = mkdtempSync(join(tmpdir(), 'z')); const f = join(dir, 't.zip'); writeFileSync(f, zip);
  const out = execFileSync('python3', ['-c', `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(sorted(z.namelist()));print(z.read('report.json').decode())`, f]).toString();
  assert.match(out, /None/); assert.match(out, /report\.json/); assert.match(out, /\{"a":1\}/);
});

test('15 guided steps in the requested order', () => {
  assert.equal(STEPS.length, 15);
  assert.deepEqual(STEPS.slice(0, 3).map((s) => s.id), ['empty', 'walk1', 'walk-dir']);
  assert.equal(STEPS.at(-1).id, 'program');
  for (const s of STEPS) assert.match(stepArt(s.art), /^<svg/);
});

const piece = (type, extra = {}) => ({ type, status: 'ok', confidence: 1, ...extra });
test('empty-surface attempt: correct only when nothing is detected', () => {
  const ok = evaluateAttempt(STEPS[0], '', { pieces: [], numbers: [] }, { ok: false, steps: [] });
  assert.equal(ok.correct, true);
  const bad = evaluateAttempt(STEPS[0], '', { pieces: [piece('hand')], numbers: [] }, { ok: false, steps: [] });
  assert.equal(bad.correct, false); assert.deepEqual(bad.extra, { hand: 1 });
});

test('attempt records direction/number correctness, missing and extra pieces', () => {
  const res = { pieces: [piece('walk', { arrow: { ok: true, dir: 'up' }, number: { digit: 2 } }), piece('jump')], numbers: [] };
  const prog = { ok: true, steps: [{ type: 'walk', dir: 'up', count: 2 }] };
  const r = evaluateAttempt(STEPS[4], 'مشي أعلى ٢', res, prog, { set: 'validation' });
  assert.equal(r.correct, true); assert.equal(r.dirCorrect, true); assert.equal(r.numberCorrect, true);
  assert.deepEqual(r.extra, { jump: 1 });
  const s = summarize([r, { ...r, set: 'dev', correct: false }]);
  assert.equal(s.validation.correct, 1); assert.equal(s.dev.correct, 0); // التطوير والتحقق منفصلان
});

test('separator line (silver edge) is found even when a finger crosses it', () => {
  const w = 200, h = 150, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = 185; d[i * 4 + 1] = 132; d[i * 4 + 2] = 70; d[i * 4 + 3] = 255; }
  for (let x = 20; x < 190; x++) if (x < 80 || x > 86) for (const y of [40, 41]) { const p = (y * w + x) * 4; d[p] = d[p + 1] = d[p + 2] = 225; }
  const s = findSeparator(d, w, h);
  assert.ok(s && Math.abs(s.y - 40 / h) < 0.02, JSON.stringify(s));
});
