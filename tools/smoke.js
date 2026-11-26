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

try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__osmoDebug.state.vw > 0, null, { timeout: 10000 });
  await page.waitForTimeout(2500);
  let d = await page.evaluate(() => window.__osmoDebug.diagData());
  check('camera stream opens', d.video !== '0×0', d.video);
  check('frames are processed', d.processFps > 0, `processFps=${d.processFps} ms=${d.processMs}`);
  check('rectified output sized', d.rectified !== '0×0' && d.rectified !== '300×150', d.rectified);
  check('orientation detected landscape', d.orientation === 'landscape');

  await page.click('#btnRotate');
  await page.waitForTimeout(300);
  d = await page.evaluate(() => window.__osmoDebug.diagData());
  check('rotate applies 90°', d.transform.rotation === 90);
  const dims = await page.evaluate(() => [document.getElementById('corrected').width, document.getElementById('corrected').height]);
  check('rotated canvas swaps dims', dims[1] > dims[0], dims.join('×'));

  await page.click('#btnSave');
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('osmo.cal')));
  check('calibration saved for landscape', saved.length === 1 && saved[0].endsWith('.landscape'), saved.join());
  await page.click('#btnDiag');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out + 'landscape.png', fullPage: true });

  // تغيير الاتجاه إلى طولي: يجب إيقاف الأوامر وطلب معايرة لهذا الاتجاه
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForTimeout(800);
  d = await page.evaluate(() => window.__osmoDebug.diagData());
  const banner = await page.evaluate(() => !document.getElementById('banner').hidden && document.getElementById('banner').textContent);
  check('orientation change detected', d.orientation === 'portrait');
  check('commands blocked after rotation without calibration', d.commandsAllowed === false);
  check('banner asks for calibration', !!banner && banner.includes('الطولي'), banner || '');
  await page.screenshot({ path: out + 'portrait.png', fullPage: true });

  // العودة للعرضي: يجب تحميل المعايرة المحفوظة تلقائيًا
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(800);
  d = await page.evaluate(() => window.__osmoDebug.diagData());
  check('saved landscape calibration restored', d.calibrationSaved === true && d.transform.rotation === 90);

  // العمل دون إنترنت بعد تثبيت عامل الخدمة
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.evaluate(() => navigator.serviceWorker.ready);
  await ctx.setOffline(true);
  await page.reload();
  const title = await page.title();
  check('app shell loads offline (Chromium)', title.includes('مغامرة'), title);
  await ctx.setOffline(false);

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
