// صفحة اختبار الكاميرا والمعايرة.
// تربط وحدات الرؤية الصرفة بالمتصفح. لا تُرسل أي صورة خارج الجهاز.
//
// خط المعالجة (v0.2):
//   معاينة: الفيديو ← تصحيح الاتجاه ← لوحة 640 للعرض وتحريك الزوايا فقط (≤30 إطار/ث).
//   مراقبة: منطقة اللعب فقط بدقة 320 ← حركة بالخلايا + جودة + إضاءة (معدل تكيفي، يهدأ عند الثبات).
//   قراءة: عند ثبات المشهد مرة واحدة بدقة عالية تكيفية (حتى 960) ← ما سيستخدمه التعرف على القطع.
import { orientationTransform, orderCorners, isConvexQuad, quadArea, zoomForCorners, remapCornersForZoom } from './vision/geometry.js';
import { buildRemap, remapRGBA, planRoi } from './vision/rectify.js';
import { analyze, assessQuality, StabilityGate, lumaDownsample } from './vision/quality.js';
import { AdaptiveScheduler } from './vision/adaptive.js';
import { CellMotion } from './vision/motion.js';
import { estimateIlluminant, illuminantCast } from './vision/illuminant.js';
import { autoPlayArea } from './vision/roi.js';
import { suggestOrientation } from './vision/autoorient.js';
import { CalibrationStore, makeDeviceKey, isCompatible, CALIBRATION_VERSION } from './calibration/store.js';
import { getOrientation, onOrientationChange } from './platform/orientation.js';
import { cameraSupport, listCameras, openCamera, trackInfo, stopStream, applyTrackConstraint } from './platform/camera.js';
import { exportSettings, importSettings, requestPersistence } from './platform/storage.js';

export const APP_VERSION = 'dev'; // يُختم عند النشر
const PREVIEW_SIDE = 640;
const MONITOR_SIDE = 320;
const READ_LEVELS = [960, 720, 540];
const DEFAULT_CORNERS = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), banner: $('banner'), video: $('video'), cameraSelect: $('cameraSelect'),
  btnStart: $('btnStart'), btnStop: $('btnStop'), support: $('support'),
  corrected: $('corrected'), overlay: $('overlay'), rectified: $('rectified'), transformInfo: $('transformInfo'),
  quality: $('quality'), btnSave: $('btnSave'), btnDeleteCal: $('btnDeleteCal'), btnAuto: $('btnAuto'), autoInfo: $('autoInfo'),
  btnDiag: $('btnDiag'), panelDiag: $('panelDiag'), diag: $('diag'), btnReport: $('btnReport'),
  btnSnapshot: $('btnSnapshot'), reportOut: $('reportOut'), consent: $('consent'),
  btnRotate: $('btnRotate'), btnFlipH: $('btnFlipH'), btnFlipV: $('btnFlipV'), btnResetCorners: $('btnResetCorners'),
  btnZoom: $('btnZoom'), btnWb: $('btnWb'),
};

const store = new CalibrationStore(safeStorage());
const scheduler = new AdaptiveScheduler({ budgetMs: 8 });
const gate = new StabilityGate({ threshold: 0, stableMs: 800 });
const motion = new CellMotion({ cols: 16, rows: 9, cellThreshold: 10 });

const state = {
  stream: null, cameraId: '', cameraLabel: '', info: null,
  rotation: 0, flipH: true, flipV: false, corners: DEFAULT_CORNERS.map((p) => [...p]), zoom: 1,
  orientation: getOrientation(), commandsAllowed: false, needsRevalidation: false,
  vw: 0, vh: 0, auto: null, wbLocked: false,
  mon: { key: '', plan: null, map: null, canvas: null, ctx: null, img: null },
  rd: { key: '', plan: null, map: null, canvas: null, ctx: null, img: null, level: 0, lastMs: 0, count: 0, at: 0 },
  metrics: null, illum: null, issues: [], motion: null, stable: false, wasStable: false, globalEvents: [],
  fps: 0, procFps: 0, procMs: 0, busyMs: 0, dutyPct: 0, frames: 0, procs: 0, fpsT: performance.now(), lastPreview: 0,
  drag: -1, savedForOrientation: false, wakeLock: null, raf: 0,
};

