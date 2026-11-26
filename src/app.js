// صفحة اختبار الكاميرا والمعايرة (المرحلة الأولى).
// تربط وحدات الرؤية الصرفة بالمتصفح. لا تُرسل أي صورة خارج الجهاز.
import { orientationTransform, orderCorners, isConvexQuad, quadArea } from './vision/geometry.js';
import { buildRemap, remapRGBA, outputSize, estimateAspect } from './vision/rectify.js';
import { analyze, motionScore, assessQuality, StabilityGate } from './vision/quality.js';
import { AdaptiveScheduler } from './vision/adaptive.js';
import { CalibrationStore, makeDeviceKey, isCompatible, CALIBRATION_VERSION } from './calibration/store.js';
import { getOrientation, onOrientationChange } from './platform/orientation.js';
import { cameraSupport, listCameras, openCamera, trackInfo, stopStream } from './platform/camera.js';
import { exportSettings, importSettings, requestPersistence } from './platform/storage.js';

export const APP_VERSION = 'dev'; // يُختم عند النشر
const WORK_SIDE = 640; // أطول ضلع للصورة المصححة المستخدمة في المعالجة
const DEFAULT_CORNERS = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), banner: $('banner'), video: $('video'), cameraSelect: $('cameraSelect'),
  btnStart: $('btnStart'), btnStop: $('btnStop'), support: $('support'),
  corrected: $('corrected'), overlay: $('overlay'), rectified: $('rectified'), transformInfo: $('transformInfo'),
  quality: $('quality'), btnSave: $('btnSave'), btnDeleteCal: $('btnDeleteCal'),
  btnDiag: $('btnDiag'), panelDiag: $('panelDiag'), diag: $('diag'), btnReport: $('btnReport'),
  btnSnapshot: $('btnSnapshot'), reportOut: $('reportOut'), consent: $('consent'),
  btnRotate: $('btnRotate'), btnFlipH: $('btnFlipH'), btnFlipV: $('btnFlipV'), btnResetCorners: $('btnResetCorners'),
};

const store = new CalibrationStore(safeStorage());
const scheduler = new AdaptiveScheduler();
const gate = new StabilityGate({ threshold: 4, stableMs: 1000 });

const state = {
  stream: null, cameraId: '', cameraLabel: '', info: null,
  rotation: 0, flipH: false, flipV: false, corners: DEFAULT_CORNERS.map((p) => [...p]),
  orientation: getOrientation(), commandsAllowed: false, needsRevalidation: false,
  vw: 0, vh: 0, remap: null, remapKey: '', rectImage: null, prevLuma: null,
  metrics: null, issues: [], motion: null, stable: false,
  fps: 0, procFps: 0, procMs: 0, frames: 0, procs: 0, fpsT: performance.now(),
  drag: -1, savedForOrientation: false, wakeLock: null, raf: 0,
};

const ctxC = el.corrected.getContext('2d', { willReadFrequently: true });
const ctxO = el.overlay.getContext('2d');
const ctxR = el.rectified.getContext('2d');

