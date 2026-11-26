import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationStore, makeDeviceKey, validateCalibration, isCompatible, CALIBRATION_VERSION } from '../src/calibration/store.js';
import { getOrientation } from '../src/platform/orientation.js';

class MemStorage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }

const cal = (o = 'landscape') => ({
  version: CALIBRATION_VERSION, orientation: o, rotation: 180, flipH: true, flipV: false,
  corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], videoW: 1280, videoH: 720, cameraId: 'x', createdAt: 0,
});

test('device key is orientation-independent and stable', () => {
  assert.equal(makeDeviceKey({ cameraId: 'a', screenW: 820, screenH: 1180, dpr: 2 }),
               makeDeviceKey({ cameraId: 'a', screenW: 1180, screenH: 820, dpr: 2 }));
  assert.notEqual(makeDeviceKey({ cameraId: 'a', screenW: 820, screenH: 1180, dpr: 2 }),
                  makeDeviceKey({ cameraId: 'b', screenW: 820, screenH: 1180, dpr: 2 }));
});

test('store keeps portrait and landscape separately', () => {
  const s = new CalibrationStore(new MemStorage());
  s.save('k', cal('landscape'));
  assert.equal(s.load('k', 'portrait'), null);
  s.save('k', { ...cal('portrait'), rotation: 90 });
  assert.equal(s.load('k', 'landscape').rotation, 180);
  assert.equal(s.load('k', 'portrait').rotation, 90);
  s.remove('k', 'portrait');
  assert.equal(s.load('k', 'portrait'), null);
});

test('invalid calibration rejected on save and ignored on load', () => {
  const st = new MemStorage(); const s = new CalibrationStore(st);
  assert.throws(() => s.save('k', { ...cal(), corners: [[2, 2]] }));
  st.setItem(s.key('k', 'landscape'), '{bad json');
  assert.equal(s.load('k', 'landscape'), null);
  assert.deepEqual(validateCalibration(cal()), []);
});

test('compatibility by aspect ratio', () => {
  assert.equal(isCompatible(cal(), 1920, 1080), true);
  assert.equal(isCompatible(cal(), 640, 480), false);
});

test('getOrientation fallbacks', () => {
  assert.equal(getOrientation({ screen: { orientation: { type: 'portrait-primary' } } }), 'portrait');
  assert.equal(getOrientation({ innerWidth: 1000, innerHeight: 700 }), 'landscape');
});