const ctxC = el.corrected.getContext('2d', { willReadFrequently: true });
const ctxO = el.overlay.getContext('2d');
const ctxR = el.rectified.getContext('2d');

init();

function init() {
  const sup = cameraSupport();
  el.support.textContent =
    `اتصال آمن: ${sup.secureContext ? 'نعم' : 'لا'} · واجهة الكاميرا: ${sup.mediaDevices ? 'متاحة' : 'غير متاحة'} · وضع التطبيق المثبت: ${sup.standalone ? 'نعم' : 'لا'}`;
  if (!sup.secureContext || !sup.mediaDevices) {
    setStatus('err', 'الكاميرا غير متاحة');
    showBanner('يجب فتح الصفحة عبر رابط HTTPS في Safari حتى تعمل الكاميرا.');
    el.btnStart.disabled = true;
  }
  el.btnStart.onclick = startCamera;
  el.btnStop.onclick = () => stopCamera('أوقفت الكاميرا');
  el.cameraSelect.onchange = () => { if (state.stream) startCamera(); };
  el.btnRotate.onclick = () => { state.rotation = (state.rotation + 90) % 360; onGeometryChanged(); };
  el.btnFlipH.onclick = () => { state.flipH = !state.flipH; onGeometryChanged(); };
  el.btnFlipV.onclick = () => { state.flipV = !state.flipV; onGeometryChanged(); };
  el.btnResetCorners.onclick = () => { state.corners = DEFAULT_CORNERS.map((p) => [...p]); onGeometryChanged(); };
  el.btnAuto.onclick = () => autoCalibrate(true);
  el.btnSave.onclick = saveCalibration;
  el.btnDeleteCal.onclick = () => { if (state.cameraId) store.remove(deviceKey(), state.orientation); state.savedForOrientation = false; state.commandsAllowed = false; updateStatus(); };
  el.btnZoom.onclick = autoZoom;
  el.btnWb.onclick = toggleWbLock;
  el.btnDiag.onclick = () => {
    const show = el.panelDiag.hidden; el.panelDiag.hidden = !show; el.btnDiag.setAttribute('aria-pressed', String(show));
  };
  el.btnReport.onclick = copyReport;
  $('btnExport').onclick = async () => {
    const text = exportSettings(localStorage);
    el.reportOut.hidden = false; el.reportOut.readOnly = true; el.reportOut.value = text;
    try { await navigator.clipboard.writeText(text); $('btnExport').textContent = 'نُسخت ✓'; } catch { el.reportOut.select(); }
  };
  $('btnExportFile').onclick = () => downloadBlob(new Blob([exportSettings(localStorage)], { type: 'application/json' }), `osmo-backup-${new Date().toISOString().slice(0, 10)}.json`);
  $('importFile').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { const n = importSettings(localStorage, await f.text()); showBanner(`استُعيدت ${n} من الإعدادات والتقدم.`); loadCalibrationForOrientation(false); }
    catch { showBanner('الملف ليس نسخة احتياطية صالحة لهذا التطبيق.'); }
    e.target.value = '';
  };
  $('btnImport').onclick = () => {
    if (el.reportOut.hidden || el.reportOut.readOnly) {
      el.reportOut.hidden = false; el.reportOut.readOnly = false; el.reportOut.value = '';
      el.reportOut.placeholder = 'الصق النسخة الاحتياطية هنا ثم اضغط «لصق إعدادات» مرة أخرى';
      el.reportOut.focus(); return;
    }
    try { const n = importSettings(localStorage, el.reportOut.value); $('btnImport').textContent = `استُورد ${n} ✓`; loadCalibrationForOrientation(false); }
    catch { $('btnImport').textContent = 'نسخة غير صالحة'; }
  };
  el.btnSnapshot.onclick = () => el.consent.showModal();
  el.consent.addEventListener('close', () => { if (el.consent.returnValue === 'yes') saveSnapshot(); });
  setupPointer();
  onOrientationChange(handleOrientationChange);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera('توقفت الكاميرا عند مغادرة الصفحة'); });
  window.addEventListener('pagehide', () => stopCamera(''));
  el.video.addEventListener('resize', onVideoResize);
  registerServiceWorker();
  requestPersistence();
}