// ---------- البداية ----------
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
  el.btnSave.onclick = saveCalibration;
  el.btnDeleteCal.onclick = () => { if (state.cameraId) store.remove(deviceKey(), state.orientation); state.savedForOrientation = false; state.commandsAllowed = false; updateStatus(); };
  el.btnDiag.onclick = () => {
    const show = el.panelDiag.hidden; el.panelDiag.hidden = !show; el.btnDiag.setAttribute('aria-pressed', String(show));
  };
  el.btnReport.onclick = copyReport;
  $('btnExport').onclick = async () => {
    const text = exportSettings(localStorage);
    el.reportOut.hidden = false; el.reportOut.readOnly = true; el.reportOut.value = text;
    try { await navigator.clipboard.writeText(text); $('btnExport').textContent = 'نُسخت ✓'; } catch { el.reportOut.select(); }
  };
  $('btnExportFile').onclick = () => {
    const blob = new Blob([exportSettings(localStorage)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `osmo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('importFile').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { const n = importSettings(localStorage, await f.text()); showBanner(`استُعيدت ${n} من الإعدادات والتقدم.`); loadCalibrationForOrientation(false); }
    catch { showBanner('الملف ليس نسخة احتياطية صالحة لهذا التطبيق.'); }
    e.target.value = '';
  };
  $('btnImport').onclick = () => {
    if (el.reportOut.hidden || el.reportOut.readOnly) {
      el.reportOut.hidden = false; el.reportOut.readOnly = false; el.reportOut.value = '';
      el.reportOut.placeholder = 'الصق النسخة الاحتياطية هنا ثم اضغط «استيراد» مرة أخرى';
      el.reportOut.focus(); return;
    }
    try { const n = importSettings(localStorage, el.reportOut.value); $('btnImport').textContent = `استُورد ${n} ✓`; loadCalibrationForOrientation(false); }
    catch (e) { $('btnImport').textContent = 'نسخة غير صالحة'; }
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
    const stream = await openCamera({ deviceId: el.cameraSelect.value || undefined });
    state.stream = stream;
    state.info = trackInfo(stream);
    state.cameraId = state.info?.settings?.deviceId || el.cameraSelect.value || 'default';
    state.cameraLabel = state.info?.label || '';
    el.video.srcObject = stream;
    await el.video.play();
    await refreshCameraList();
    el.btnStart.textContent = 'إعادة التشغيل'; el.btnStop.disabled = false;
    requestWakeLock();
    onVideoResize();
    loadCalibrationForOrientation(false);
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(loop);
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
      cams.map((c) => `<option value="${escapeAttr(c.deviceId)}">${escapeHtml(c.label)}</option>`).join('');
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

// ---------- الهندسة ----------
function onVideoResize() {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!vw || !vh) return;
  if (vw !== state.vw || vh !== state.vh) {
    const hadSize = state.vw > 0;
    state.vw = vw; state.vh = vh;
    if (hadSize) { // تغيرت دقة/اتجاه الفيديو: تحقق من صلاحية المعايرة
      state.commandsAllowed = false; state.needsRevalidation = true; gate.reset();
      loadCalibrationForOrientation(true);
    }
    onGeometryChanged();
  }
}

function currentTransform() {
  const t = orientationTransform(state.vw, state.vh, state);
  const s = WORK_SIDE / Math.max(t.outW, t.outH);
  return { w: Math.round(t.outW * s), h: Math.round(t.outH * s), m: t.matrix.map((v) => v * s) };
}

function onGeometryChanged() {
  if (!state.vw) return;
  const t = currentTransform();
  if (el.corrected.width !== t.w || el.corrected.height !== t.h) {
    el.corrected.width = el.overlay.width = t.w;
    el.corrected.height = el.overlay.height = t.h;
  }
  state.remapKey = ''; // يفرض إعادة بناء الخريطة
  state.savedForOrientation = false;
  el.transformInfo.textContent = `video ${state.vw}×${state.vh} → ${t.w}×${t.h} | rot ${state.rotation}° flipH ${state.flipH} flipV ${state.flipV}`;
  updateStatus();
}

function cornersPx() {
  return state.corners.map(([x, y]) => [x * el.corrected.width, y * el.corrected.height]);
}

function cornersValid() {
  const c = cornersPx();
  const minArea = el.corrected.width * el.corrected.height * 0.05;
  return isConvexQuad(c) && quadArea(c) > minArea;
}

function ensureRemap() {
  const c = cornersPx();
  const aspect = estimateAspect(c);
  const { w, h } = outputSize(aspect, scheduler.maxSide);
  const key = `${el.corrected.width}x${el.corrected.height}|${w}x${h}|${c.flat().map((v) => v.toFixed(1)).join(',')}`;
  if (key === state.remapKey) return true;
  if (!cornersValid()) { state.remap = null; return false; }
  state.remap = buildRemap(c, el.corrected.width, el.corrected.height, w, h);
  el.rectified.width = w; el.rectified.height = h;
  state.rectImage = ctxR.createImageData(w, h);
  state.prevLuma = null; state.remapKey = key;
  return true;
}

// ---------- الحلقة ----------
function loop(now) {
  state.raf = requestAnimationFrame(loop);
  if (!state.stream || el.video.readyState < 2 || !state.vw) return;
  const t = currentTransform();
  ctxC.setTransform(...t.m);
  ctxC.drawImage(el.video, 0, 0);
  ctxC.setTransform(1, 0, 0, 1, 0, 0);
  drawOverlay();
  state.frames++;

  if (scheduler.shouldProcess(now)) processFrame(now);

  if (now - state.fpsT >= 1000) {
    const dt = (now - state.fpsT) / 1000;
    state.fps = state.frames / dt; state.procFps = state.procs / dt;
    state.frames = 0; state.procs = 0; state.fpsT = now;
    renderQuality(); renderDiag();
  }
}

function processFrame(now) {
  const t0 = performance.now();
  if (!ensureRemap()) { state.issues = [{ code: 'corners', level: 'error', msg: 'الزوايا غير صالحة. اجعل منطقة اللعب رباعيًا واضحًا.' }]; return; }
  const src = ctxC.getImageData(0, 0, el.corrected.width, el.corrected.height).data;
  remapRGBA(src, state.rectImage.data, state.remap);
  ctxR.putImageData(state.rectImage, 0, 0);
  const m = analyze(state.rectImage.data, el.rectified.width, el.rectified.height, 2);
  state.motion = motionScore(state.prevLuma, m.luma.data);
  state.prevLuma = m.luma.data;
  const g = gate.update(state.motion, now);
  state.stable = g.stable;
  state.metrics = m;
  state.issues = assessQuality(m);
  scheduler.setIdle(g.stable && g.heldMs > 5000);

  // إعادة السماح بالأوامر بعد تغيّر الاتجاه فقط عند: معايرة محفوظة + مشهد مستقر + لا أخطاء جودة
  const blocking = state.issues.some((i) => i.level === 'error');
  if (state.needsRevalidation && state.savedForOrientation && g.stable && !blocking) {
    state.needsRevalidation = false; hideBanner();
  }
  state.commandsAllowed = state.savedForOrientation && !state.needsRevalidation && g.stable && !blocking;
  const ms = performance.now() - t0;
  state.procMs = ms; scheduler.report(ms); state.procs++;
  updateStatus();
}

// ---------- الزوايا (لمس/سحب) ----------
function drawOverlay() {
  const w = el.overlay.width, h = el.overlay.height;
  ctxO.clearRect(0, 0, w, h);
  const c = cornersPx();
  const k = w / (el.overlay.clientWidth || w);
  ctxO.lineWidth = 3 * k;
  ctxO.strokeStyle = cornersValid() ? '#3ad29f' : '#ff6b6b';
  ctxO.beginPath(); c.forEach(([x, y], i) => (i ? ctxO.lineTo(x, y) : ctxO.moveTo(x, y))); ctxO.closePath(); ctxO.stroke();
  const labels = ['١', '٢', '٣', '٤'];
  c.forEach(([x, y], i) => {
    ctxO.fillStyle = i === state.drag ? '#ffb020' : 'rgba(255,176,32,.85)';
    ctxO.beginPath(); ctxO.arc(x, y, 16 * k, 0, Math.PI * 2); ctxO.fill();
    ctxO.fillStyle = '#2a1a00'; ctxO.font = `${14 * k}px sans-serif`; ctxO.textAlign = 'center'; ctxO.textBaseline = 'middle';
    ctxO.fillText(labels[i], x, y);
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
    state.corners.forEach(([x, y], i) => {
      const d = Math.hypot((x - nx) * r.width, (y - ny) * r.height);
      if (d < bd) { bd = d; best = i; }
    });
    if (bd < 60) { state.drag = best; el.overlay.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  el.overlay.addEventListener('pointermove', (e) => {
    if (state.drag < 0) return;
    state.corners[state.drag] = toNorm(e); state.remapKey = ''; state.savedForOrientation = false;
  });
  const end = () => {
    if (state.drag < 0) return;
    state.drag = -1;
    const px = cornersPx();
    // إعادة ترتيب الزوايا تلقائيًا تصلح الرباعي المتقاطع إذا سحب المستخدم نقطة فوق أخرى
    try {
      const ordered = orderCorners(px);
      state.corners = ordered.map(([x, y]) => [x / el.corrected.width, y / el.corrected.height]);
    } catch { /* اترك كما هي */ }
    state.remapKey = ''; updateStatus();
  };
  el.overlay.addEventListener('pointerup', end);
  el.overlay.addEventListener('pointercancel', end);
}

// ---------- المعايرة ----------
function deviceKey() {
  return makeDeviceKey({ cameraId: state.cameraId, screenW: screen.width, screenH: screen.height, dpr: devicePixelRatio });
}

function saveCalibration() {
  if (!cornersValid()) return;
  const cal = {
    version: CALIBRATION_VERSION, orientation: state.orientation, rotation: state.rotation,
    flipH: state.flipH, flipV: state.flipV, corners: state.corners.map(([x, y]) => [round4(x), round4(y)]),
    videoW: state.vw, videoH: state.vh, cameraId: state.cameraId, cameraLabel: state.cameraLabel,
    createdAt: Date.now(), appVersion: APP_VERSION,
  };
  store.save(deviceKey(), cal);
  state.savedForOrientation = true; state.needsRevalidation = false; hideBanner();
  updateStatus();
}

function loadCalibrationForOrientation(announce) {
  if (!state.cameraId) return;
  const cal = store.load(deviceKey(), state.orientation);
  if (cal && (!state.vw || isCompatible(cal, state.vw, state.vh))) {
    Object.assign(state, { rotation: cal.rotation, flipH: cal.flipH, flipV: cal.flipV, corners: cal.corners.map((p) => [...p]) });
    onGeometryChanged();
    state.savedForOrientation = true;
    if (announce) showBanner('تغيّر الاتجاه — حُمّلت المعايرة المحفوظة. ننتظر ثبات الصورة قبل السماح بالأوامر.');
  } else {
    state.savedForOrientation = false;
    if (announce || state.stream) showBanner(`لا توجد معايرة محفوظة للوضع ${state.orientation === 'portrait' ? 'الطولي' : 'العرضي'}. أكمل الخطوات ثم اضغط «حفظ المعايرة».`);
  }
  updateStatus();
}

function handleOrientationChange(next) {
  state.orientation = next;
  state.commandsAllowed = false; state.needsRevalidation = true; gate.reset();
  loadCalibrationForOrientation(true);
}

// ---------- العرض ----------
function updateStatus() {
  el.btnSave.disabled = !state.stream || !cornersValid();
  if (!state.stream) return;
  if (state.commandsAllowed) setStatus('ok', 'جاهز — الأوامر مسموحة');
  else if (!state.savedForOrientation) setStatus('warn', 'تحتاج معايرة');
  else if (!state.stable) setStatus('warn', 'بانتظار ثبات الصورة');
  else setStatus('warn', 'تحقق من الجودة');
}

function renderQuality() {
  const items = state.issues.length ? state.issues : [{ level: 'ok', msg: 'الإضاءة والوضوح مقبولان مبدئيًا.' }];
  const extra = [
    { level: state.stable ? 'ok' : 'info', msg: state.stable ? 'الصورة ثابتة.' : 'توجد حركة في منطقة اللعب.' },
    { level: state.savedForOrientation ? 'ok' : 'warn', msg: state.savedForOrientation ? 'المعايرة محفوظة لهذا الاتجاه.' : 'المعايرة غير محفوظة لهذا الاتجاه.' },
  ];
  el.quality.innerHTML = [...items, ...extra].map((i) => `<li class="${i.level}">${escapeHtml(i.msg)}</li>`).join('');
}

function diagData() {
  const m = state.metrics;
  return {
    appVersion: APP_VERSION,
    time: new Date().toISOString(),
    userAgent: navigator.userAgent,
    standalone: cameraSupport().standalone,
    secureContext: isSecureContext,
    orientation: state.orientation,
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
    viewport: `${innerWidth}×${innerHeight}`,
    camera: state.cameraLabel,
    trackSettings: state.info?.settings ?? null,
    trackCapabilities: state.info?.capabilities ?? null,
    video: `${state.vw}×${state.vh}`,
    transform: { rotation: state.rotation, flipH: state.flipH, flipV: state.flipV },
    corners: state.corners.map(([x, y]) => [round4(x), round4(y)]),
    rectified: `${el.rectified.width}×${el.rectified.height}`,
    renderFps: round1(state.fps), processFps: round1(state.procFps), processMs: round1(state.procMs),
    processIntervalMs: Math.round(scheduler.intervalMs), qualityLevel: scheduler.level,
    metrics: m ? { meanLuma: round1(m.meanLuma), contrast: round1(m.contrast), sharpness: Math.round(m.sharpness), darkPct: round1(m.darkPct), brightPct: round1(m.brightPct), meanRGB: m.meanRGB.map(Math.round) } : null,
    motion: state.motion === Infinity ? null : round1(state.motion ?? 0),
    stable: state.stable, issues: state.issues.map((i) => i.code),
    calibrationSaved: state.savedForOrientation, commandsAllowed: state.commandsAllowed,
  };
}

function renderDiag() {
  if (el.panelDiag.hidden) return;
  const d = diagData();
  const rows = {
    'الإصدار': d.appVersion, 'FPS عرض': d.renderFps, 'FPS معالجة': d.processFps, 'زمن المعالجة (ms)': d.processMs,
    'فاصل المعالجة (ms)': d.processIntervalMs, 'مستوى الجودة': d.qualityLevel, 'الفيديو': d.video,
    'المخرج': d.rectified, 'الاتجاه': d.orientation, 'الكاميرا': d.camera, 'مثبت': d.standalone,
    'الحركة': d.motion, 'ثابت': d.stable, 'الأوامر مسموحة': d.commandsAllowed,
    'المقاييس': JSON.stringify(d.metrics), 'إعدادات المسار': JSON.stringify(d.trackSettings),
  };
  el.diag.innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

async function copyReport() {
  const text = JSON.stringify(diagData(), null, 2);
  el.reportOut.hidden = false; el.reportOut.value = text;
  try { await navigator.clipboard.writeText(text); el.btnReport.textContent = 'نُسخ ✓'; }
  catch { el.reportOut.select(); el.btnReport.textContent = 'انسخه يدويًا'; }
  setTimeout(() => { el.btnReport.textContent = 'نسخ تقرير الاختبار'; }, 2500);
}

function saveSnapshot() {
  el.rectified.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `osmo-sample-${state.orientation}-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ---------- أدوات ----------
function setStatus(kind, text) { el.status.className = 'chip' + (kind ? ' ' + kind : ''); el.status.textContent = text; }
function showBanner(t) { el.banner.textContent = t; el.banner.hidden = false; }
function hideBanner() { el.banner.hidden = true; }
function clamp01(v) { return Math.min(1, Math.max(0, v)); }
function round1(v) { return Math.round(v * 10) / 10; }
function round4(v) { return Math.round(v * 1e4) / 1e4; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
function safeStorage() {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; }
  catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
}
function registerServiceWorker() {
  if ('serviceWorker' in navigator && isSecureContext && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// للاختبار الآلي فقط
window.__osmoDebug = { state, diagData };
