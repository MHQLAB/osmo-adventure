// يضمن إمكانية النقل بين GitHub Pages (/osmo-adventure/) والنطاق المخصص (جذر osmo.mohammedhq.com):
// لا مسارات مطلقة في ملفات التطبيق.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('manifest uses relative scope/start_url/icons', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  for (const v of [m.id, m.start_url, m.scope, ...m.icons.map((i) => i.src)]) assert.ok(!v.startsWith('/') && !/^https?:/.test(v), v);
});

test('index.html has no root-absolute or hard-coded host URLs', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) assert.ok(!r.startsWith('/') && !/^https?:/.test(r), r);
  assert.ok(!/github\.io|mohammedhq/.test(html));
});

test('service worker caches relative paths only and app registers it relatively', () => {
  const sw = read('sw.js');
  const assets = [...sw.matchAll(/'(\.[^']*)'/g)].map((m) => m[1]);
  assert.ok(assets.length > 5);
  for (const a of assets) assert.ok(a.startsWith('./'), a);
  assert.ok(!/github\.io|mohammedhq/.test(sw));
  assert.match(read('src/app.js'), /register\('sw\.js'\)/);
});

test('every module the app imports is cached for offline', () => {
  const sw = read('sw.js');
  for (const f of ['src/app.js', 'src/vision/geometry.js', 'src/vision/rectify.js', 'src/vision/quality.js', 'src/vision/adaptive.js', 'src/vision/autoorient.js', 'src/vision/illuminant.js', 'src/vision/motion.js', 'src/vision/roi.js',
    'src/calibration/store.js', 'src/platform/orientation.js', 'src/platform/camera.js', 'src/platform/storage.js', 'src/platform/framehealth.js', 'src/platform/privacy.js', 'src/recognition/pixels.js', 'src/recognition/components.js', 'src/recognition/arrow.js', 'src/recognition/digits.js', 'src/recognition/digit-templates.js', 'src/recognition/digit-templates-real.js', 'src/recognition/recognize.js', 'src/recognition/program.js', 'src/engine/robot.js', 'src/content/pieces.js']) {
    assert.ok(sw.includes(`'./${f}'`), f);
  }
});

test('every src module is listed in the service worker (auto-discovered)', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(new URL('../' + d, import.meta.url)).flatMap((f) => statSync(new URL('../' + d + '/' + f, import.meta.url)).isDirectory() ? walk(d + '/' + f) : [d + '/' + f]);
  const sw = read('sw.js');
  for (const f of walk('src').filter((f) => f.endsWith('.js'))) assert.ok(sw.includes(`'./${f}'`), `missing in sw.js: ${f}`);
});