// ---------- الكاميرا ----------
async function startCamera() {
  stopCamera('');
  setStatus('', 'جارٍ تشغيل الكاميرا…');
  try {
    let stream;
    try { stream = await openCamera({ deviceId: el.cameraSelect.value || undefined }); }
    catch (e) { if (e?.name === 'OverconstrainedError') stream = await openCamera({ deviceId: el.cameraSelect.value || undefined, width: 1280, height: 720 }); else throw e; }
    state.stream = stream;
    state.info = trackInfo(stream);
    state.cameraId = state.info?.settings?.deviceId || el.cameraSelect.value || 'default';
    state.cameraLabel = state.info?.label || '';
    state.zoom = state.info?.settings?.zoom || 1; state.wbLocked = false;
    el.btnZoom.disabled = !state.info?.capabilities?.zoom;
    el.btnWb.disabled = !(state.info?.capabilities?.whiteBalanceMode || []).includes?.('manual');
    el.video.srcObject = stream;
    await el.video.play();
    await refreshCameraList();
    el.btnStart.textContent = 'إعادة التشغيل'; el.btnStop.disabled = false;
    requestWakeLock();
    state.vw = 0; onVideoResize();
    const loaded = loadCalibrationForOrientation(false);
    if (loaded?.zoom > 1) await setZoom(loaded.zoom, false);
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(loop);
    if (!loaded) setTimeout(() => autoCalibrate(false), 700); // أول تشغيل: معايرة تلقائية دون انتظار المستخدم
  } catch (e) {
    setStatus('err', 'تعذر تشغيل الكاميرا');
    showBanner(cameraErrorMessage(e));
  }
}

function stopCamera(msg) {
  cancelAnimationFrame(state.raf);
  if (state.stream) { stopStream(state.stream); state.stream = null; el.video.srcObject = null; }
  state.commandsAllowed = false;
  state.wakeLock?.release?.().catch(() => {}); state.wakeLock = null;
  el.btnStop.disabled = true;
  if (msg) setStatus('', msg);
}

async function refreshCameraList() {
  try {
    const cams = await listCameras();
    const cur = el.cameraSelect.value;
    el.cameraSelect.innerHTML = '<option value="">الكاميرا الأمامية (افتراضي)</option>' +
      cams.map((c) => `<option value="${escapeHtml(c.deviceId)}">${escapeHtml(c.label)}</option>`).join('');
    el.cameraSelect.value = cams.some((c) => c.deviceId === cur) ? cur : '';
  } catch { /* تجاهل */ }
}

function cameraErrorMessage(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError') return 'تم رفض إذن الكاميرا. من الإعدادات ← Safari ← الكاميرا، اختر «سماح» ثم أعد المحاولة.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'لم يتم العثور على الكاميرا المختارة. اختر «الكاميرا الأمامية».';
  if (n === 'NotReadableError') return 'الكاميرا مستخدمة من تطبيق آخر. أغلقه ثم أعد المحاولة.';
  return `خطأ في الكاميرا: ${n || e}`;
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request?.('screen'); } catch { /* اختياري */ }
}

// تقريب الكاميرا: يقص حول المركز داخل المستشعر قبل التصغير، فيرفع البكسلات على منطقة اللعب.
async function setZoom(z, remap = true) {
  const from = state.zoom || 1;
  const r = await applyTrackConstraint(state.stream, { zoom: z });
  if (!r.ok) { el.autoInfo.textContent = `التقريب غير مدعوم هنا (${r.error}).`; return false; }
  const actual = r.settings.zoom || z;
  if (remap) state.corners = remapCornersForZoom(state.corners, from, actual);
  state.zoom = actual; state.info = trackInfo(state.stream);
  onGeometryChanged();
  return true;
}

async function autoZoom() {
  const max = Math.min(state.info?.capabilities?.zoom?.max || 1, 4);
  const target = zoomForCorners(remapCornersForZoom(state.corners, state.zoom, 1), max, 0.04);
  if (target <= 1.05 && state.zoom <= 1.05) { el.autoInfo.textContent = 'منطقة اللعب ليست في وسط الصورة؛ التقريب لن يفيد هنا.'; return; }
  if (await setZoom(target)) el.autoInfo.textContent = `التقريب ${target.toFixed(2)}×. احفظ المعايرة إن كانت الصورة أوضح.`;
}

