// اختبار دخان في Chromium بكاميرا وهمية (نمط اختبار اصطناعي من المتصفح).
// تنبيه: هذا يتحقق من سلامة الكود فقط، وليس اختبارًا للآيباد أو لكاميرا حقيقية أو لعاكس Osmo.
import { chromium } from 'playwright';
import { startServer } from './serve.js';
import { mkdir } from 'node:fs/promises';

const PORT = 8123;
const out = new URL('../docs/smoke/', import.meta.url).pathname;
await mkdir(out, { recursive: true });
const server = await startServer(PORT);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const diag = (page) => page.evaluate(() => window.__osmoDebug.diagData());

try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__osmoDebug.state.vw > 0, null, { timeout: 10000 });
  await page.waitForTimeout(3000);
  let d = await diag(page);
  check('camera stream opens at 4:3', d.video !== '0×0', d.video);
  check('auto orientation on first start (rot 0 + flipH)', d.transform.rotation === 0 && d.transform.flipH === true, JSON.stringify(d.transform));
  check('auto calibration ran', !!d.auto, JSON.stringify(d.auto));
  check('monitor tier processes ROI only', d.processFps > 0 && !!d.monitor, `fps=${d.processFps} ms=${d.processMs} monitor=${d.monitor}`);
  check('duty cycle reported', typeof d.dutyPct === 'number', `${d.dutyPct}%`);

  // قراءة عالية الدقة: الكاميرا الوهمية فيها جسم متحرك دائمًا، فنحاكي لحظة الثبات
  await page.evaluate(() => { const s = window.__osmoDebug.state; s.corners = [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]]; s.mon.key = ''; s.rd.key = ''; });
  const rd = await page.evaluate(() => { const D = window.__osmoDebug; D.readHighRes(performance.now()); return { count: D.state.rd.count, out: `${D.state.rd.plan.outW}x${D.state.rd.plan.outH}`, ms: Math.round(D.state.rd.lastMs) }; });
  check('high-res read tier (up to 960) runs on demand', rd.count === 1 && rd.out.startsWith('960'), JSON.stringify(rd));

  await page.click('#btnRotate');
  await page.waitForTimeout(300);
  d = await diag(page);
  check('manual rotate still works', d.transform.rotation === 90);
  await page.click('#btnSave');
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('osmo.cal')));
  check('calibration saved for landscape', saved.length === 1 && saved[0].endsWith('.landscape'), saved.join());
  await page.click('#btnDiag');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out + 'landscape.png', fullPage: true });

  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForTimeout(1800);
  d = await diag(page);
  check('orientation change detected', d.orientation === 'portrait');
  check('commands blocked after rotation without calibration', d.commandsAllowed === false);
  // في المحاكاة تبقى الكاميرا الوهمية عرضية بينما الواجهة طولية ← يجب اقتراح 90° بثقة منخفضة (مثل خلل iPadOS 26)
  check('portrait auto calibration detects rotated frame', !!d.auto && d.transform.flipH === true && d.auto.orientation.reason === 'frame-rotated-vs-ui' && d.auto.orientation.confidence === 'low', JSON.stringify(d.auto?.orientation));
  await page.screenshot({ path: out + 'portrait.png', fullPage: true });

  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(800);
  d = await diag(page);
  check('saved landscape calibration restored', d.calibrationSaved === true && d.transform.rotation === 90);

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.evaluate(() => navigator.serviceWorker.ready);
  await ctx.setOffline(true);
  await page.reload();
  check('app shell loads offline (Chromium)', (await page.title()).includes('مغامرة'));
  await ctx.setOffline(false);

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
