// اختبار دخان في Chromium بكاميرا وهمية (نمط اختبار اصطناعي من المتصفح).
// تنبيه: هذا يتحقق من سلامة الكود فقط، وليس اختبارًا للآيباد أو لكاميرا حقيقية أو لعاكس Osmo.
import { chromium } from 'playwright';
import { startServer } from './serve.js';
import { mkdir } from 'node:fs/promises';
import { renderScene } from '../tests/helpers/synth.js';

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

  // التعرف داخل المتصفح على مشهد اصطناعي (يثبت ربط الواجهة، لا دقة القطع الحقيقية)
  const u = 22;
  const scene = await renderScene({ w: 640, h: 480, pieces: [
    { type: 'walk', x: 320, y: 120, angle: 90, dir: 'up' }, { type: 'jump', x: 320, y: 120 + 4.2 * u + 2, angle: 90, dir: 'right' },
    { type: 'hand', x: 320, y: 120 + 2 * (4.2 * u + 2), angle: 90, dir: 'left' }] });
  const rec = await page.evaluate(async ({ data, w, h }) => {
    const D = window.__osmoDebug; D.state.stable = true;
    const img = new ImageData(new Uint8ClampedArray(data), w, h);
    D.runRecognition(img); D.runRecognition(img);
    D.state.stable = false; D.state.lastReRead = performance.now() + 1e9; // نمنع القراءة الدورية للكاميرا الوهمية من استبدال النتيجة
    return { program: document.getElementById('recogProgram').textContent, status: document.getElementById('recogStatus').textContent, run: !document.getElementById('btnRun').disabled };
  }, { data: Array.from(scene.rgba), w: scene.w, h: scene.h });
  check('in-browser recognition renders program and accepts after two identical reads', rec.program === 'مشي أعلى، قفز يمين، يد يسار' && rec.run, JSON.stringify(rec));
  await page.evaluate(() => document.getElementById('btnRun').click()); await page.waitForTimeout(1500);

  // عروض المسار والمعرض
  await page.click('.viewbtn[data-view="mask"]'); await page.waitForTimeout(200);
  const gal = await page.evaluate(() => document.querySelectorAll('#candGallery figure').length);
  check('mask view renders and candidate gallery shows dial crops', gal >= 3, `crops=${gal}`);
  await page.click('.viewbtn[data-view="overlay"]');

  // الاختبار الموجّه: الخطوة 13 (قطعتان) — نسجل ونقارن
  const g = await page.evaluate(() => { const D = window.__osmoDebug; D.state.guided.idx = 13; document.getElementById('btnGuidedNext').click(); document.getElementById('btnGuidedPrev').click();
    document.getElementById('guidedExpected').value = 'مشي أعلى، قفز يمين، يد يسار'; D.guidedCapture(); return { res: document.getElementById('guidedResult').textContent, sum: document.getElementById('guidedSummary').textContent }; });
  check('guided capture records a correct attempt in the validation set', g.res.startsWith('✓') && g.sum.includes('تحقق: محاولات 1'), JSON.stringify(g));

  // حزمة التصدير ZIP مع الصور بالموافقة
  await page.click('#btnExportPack'); await page.waitForTimeout(300);
  const prev = await page.evaluate(() => document.querySelectorAll('#packPreview figure').length);
  await page.check('#packImages');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#packDialog button[value="yes"]')]);
  const zipPath = await dl.path();
  const { execFileSync } = await import('node:child_process');
  const listing = execFileSync('python3', ['-c', "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);n=z.namelist();r=json.loads(z.read('report.json'));print(json.dumps({'n':len(n),'imgs':sum(1 for x in n if x.startswith('images/')),'raw':any('raw' in x for x in n),'ids':('deviceId' in z.read('report.json').decode()) or ('groupId' in z.read('report.json').decode()),'guided':len(r['guided']['records'])}))", zipPath]).toString();
  const z = JSON.parse(listing);
  check('test pack ZIP: report + consented images, no raw, no camera ids', prev >= 3 && z.imgs >= 3 && !z.raw && !z.ids && z.guided >= 1, listing.trim());

  // الإطار الأسود: نستبدل مصدر الفيديو بإطارات سوداء ونتحقق من الرفض ثم الاستعادة دون حلقة
  await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d'); setInterval(() => { x.fillStyle = '#000'; x.fillRect(0, 0, 640, 480); }, 50); document.getElementById('video').srcObject = c.captureStream(15); document.getElementById('video').play(); });
  await page.waitForTimeout(2500);
  d = await diag(page);
  check('black frames detected and never treated as valid', d.frame.events.some((e) => e.kind.startsWith('recover:black')) || d.frame.status === 'black', JSON.stringify(d.frame));
  await page.waitForTimeout(6000);
  d = await diag(page);
  check('camera recovered automatically after black frames', d.frame.valid === true && d.frame.status === 'ok', JSON.stringify({ s: d.frame.status, ev: d.frame.events.map((e) => e.kind) }));

  // تغير ارتفاع النافذة (شريط Safari) دون تغير الاتجاه: لا إعادة معايرة ولا أخطاء
  const before = (await diag(page)).corners;
  await page.setViewportSize({ width: 1180, height: 760 }); await page.waitForTimeout(800);
  await page.setViewportSize({ width: 1180, height: 820 }); await page.waitForTimeout(800);
  d = await diag(page);
  check('viewport height change keeps orientation and corners', d.orientation === 'landscape' && JSON.stringify(d.corners) === JSON.stringify(before));

  // التقرير المصدّر بلا معرفات
  await page.click('#btnDiag');
  await page.click('#btnReport'); await page.waitForTimeout(300);
  const rep = await page.evaluate(() => document.getElementById('reportOut').value);
  check('exported report has no deviceId/groupId', rep.length > 100 && !/deviceId|groupId/.test(rep));
  await page.click('#btnDiag');

  await page.click('#btnRotate');
  await page.waitForTimeout(300);
  d = await diag(page);
  check('manual rotate still works', d.transform.rotation === 90);
  await page.click('#btnSave');
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('osmo.cal')));
  check('calibration saved for landscape', saved.length === 1 && saved[0].endsWith('.landscape'), saved.join());
  const rawId = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).cameraId, saved[0]);
  check('saved calibration does not store raw camera id', rawId === undefined);
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
  // تحديث الإصدار = استبدال مخزن الملفات فقط؛ المعايرة والإحصاءات في localStorage تبقى
  const kept = await page.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); const r = await navigator.serviceWorker.getRegistration(); await r?.unregister(); return Object.keys(localStorage).filter((k) => k.startsWith('osmo.')).length; });
  await page.reload(); await page.waitForTimeout(500);
  const after = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('osmo.')).length);
  check('update (cache cleared + SW re-registered) keeps calibration/stats', kept > 0 && after === kept, `${kept} → ${after}`);

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