async function toggleWbLock() {
  const mode = state.wbLocked ? 'continuous' : 'manual';
  const r = await applyTrackConstraint(state.stream, { whiteBalanceMode: mode });
  if (r.ok) { state.wbLocked = mode === 'manual'; el.btnWb.textContent = state.wbLocked ? 'إلغاء قفل توازن الأبيض' : 'قفل توازن الأبيض (تجريبي)'; state.info = trackInfo(state.stream); }
  else el.autoInfo.textContent = `تعذر تغيير توازن الأبيض (${r.error}).`;
}

// ---------- الهندسة ----------
function onVideoResize() {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!vw || !vh) return;
  if (vw !== state.vw || vh !== state.vh) {
    const hadSize = state.vw > 0;
    state.vw = vw; state.vh = vh;
    if (hadSize) {
      state.commandsAllowed = false; state.needsRevalidation = true; gate.reset(); motion.reset();
      loadCalibrationForOrientation(true);
    }
    onGeometryChanged();
  }
}

function nativeTransform() { return orientationTransform(state.vw, state.vh, state); }

function onGeometryChanged() {
  if (!state.vw) return;
  const t = nativeTransform();
  const s = PREVIEW_SIDE / Math.max(t.outW, t.outH);
  const w = Math.round(t.outW * s), h = Math.round(t.outH * s);
  if (el.corrected.width !== w || el.corrected.height !== h) {
    el.corrected.width = el.overlay.width = w; el.corrected.height = el.overlay.height = h;
  }
  state.mon.key = ''; state.rd.key = ''; motion.reset(); gate.reset();
  state.savedForOrientation = false;
  el.transformInfo.textContent = `video ${state.vw}×${state.vh} zoom ${(+state.zoom).toFixed(2)} | rot ${state.rotation}° flipH ${state.flipH} flipV ${state.flipV}`;
  updateStatus();
}

function cornersPreviewPx() { return state.corners.map(([x, y]) => [x * el.corrected.width, y * el.corrected.height]); }
function cornersValid() {
  const c = cornersPreviewPx();
  return isConvexQuad(c) && quadArea(c) > el.corrected.width * el.corrected.height * 0.05;
}

/** يجهز (أو يعيد استخدام) لوحة وخريطة تقويم لمنطقة اللعب بدقة معينة. */
function prepareTier(tier, targetSide) {
  const t = nativeTransform();
  const key = `${t.outW}x${t.outH}|${targetSide}|${state.corners.flat().map((v) => v.toFixed(4)).join(',')}`;
  if (tier.key === key) return t;
  const plan = planRoi(state.corners, t.outW, t.outH, targetSide);
  if (!tier.canvas) { tier.canvas = document.createElement('canvas'); tier.ctx = tier.canvas.getContext('2d', { willReadFrequently: true }); }
  tier.canvas.width = plan.canvasW; tier.canvas.height = plan.canvasH;
  tier.plan = plan;
  tier.map = buildRemap(plan.cornersCanvas, plan.canvasW, plan.canvasH, plan.outW, plan.outH);
  tier.img = new ImageData(plan.outW, plan.outH);
  tier.key = key;
  return t;
}

/** يرسم منطقة اللعب فقط من الفيديو ثم يقوّمها. */
function grabTier(tier, targetSide) {
  const t = prepareTier(tier, targetSide);
  const { plan } = tier; const [a, b, c, d, e, f] = t.matrix; const s = plan.scale;
  tier.ctx.setTransform(s * a, s * b, s * c, s * d, s * (e - plan.bx), s * (f - plan.by));
  tier.ctx.drawImage(el.video, 0, 0);
  tier.ctx.setTransform(1, 0, 0, 1, 0, 0);
  const src = tier.ctx.getImageData(0, 0, plan.canvasW, plan.canvasH).data;
  remapRGBA(src, tier.img.data, tier.map);
  return tier.img;
}

