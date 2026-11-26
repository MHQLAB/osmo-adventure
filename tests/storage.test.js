import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSettings, importSettings } from '../src/platform/storage.js';

class Mem {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.get(k) ?? null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}

test('backup round-trip keeps only app keys', () => {
  const a = new Mem(); a.setItem('osmo.cal.v1.x.landscape', '{"r":1}'); a.setItem('other', 'secret');
  const text = exportSettings(a);
  assert.ok(!text.includes('secret'));
  const b = new Mem();
  assert.equal(importSettings(b, text), 1);
  assert.equal(b.getItem('osmo.cal.v1.x.landscape'), '{"r":1}');
});

test('import rejects foreign keys and bad format', () => {
  const b = new Mem();
  assert.equal(importSettings(b, JSON.stringify({ format: 'osmo-backup-v1', data: { evil: 'x', 'osmo.a': 'y' } })), 1);
  assert.equal(b.getItem('evil'), null);
  assert.throws(() => importSettings(b, '{"format":"nope"}'));
  assert.throws(() => importSettings(b, 'not json'));
});
