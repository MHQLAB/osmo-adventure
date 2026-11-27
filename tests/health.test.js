import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameHealth, RecoveryPolicy } from '../src/platform/framehealth.js';
import { sanitize, sanitizeBackup } from '../src/platform/privacy.js';
import { runProgram } from '../src/engine/robot.js';

test('black frames are never valid; persistent black is reported (report #3 case)', () => {
  const f = new FrameHealth({ blackMs: 800 }); f.frameArrived(0);
  assert.deepEqual(f.update({ now: 10, meanLuma: 0, contrast: 0 }).valid, false);
  assert.equal(f.update({ now: 100, meanLuma: 0, contrast: 0 }).status, 'ok'); // قصير: لا إنذار بعد
  f.frameArrived(900);
  assert.equal(f.update({ now: 950, meanLuma: 0, contrast: 0 }).status, 'black');
  assert.equal(f.update({ now: 960, meanLuma: 120, contrast: 40 }).valid, true);
});

test('frozen stream detected when no new frames arrive', () => {
  const f = new FrameHealth({ frozenMs: 1500 }); f.frameArrived(0);
  assert.equal(f.update({ now: 1000, meanLuma: 100, contrast: 30 }).status, 'ok');
  assert.equal(f.update({ now: 2000, meanLuma: 100, contrast: 30 }).status, 'frozen');
});

test('ended/muted tracks are invalid', () => {
  const f = new FrameHealth(); f.frameArrived(0);
  assert.equal(f.update({ now: 1, meanLuma: 100, contrast: 30, trackState: 'ended' }).status, 'ended');
  assert.equal(f.update({ now: 1, meanLuma: 100, contrast: 30, muted: true }).status, 'muted');
});

test('recovery policy backs off then gives up (no restart loop)', () => {
  const p = new RecoveryPolicy({ delays: [0, 2000, 8000], windowMs: 120000 });
  assert.equal(p.next(0).delayMs, 0);
  assert.equal(p.next(100).delayMs, 2000);
  assert.equal(p.next(3000).delayMs, 8000);
  assert.equal(p.next(12000).action, 'give-up');
  assert.equal(p.next(200000).action, 'restart'); // بعد انقضاء النافذة
  p.succeeded(); assert.equal(p.next(200001).delayMs, 0);
});

test('exported reports and backups drop camera identifiers', () => {
  const rep = sanitize({ trackSettings: { deviceId: 'X', groupId: 'Y', width: 1920 }, list: [{ deviceId: 'Z', a: 1 }] });
  assert.deepEqual(rep, { trackSettings: { width: 1920 }, list: [{ a: 1 }] });
  const b = sanitizeBackup({ format: 'osmo-backup-v1', origin: 'https://x', data: { 'osmo.cal.v1.k.portrait': JSON.stringify({ cameraId: 'RAW', rotation: 0 }) } });
  assert.equal(b.origin, undefined);
  assert.deepEqual(JSON.parse(b.data['osmo.cal.v1.k.portrait']), { rotation: 0 });
});

test('robot engine: walk/jump with counts, blocked moves reported, unsupported types flagged', () => {
  const r = runProgram([{ type: 'walk', dir: 'up', count: 2 }, { type: 'jump', dir: 'right' }, { type: 'walk', dir: 'up', count: 3 }, { type: 'magic' }], { start: [3, 4] });
  assert.deepEqual(r.end, [5, 0]); // ٢↑ ثم قفزة → ثم خطوتان ↑ ويصطدم بالحافة
  assert.deepEqual(r.issues.map((i) => i.kind), ['blocked', 'unsupported']);
});