// ---------- الحلقة ----------
function loop(now) {
  state.raf = requestAnimationFrame(loop);
  if (!state.stream || el.video.readyState < 2 || !state.vw) return;
  if (now - state.lastPreview >= 33) { // معاينة ≤30 إطار/ث لتوفير البطارية
    state.lastPreview = now;
    const t = nativeTransform(); const s = el.corrected.width / t.outW;
    ctxC.setTransform(...t.matrix.map((v) => v * s));
    ctxC.drawImage(el.video, 0, 0);
    ctxC.setTransform(1, 0, 0, 1, 0, 0);
    drawOverlay();
    state.frames++;
  }
  if (cornersValid() && scheduler.shouldProcess(now)) processFrame(now);
  if (now - state.fpsT >= 1000) {
    const dt = (now - state.fpsT) / 1000;
    state.fps = state.frames / dt; state.procFps = state.procs / dt; state.dutyPct = (state.busyMs / (dt * 1000)) * 100;
    state.frames = 0; state.procs = 0; state.busyMs = 0; state.fpsT = now;
    renderQuality(); renderDiag();
  }
}

function processFrame(now) {
  const t0 = performance.now();
  const img = grabTier(state.mon, MONITOR_SIDE);
  const { w, h } = { w: img.width, h: img.height };
  const m = analyze(img.data, w, h, 2);
  const L = lumaDownsample(img.data, w, h, 1);
  const mo = motion.update(L.data, L.w, L.h);
  state.motion = mo;
  if (mo.global) noteGlobalEvent(now);
  const g = gate.update(mo.changed, now);
  state.stable = g.stable;
  state.illum = estimateIlluminant(img.data);
  m.illumCast = illuminantCast(state.illum);
  state.metrics = m;
  state.issues = assessQuality(m);
  scheduler.setIdle(g.stable && g.heldMs > 4000);
  if (!state.stable || state.rd.count === 0) ctxShow(img);

  // قراءة عالية الدقة مرة عند بداية كل فترة ثبات
  if (state.stable && !state.wasStable) readHighRes(now);
  state.wasStable = state.stable;

  const blocking = state.issues.some((i) => i.level === 'error');
  if (state.needsRevalidation && state.savedForOrientation && g.stable && !blocking) { state.needsRevalidation = false; hideBanner(); }
  state.commandsAllowed = state.savedForOrientation && !state.needsRevalidation && g.stable && !blocking;
  const ms = performance.now() - t0;
  state.procMs = ms; state.busyMs += ms; scheduler.report(ms); state.procs++;
  updateStatus();
}

function readHighRes(now) {
  const t0 = performance.now();
  const side = READ_LEVELS[state.rd.level];
  const img = grabTier(state.rd, side);
  ctxShow(img);
  const ms = performance.now() - t0;
  state.rd.lastMs = ms; state.rd.count++; state.rd.at = now; state.busyMs += ms;
  // دقة تكيفية: إن كانت القراءة بطيئة نخفض المستوى التالي
  if (ms > 120 && state.rd.level < READ_LEVELS.length - 1) { state.rd.level++; state.rd.key = ''; }
  else if (ms < 40 && state.rd.level > 0) { state.rd.level--; state.rd.key = ''; }
}

function ctxShow(img) {
  if (el.rectified.width !== img.width || el.rectified.height !== img.height) { el.rectified.width = img.width; el.rectified.height = img.height; }
  ctxR.putImageData(img, 0, 0);
}

function noteGlobalEvent(now) {
  state.globalEvents = state.globalEvents.filter((t) => now - t < 10000);
  state.globalEvents.push(now);
}

// ---------- المعايرة التلقائية ----------
async function autoCalibrate(manual) {
  if (!state.vw) return;
  const s = suggestOrientation({ vw: state.vw, vh: state.vh, orientation: state.orientation });
  Object.assign(state, { rotation: s.rotation, flipH: s.flipH, flipV: s.flipV });
  onGeometryChanged();
  await new Promise((r) => setTimeout(r, 250)); // انتظار رسم المعاينة بالاتجاه الجديد
  const data = ctxC.getImageData(0, 0, el.corrected.width, el.corrected.height).data;
  const roi = autoPlayArea(data, el.corrected.width, el.corrected.height);
  state.auto = { orientation: s, roi: roi && { confidence: +roi.confidence.toFixed(2), area: +roi.areaFraction.toFixed(2), table: roi.reference.map((v) => +v.toFixed(3)) } };
  if (roi && roi.confidence >= 0.3) state.corners = roi.corners.map((p) => [...p]);
  state.mon.key = ''; state.rd.key = '';
  const okRoi = roi && roi.confidence >= 0.3;
  el.autoInfo.textContent = [
    s.confidence === 'high' ? 'الاتجاه: مقترح تلقائيًا.' : 'الاتجاه: الصورة وصلت مدارة؛ قد تحتاج «تدوير ٩٠°».',
    okRoi ? `منطقة اللعب: اكتُشفت (ثقة ${Math.round(roi.confidence * 100)}٪).` : 'منطقة اللعب: لم تُكتشف بوضوح؛ اسحب النقاط يدويًا.',
    'للتأكد: ضع قطعة الرقم ٤ أو ٥ — يجب أن تظهر مقروءة وغير معكوسة، وقطعة «مشي» سهمها نحو الآيباد تظهر للأعلى. ثم «حفظ المعايرة».',
  ].join(' ');
  if (manual || !state.savedForOrientation) showBanner('معايرة تلقائية جاهزة للمراجعة. تأكد من الرقم ثم اضغط «حفظ المعايرة».');
  updateStatus();
}

// ---------- الزوايا (لمس/سحب) ----------
function drawOverlay() {
  const w = el.overlay.width, h = el.overlay.height;
  ctxO.clearRect(0, 0, w, h);
  const c = cornersPreviewPx();
  const k = w / (el.overlay.clientWidth || w);
  ctxO.lineWidth = 3 * k;
  ctxO.strokeStyle = cornersValid() ? '#3ad29f' : '#ff6b6b';
  ctxO.beginPath(); c.forEach(([x, y], i) => (i ? ctxO.lineTo(x, y) : ctxO.moveTo(x, y))); ctxO.closePath(); ctxO.stroke();
  // تمييز الحافة القريبة من الآيباد (أعلى)
  ctxO.fillStyle = 'rgba(255,255,255,.9)'; ctxO.font = `${13 * k}px sans-serif`; ctxO.textAlign = 'center';
  ctxO.fillText('▲ جهة الآيباد', w / 2, 16 * k);
  const labels = ['١', '٢', '٣', '٤'];
  c.forEach(([x, y], i) => {
    ctxO.fillStyle = i === state.drag ? '#ffb020' : 'rgba(255,176,32,.85)';
    ctxO.beginPath(); ctxO.arc(x, y, 16 * k, 0, Math.PI * 2); ctxO.fill();
    ctxO.fillStyle = '#2a1a00'; ctxO.font = `${14 * k}px sans-serif`; ctxO.textBaseline = 'middle';
    ctxO.fillText(labels[i], x, y); ctxO.textBaseline = 'alphabetic';
  });
}

function setupPointer() {
  const toNorm = (e) => {
    const r = el.overlay.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };
  el.overlay.addEventListener('pointerdown', (e) => {
    const r = el.overlay.getBoundingClientRect();
    const [nx, ny] = toNorm(e);
    let best = -1, bd = Infinity;
    state.corners.forEach(([x, y], i) => { const d = Math.hypot((x - nx) * r.width, (y - ny) * r.height); if (d < bd) { bd = d; best = i; } });
    if (bd < 60) { state.drag = best; el.overlay.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  el.overlay.addEventListener('pointermove', (e) => {
    if (state.drag < 0) return;
    state.corners[state.drag] = toNorm(e); state.savedForOrientation = false;
  });
  const end = () => {
    if (state.drag < 0) return;
    state.drag = -1;
    try { state.corners = orderCorners(cornersPreviewPx()).map(([x, y]) => [x / el.corrected.width, y / el.corrected.height]); } catch { /* اتركها */ }
    state.mon.key = ''; state.rd.key = ''; motion.reset(); updateStatus();
  };
  el.overlay.addEventListener('pointerup', end);
  el.overlay.addEventListener('pointercancel', end);
}

// ---------- الحفظ والاستعادة ----------
function deviceKey() {
  return makeDeviceKey({ cameraId: state.cameraId, screenW: screen.width, screenH: screen.height, dpr: devicePixelRatio });
}

function saveCalibration() {
  if (!cornersValid()) return;
  const cal = {
    version: CALIBRATION_VERSION, orientation: state.orientation, rotation: state.rotation,
    flipH: state.flipH, flipV: state.flipV, corners: state.corners.map(([x, y]) => [round4(x), round4(y)]),
    videoW: state.vw, videoH: state.vh, zoom: round4(state.zoom || 1), cameraId: state.cameraId, cameraLabel: state.cameraLabel,
    auto: state.auto, createdAt: Date.now(), appVersion: APP_VERSION,
  };
  store.save(deviceKey(), cal);
  state.savedForOrientation = true; state.needsRevalidation = false; hideBanner();
  updateStatus();
}

function loadCalibrationForOrientation(announce) {
  if (!state.cameraId) return null;
  const cal = store.load(deviceKey(), state.orientation);
  if (cal && (!state.vw || isCompatible(cal, state.vw, state.vh))) {
    Object.assign(state, { rotation: cal.rotation, flipH: cal.flipH, flipV: cal.flipV });
    onGeometryChanged();
    state.corners = cal.corners.map((p) => [...p]);
    state.savedForOrientation = true;
    if (announce) showBanner('تغيّر الاتجاه — حُمّلت المعايرة المحفوظة. ننتظر ثبات الصورة قبل السماح بالأوامر.');
    updateStatus();
    return cal;
  }
  state.savedForOrientation = false;
  if (announce && state.stream) { showBanner(`لا توجد معايرة للوضع ${state.orientation === 'portrait' ? 'الطولي' : 'العرضي'}. نجري معايرة تلقائية الآن…`); setTimeout(() => autoCalibrate(false), 500); }
  updateStatus();
  return null;
}

function handleOrientationChange(next) {
  state.orientation = next;
  state.commandsAllowed = false; state.needsRevalidation = true; gate.reset(); motion.reset();
  loadCalibrationForOrientation(true);
}

// ---------- العرض ----------
function updateStatus() {
  el.btnSave.disabled = !state.stream || !cornersValid();
  if (!state.stream) return;
  if (state.commandsAllowed) setStatus('ok', 'جاهز — الأوامر مسموحة');
  else if (!state.savedForOrientation) setStatus('warn', 'تحتاج تأكيد المعايرة');
  else if (!state.stable) setStatus('warn', 'بانتظار ثبات منطقة اللعب');
  else setStatus('warn', 'تحقق من الجودة');
}

function renderQuality() {
  const items = state.issues.length ? state.issues : [{ level: 'ok', msg: 'الإضاءة والوضوح مقبولان مبدئيًا.' }];
  const mo = state.motion;
  const extra = [
    { level: state.stable ? 'ok' : 'info', msg: state.stable ? 'منطقة اللعب ثابتة.' : `حركة داخل منطقة اللعب (${mo && Number.isFinite(mo.changed) ? mo.changed : '…'} خلية).` },
    { level: state.savedForOrientation ? 'ok' : 'warn', msg: state.savedForOrientation ? 'المعايرة محفوظة لهذا الاتجاه.' : 'المعايرة غير محفوظة لهذا الاتجاه.' },
  ];
  if (state.globalEvents.length >= 3) extra.push({ level: 'warn', msg: 'الصورة كلها تتحرك أو تتغير. أوقف ميزة «المنتصف» (Center Stage) من مركز التحكم، وتجنب تغير الإضاءة.' });
  el.quality.innerHTML = [...items, ...extra].map((i) => `<li class="${i.level}">${escapeHtml(i.msg)}</li>`).join('');
}

function diagData() {
  const m = state.metrics, mo = state.motion, mp = state.mon.plan, rp = state.rd.plan;
  return {
    appVersion: APP_VERSION, time: new Date().toISOString(), userAgent: navigator.userAgent,
    standalone: cameraSupport().standalone, secureContext: isSecureContext, orientation: state.orientation,
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`, viewport: `${innerWidth}×${innerHeight}`,
    camera: state.cameraLabel, trackSettings: state.info?.settings ?? null, trackCapabilities: state.info?.capabilities ?? null,
    video: `${state.vw}×${state.vh}`, zoom: state.zoom, wbLocked: state.wbLocked,
    transform: { rotation: state.rotation, flipH: state.flipH, flipV: state.flipV },
    corners: state.corners.map(([x, y]) => [round4(x), round4(y)]), auto: state.auto,
    roiNative: mp ? `${mp.nativeRoiW}×${mp.nativeRoiH}` : null,
    monitor: mp ? `${mp.outW}×${mp.outH}` : null, read: rp ? `${rp.outW}×${rp.outH}` : null,
    readMs: round1(state.rd.lastMs), reads: state.rd.count,
    previewFps: round1(state.fps), processFps: round1(state.procFps), processMs: round1(state.procMs),
    dutyPct: round1(state.dutyPct), processIntervalMs: Math.round(scheduler.intervalMs),
    metrics: m ? { meanLuma: round1(m.meanLuma), contrast: round1(m.contrast), sharpness: Math.round(m.sharpness), darkPct: round1(m.darkPct), brightPct: round1(m.brightPct), meanRGB: m.meanRGB.map(Math.round) } : null,
    illuminant: state.illum ? { white: state.illum.white.map(Math.round), reliable: state.illum.reliable, cast: m?.illumCast == null ? null : round1(m.illumCast * 100) / 100 } : null,
    motion: mo && Number.isFinite(mo.changed) ? { changedCells: mo.changed, maxDiff: round1(mo.maxDiff), global: mo.global } : null,
    globalEvents10s: state.globalEvents.length,
    stable: state.stable, issues: state.issues.map((i) => i.code),
    calibrationSaved: state.savedForOrientation, commandsAllowed: state.commandsAllowed,
  };
}

function renderDiag() {
  if (el.panelDiag.hidden) return;
  const d = diagData();
  const rows = {
    'الإصدار': d.appVersion, 'الفيديو': d.video, 'التقريب': d.zoom, 'منطقة اللعب (أصلية)': d.roiNative,
    'دقة المراقبة': d.monitor, 'دقة القراءة': d.read, 'زمن القراءة (ms)': d.readMs, 'عدد القراءات': d.reads,
    'FPS معاينة': d.previewFps, 'FPS مراقبة': d.processFps, 'زمن المراقبة (ms)': d.processMs,
    'نسبة انشغال المعالج %': d.dutyPct, 'فاصل المراقبة (ms)': d.processIntervalMs,
    'الحركة': JSON.stringify(d.motion), 'تغيرات شاملة/10ث': d.globalEvents10s, 'ثابت': d.stable,
    'الإضاءة': JSON.stringify(d.illuminant), 'المقاييس': JSON.stringify(d.metrics),
    'المعايرة التلقائية': JSON.stringify(d.auto), 'الاتجاه': d.orientation, 'الكاميرا': d.camera, 'مثبت': d.standalone,
    'الأوامر مسموحة': d.commandsAllowed,
  };
  el.diag.innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

async function copyReport() {
  const text = JSON.stringify(diagData(), null, 2);
  el.reportOut.hidden = false; el.reportOut.readOnly = true; el.reportOut.value = text;
  try { await navigator.clipboard.writeText(text); el.btnReport.textContent = 'نُسخ ✓'; }
  catch { el.reportOut.select(); el.btnReport.textContent = 'انسخه يدويًا'; }
  setTimeout(() => { el.btnReport.textContent = 'نسخ تقرير الاختبار'; }, 2500);
}

function saveSnapshot() {
  // قراءة جديدة بأعلى دقة متاحة لحظة الحفظ
  if (state.stream && cornersValid()) grabTier(state.rd, READ_LEVELS[0]) && ctxShow(state.rd.img);
  el.rectified.toBlob((blob) => { if (blob) downloadBlob(blob, `osmo-sample-${state.orientation}-${Date.now()}.png`); }, 'image/png');
}

// ---------- أدوات ----------
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function setStatus(kind, text) { el.status.className = 'chip' + (kind ? ' ' + kind : ''); el.status.textContent = text; }
function showBanner(t) { el.banner.textContent = t; el.banner.hidden = false; }
function hideBanner() { el.banner.hidden = true; }
function clamp01(v) { return Math.min(1, Math.max(0, v)); }
function round1(v) { return Math.round((v || 0) * 10) / 10; }
function round4(v) { return Math.round(v * 1e4) / 1e4; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeStorage() {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; }
  catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
}
function registerServiceWorker() {
  if ('serviceWorker' in navigator && isSecureContext && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

// للاختبار الآلي فقط
window.__osmoDebug = { state, diagData, autoCalibrate, readHighRes };
