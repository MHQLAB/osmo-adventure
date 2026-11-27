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
import { CellMotion, FlickerMask } from './vision/motion.js';
import { estimateIlluminant, illuminantCast } from './vision/illuminant.js';
import { autoPlayArea } from './vision/roi.js';
import { suggestOrientation } from './vision/autoorient.js';
import { CalibrationStore, makeDeviceKey, isCompatible, CALIBRATION_VERSION } from './calibration/store.js';
import { getOrientation, onOrientationChange } from './platform/orientation.js';
import { cameraSupport, listCameras, openCamera, trackInfo, stopStream, applyTrackConstraint } from './platform/camera.js';
import { exportSettings, importSettings, requestPersistence } from './platform/storage.js';
import { FrameHealth, RecoveryPolicy } from './platform/framehealth.js';
import { sanitize, sanitizeBackup } from './platform/privacy.js';
import { recognize } from './recognition/recognize.js';
import { buildProgram, stepsToText, parseExpected, compareProgram, REASON_AR } from './recognition/program.js';
import { glyphBitmap, dice } from './recognition/digits.js';
import { BUILTIN_DIGIT_TEMPLATES } from './recognition/digit-templates.js';
import { runProgram } from './engine/robot.js';
import { createZip } from './ui/zip.js';
import { STEPS, evaluateAttempt, summarize } from './ui/guided.js';
import { stepArt } from './ui/pieceArt.js';
import { LABEL_COLORS } from './recognition/pixels.js';

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
  btnZoom: $('btnZoom'), btnWb: $('btnWb'), btnZoomSweep: $('btnZoomSweep'), btnSnapshotRaw: $('btnSnapshotRaw'), consentText: $('consentText'),
  rawCanvas: $('rawCanvas'), corrMini: $('corrMini'), cropMini: $('cropMini'),
  recogCanvas: $('recogCanvas'), recogStatus: $('recogStatus'), recogProgram: $('recogProgram'), recogList: $('recogList'),
  expectedInput: $('expectedInput'), btnCompare: $('btnCompare'), btnResetStats: $('btnResetStats'), recogStats: $('recogStats'),
  btnRun: $('btnRun'), robotCanvas: $('robotCanvas'), btnForgetDigits: $('btnForgetDigits'),
  candGallery: $('candGallery'), guidedSet: $('guidedSet'), guidedArt: $('guidedArt'), guidedTitle: $('guidedTitle'), guidedText: $('guidedText'),
  guidedExpected: $('guidedExpected'), guidedResult: $('guidedResult'), guidedSummary: $('guidedSummary'),
  packDialog: $('packDialog'), packPreview: $('packPreview'), packImages: $('packImages'), packRaw: $('packRaw'),
};
const GUIDED_KEY = 'osmo.guided.v1';

const store = new CalibrationStore(safeStorage());
const scheduler = new AdaptiveScheduler({ budgetMs: 8 });
const gate = new StabilityGate({ threshold: 0, stableMs: 800 });
const motion = new CellMotion({ cols: 16, rows: 9, cellThreshold: 10 });
const flicker = new FlickerMask({ cells: 16 * 9, window: 45, ratio: 0.6 });
const health = new FrameHealth();
const recovery = new RecoveryPolicy();
const STATS_KEY = 'osmo.recog.stats.v1', DIGITS_KEY = 'osmo.digits.v1';

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
  frame: { status: 'starting', valid: false, lastVideoTime: -1, rvfc: false, events: [] }, recovering: false, gaveUp: false,
  monMsHist: [], readMsHist: [], lastReRead: 0, consentMode: 'rect',
  recog: { result: null, program: null, prevText: '', accepted: null, ms: 0, msHist: [], reads: 0, okReads: 0, robot: null, input: null, view: 'overlay', runsT: [] },
  guided: { idx: 0, readsAtStart: 0, okAtStart: 0 },
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
    const text = JSON.stringify(sanitizeBackup(JSON.parse(exportSettings(localStorage))), null, 1);
    el.reportOut.hidden = false; el.reportOut.readOnly = true; el.reportOut.value = text;
    try { await navigator.clipboard.writeText(text); $('btnExport').textContent = 'نُسخت ✓'; } catch { el.reportOut.select(); }
  };
  $('btnExportFile').onclick = () => downloadBlob(new Blob([JSON.stringify(sanitizeBackup(JSON.parse(exportSettings(localStorage))), null, 1)], { type: 'application/json' }), `osmo-backup-${new Date().toISOString().slice(0, 10)}.json`);
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
  el.btnSnapshot.onclick = () => { state.consentMode = 'rect'; el.consentText.textContent = 'سيتم حفظ صورة واحدة لمنطقة اللعب على هذا الجهاز فقط. لا تُرسل إلى أي مكان. هل توافق؟'; el.consent.showModal(); };
  el.btnSnapshotRaw.onclick = () => { state.consentMode = 'raw'; el.consentText.textContent = 'سيتم حفظ صورة الكاميرا الخام كاملة (قد تظهر فيها الغرفة) على هذا الجهاز فقط، لتحليل الانعكاسات. هل توافق؟'; el.consent.showModal(); };
  el.consent.addEventListener('close', () => { if (el.consent.returnValue === 'yes') (state.consentMode === 'raw' ? saveRawSnapshot : saveSnapshot)(); });
  el.btnZoomSweep.onclick = zoomSweep;
  el.btnCompare.onclick = compareWithExpected;
  el.btnResetStats.onclick = () => { try { localStorage.removeItem(STATS_KEY); } catch { /* */ } renderStats(); };
  el.btnRun.onclick = runRobot;
  el.btnForgetDigits.onclick = () => { try { localStorage.removeItem(DIGITS_KEY); } catch { /* */ } el.recogStatus.textContent = 'مُسحت الأرقام المتعلَّمة.'; };
  document.querySelectorAll('.teach').forEach((b) => { b.onclick = () => teachDigit(b.dataset.digit); });
  document.querySelectorAll('.viewbtn').forEach((b) => { b.onclick = () => { state.recog.view = b.dataset.view; document.querySelectorAll('.viewbtn').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (state.recog.input) renderRecognition(state.recog.input); }; });
  $('btnGuidedCapture').onclick = guidedCapture;
  $('btnGuidedRetry').onclick = () => { saveGuided(loadGuided().filter((r) => !(r.step === STEPS[state.guided.idx].id && r.set === el.guidedSet.value))); showGuided(); };
  $('btnGuidedNext').onclick = () => { state.guided.idx = Math.min(STEPS.length - 1, state.guided.idx + 1); showGuided(); };
  $('btnGuidedPrev').onclick = () => { state.guided.idx = Math.max(0, state.guided.idx - 1); showGuided(); };
  el.guidedSet.onchange = showGuided;
  $('btnExportPack').onclick = openPackDialog;
  el.packDialog.addEventListener('close', () => { if (el.packDialog.returnValue === 'yes') exportPack(); });
  showGuided();
  renderStats();
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
    el.btnZoom.disabled = !state.info?.capabilities?.zoom; el.btnZoomSweep.disabled = el.btnZoom.disabled;
    el.btnWb.disabled = !(state.info?.capabilities?.whiteBalanceMode || []).includes?.('manual');
    el.video.srcObject = stream;
    health.reset(); state.gaveUp = false;
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => noteFrameEvent('track-ended'));
    track.addEventListener('mute', () => noteFrameEvent('track-muted'));
    track.addEventListener('unmute', () => noteFrameEvent('track-unmuted'));
    await el.video.play();
    watchFrames();
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

// ---------- صحة الإطارات والاستعادة ----------
function watchFrames() {
  const v = el.video;
  if (typeof v.requestVideoFrameCallback === 'function') {
    state.frame.rvfc = true;
    const cb = (now) => { if (!state.stream || v.srcObject !== state.stream) return; health.frameArrived(performance.now()); v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
}

function noteFrameEvent(kind) {
  state.frame.events.push({ kind, t: Math.round(performance.now()) });
  if (state.frame.events.length > 20) state.frame.events.shift();
}

async function recoverCamera(reason) {
  if (state.recovering || state.gaveUp) return;
  const step = recovery.next(performance.now());
  noteFrameEvent(`recover:${reason}:${step.action}`);
  if (step.action === 'give-up') {
    state.gaveUp = true;
    showBanner('الكاميرا لا تعطي صورة صالحة. تأكد أن العاكس ويد الطفل لا يغطيان الكاميرا، ثم اضغط «إعادة التشغيل».');
    setStatus('err', 'توقفت الكاميرا');
    return;
  }
  state.recovering = true;
  setStatus('warn', 'نستعيد الكاميرا…');
  await new Promise((r) => setTimeout(r, step.delayMs));
  try {
    // المحاولة الأولى خفيفة: استئناف الفيديو؛ ثم إعادة فتح الكاميرا
    if (step.attempt === 1 && state.stream && state.stream.getVideoTracks()[0]?.readyState === 'live') { await el.video.play(); }
    else await startCamera();
  } catch { /* تُعالج في الدورة التالية */ }
  state.recovering = false;
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
  if (tier === state.mon) { motion.reset(); flicker.reset(); gate.reset(); }
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
  if (!state.frame.rvfc && el.video.currentTime !== state.frame.lastVideoTime) { state.frame.lastVideoTime = el.video.currentTime; health.frameArrived(performance.now()); }
  if (now - state.lastPreview >= 33) { // معاينة ≤30 إطار/ث لتوفير البطارية
    state.lastPreview = now;
    if (!el.panelDiag.hidden) drawMiniViews();
    const t = nativeTransform(); const s = el.corrected.width / t.outW;
    ctxC.setTransform(...t.matrix.map((v) => v * s));
    ctxC.drawImage(el.video, 0, 0);
    ctxC.setTransform(1, 0, 0, 1, 0, 0);
    drawOverlay();
    state.frames++;
  }
  if (cornersValid() && scheduler.shouldProcess(now)) processFrame(now);
  // إعادة قراءة دورية أثناء الثبات لتأكيد البرنامج بقراءتين متطابقتين
  if (state.stable && state.frame.valid && now - state.lastReRead > 1500) { state.lastReRead = now; readHighRes(now); }
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
  // صحة الإطار أولًا: الإطار الأسود/المتجمد لا يدخل في الحركة ولا الإضاءة ولا المعايرة ولا التعرف
  const track = state.stream?.getVideoTracks?.()[0];
  const fh = health.update({ now: performance.now(), meanLuma: m.meanLuma, contrast: m.contrast, trackState: track?.readyState, muted: track?.muted });
  state.frame.status = fh.status; state.frame.valid = fh.valid;
  if (!fh.valid) {
    state.stable = false; state.commandsAllowed = false; gate.reset(); motion.reset();
    if (fh.status === 'black' || fh.status === 'frozen' || fh.status === 'ended') recoverCamera(fh.status);
    const ms = performance.now() - t0; state.busyMs += ms; state.procs++;
    setStatus('warn', fh.status === 'muted' ? 'الكاميرا متوقفة مؤقتًا من النظام' : fh.status === 'starting' ? 'بانتظار أول إطار…' : `إطار غير صالح (${fh.status})`);
    return;
  }
  if (recovery.attempts.length && fh.valid) recovery.succeeded();
  const L = lumaDownsample(img.data, w, h, 1);
  const mo = motion.update(L.data, L.w, L.h);
  // الخلايا المتذبذبة باستمرار (انعكاس شاشة/وميض) تُستبعد من قرار الثبات
  if (mo.flags) mo.changedAfterMask = flicker.update(mo.flags);
  state.motion = mo;
  if (mo.global) noteGlobalEvent(now);
  const g = gate.update(mo.flags ? mo.changedAfterMask : mo.changed, now);
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
  pushHist(state.monMsHist, ms);
  updateStatus();
}

function pushHist(arr, v, n = 60) { arr.push(v); if (arr.length > n) arr.shift(); }
function stats(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return { avg: round1(arr.reduce((a, b) => a + b, 0) / arr.length), p95: round1(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), n: arr.length };
}

function readHighRes(now) {
  const t0 = performance.now();
  const side = READ_LEVELS[state.rd.level];
  const img = grabTier(state.rd, side);
  ctxShow(img);
  const ms = performance.now() - t0;
  state.rd.lastMs = ms; state.rd.count++; state.rd.at = now; state.busyMs += ms;
  pushHist(state.readMsHist, ms);
  // التعرف فقط عند صلاحية الإطار وثبات المنطقة (لا معالجة مكلفة أثناء تحريك القطع)، وزمنه يُحسب في الانشغال
  if (state.frame.valid && state.stable) { const r0 = performance.now(); runRecognition(img); state.busyMs += performance.now() - r0; }
  // دقة تكيفية: إن كانت القراءة بطيئة نخفض المستوى التالي
  if (ms > 120 && state.rd.level < READ_LEVELS.length - 1) { state.rd.level++; state.rd.key = ''; }
  else if (ms < 40 && state.rd.level > 0) { state.rd.level--; state.rd.key = ''; }
}

function ctxShow(img) {
  if (el.rectified.width !== img.width || el.rectified.height !== img.height) { el.rectified.width = img.width; el.rectified.height = img.height; }
  ctxR.putImageData(img, 0, 0);
}

function noteGlobalEvent(now) {
  pruneGlobal(now);
  state.globalEvents.push(now);
}
// إصلاح: كان العدد يُحسب دون حذف الأحداث القديمة ما لم يقع حدث جديد، فيبقى «16 حدثًا» قديمًا في التقرير
function pruneGlobal(now = performance.now()) { state.globalEvents = state.globalEvents.filter((t) => now - t < 10000); }

// ---------- المعايرة التلقائية ----------
async function autoCalibrate(manual) {
  if (!state.vw) return;
  const s = suggestOrientation({ vw: state.vw, vh: state.vh, orientation: state.orientation });
  Object.assign(state, { rotation: s.rotation, flipH: s.flipH, flipV: s.flipV });
  onGeometryChanged();
  // انتظار إطارات صالحة فعلًا (فشل v0.2: كانت المعايرة تقرأ المعاينة قبل وصول أول إطار، أي صورة سوداء)
  let roi = null, tries = 0, validFrames = 0;
  const found = [];
  for (; tries < 12 && found.length < 3; tries++) {
    await new Promise((r) => setTimeout(r, 250));
    const data = ctxC.getImageData(0, 0, el.corrected.width, el.corrected.height).data;
    const m = analyze(data, el.corrected.width, el.corrected.height, 4);
    if (m.meanLuma < 15 || m.contrast < 4) continue; // إطار أسود/فارغ
    validFrames++;
    const r = autoPlayArea(data, el.corrected.width, el.corrected.height);
    if (r) found.push(r);
  }
  if (found.length) {
    // وسيط الزوايا عبر عدة إطارات لتقليل أثر يد عابرة أو ضوضاء
    const med = (k, i) => { const v = found.map((f) => f.corners[k][i]).sort((a, b) => a - b); return v[v.length >> 1]; };
    roi = { ...found[found.length - 1], corners: [0, 1, 2, 3].map((k) => [med(k, 0), med(k, 1)]), confidence: Math.min(...found.map((f) => f.confidence)) };
  }
  state.auto = { orientation: s, framesTried: tries, validFrames, roi: roi && { confidence: +roi.confidence.toFixed(2), area: +roi.areaFraction.toFixed(2), fallback: roi.fallback, darkSides: roi.darkSides } };
  if (roi && roi.confidence >= 0.3) state.corners = roi.corners.map((p) => [...p]);
  state.mon.key = ''; state.rd.key = '';
  const okRoi = roi && roi.confidence >= 0.3;
  el.autoInfo.textContent = [
    s.confidence === 'high' ? 'الاتجاه: مقترح تلقائيًا.' : 'الاتجاه: الصورة وصلت مدارة؛ قد تحتاج «تدوير ٩٠°».',
    okRoi ? `منطقة اللعب: اكتُشفت (ثقة ${Math.round(roi.confidence * 100)}٪).` : validFrames ? 'منطقة اللعب: لم تُكتشف بوضوح؛ اسحب النقاط يدويًا.' : 'لم تصل إطارات صالحة من الكاميرا بعد؛ أعد المحاولة.',
    orientationHint(roi),
    'للتأكد: ضع قطعة الرقم ٤ أو ٥ — يجب أن تظهر مقروءة وغير معكوسة، وقطعة «مشي» سهمها نحو الآيباد تظهر للأعلى. ثم «حفظ المعايرة».',
  ].join(' ');
  if (manual || !state.savedForOrientation) showBanner('معايرة تلقائية جاهزة للمراجعة. تأكد من الرقم ثم اضغط «حفظ المعايرة».');
  updateStatus();
}

/** دليل مساعد: جهة القاعدة/الآيباد معتمة غالبًا ويجب أن تكون أعلى الصورة. */
function orientationHint(roi) {
  const d = roi?.darkSides; if (!d) return '';
  const [side, v] = Object.entries(d).sort((a, b) => b[1] - a[1])[0];
  if (v < 0.4 || side === 'top') return '';
  const ar = { bottom: 'الأسفل', left: 'اليسار', right: 'اليمين' }[side];
  return `تنبيه: الحافة المعتمة (غالبًا جهة الآيباد) تظهر في ${ar}؛ قد تحتاج «تدوير ٩٠°».`;
}

// ---------- التعرف على القطع ----------
function learnedDigits() { try { return JSON.parse(localStorage.getItem(DIGITS_KEY) || '{}'); } catch { return {}; } }

function runRecognition(img) {
  const t0 = performance.now();
  const gains = state.illum?.reliable ? state.illum.gains : undefined;
  const res = recognize(img.data, img.width, img.height, { gains, learnedDigits: learnedDigits(), debug: true });
  state.recog.input = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  state.recog.runsT.push(performance.now()); state.recog.runsT = state.recog.runsT.filter((t) => performance.now() - t < 10000);
  const prog = buildProgram(res);
  if (!state.stable) prog.reasons = [...new Set([...prog.reasons, 'unstable'])], prog.ok = false;
  const text = stepsToText(prog.steps);
  state.recog.ms = performance.now() - t0; pushHist(state.recog.msHist, state.recog.ms);
  state.recog.reads++; if (prog.ok) state.recog.okReads++;
  // القبول بعد قراءتين متطابقتين متتاليتين
  if (prog.ok && text === state.recog.prevText) state.recog.accepted = { steps: prog.steps, text, at: Date.now() };
  else if (!prog.ok || text !== state.recog.prevText) state.recog.accepted = state.recog.accepted && state.recog.accepted.text === text ? state.recog.accepted : null;
  state.recog.prevText = prog.ok ? text : '';
  state.recog.result = res; state.recog.program = prog;
  renderRecognition(img);
}

const TYPE_AR = { walk: 'مشي', jump: 'قفز', hand: 'يد', rest: 'راحة', repeat: 'تكرار', magic: 'سحر', 'func-star': 'دالة النجمة', 'func-circle': 'دالة الدائرة', 'func-square': 'دالة المربع', function: 'دالة' };
const DIR_AR = { up: '↑', down: '↓', left: '←', right: '→' };
const STATUS_AR = { ok: 'واضحة', uncertain: 'غير مؤكدة', unknown: 'غير معروفة', ghost: 'انعكاس/ظل' };

function renderRecognition(img) {
  const { result: r, program: p } = state.recog;
  if (!r) return;
  const c = el.recogCanvas, ctx = c.getContext('2d');
  if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; }
  if (state.recog.view === 'mask') { ctx.putImageData(maskImage(r, img.width, img.height), 0, 0); renderGallery(img, r); renderRecogText(r, p); return; }
  ctx.putImageData(img, 0, 0);
  if (state.recog.view === 'input') { renderGallery(img, r); renderRecogText(r, p); return; }
  drawRecogOverlay(ctx, img, r, p);
  renderGallery(img, r); renderRecogText(r, p);
}

function maskImage(r, w, h) {
  const out = new ImageData(w, h); const labs = r.debug?.labels;
  if (!labs) return out;
  for (let i = 0; i < labs.length; i++) { const c = LABEL_COLORS[labs[i]]; out.data[i * 4] = c[0]; out.data[i * 4 + 1] = c[1]; out.data[i * 4 + 2] = c[2]; out.data[i * 4 + 3] = 255; }
  return out;
}

/** قص مربع من الصورة الداخلة إلى لوحة صغيرة. */
function cropCanvas(img, cx, cy, half, size = 72) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const src = document.createElement('canvas'); src.width = img.width; src.height = img.height; src.getContext('2d').putImageData(img, 0, 0);
  cv.getContext('2d').drawImage(src, cx - half, cy - half, half * 2, half * 2, 0, 0, size, size);
  return cv;
}

function candidateCrops(img, r) {
  const out = [];
  for (const p of r.pieces) if (p.dial) out.push({ cv: cropCanvas(img, p.dial.cx, p.dial.cy, p.dial.r * 1.4), cap: `قرص ${TYPE_AR[p.type] || p.type}: ${p.arrow?.ok ? DIR_AR[p.arrow.dir] + ' ' + Math.round(p.arrow.confidence * 100) + '٪' : 'غير مقروء'}`, name: `dial-${p.id}` });
  for (const p of r.pieces) if (p.type === 'walk' || p.type === 'jump' || p.type === 'hand') if (!p.dial) out.push({ cv: cropCanvas(img, p.cx, p.cy, Math.max(p.length, p.width) * 0.6), cap: `${TYPE_AR[p.type]}: لا قرص`, name: `nodial-${p.id}` });
  for (const n of r.numbers) { const [x0, y0, x1, y1] = n.bbox; out.push({ cv: cropCanvas(img, (x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) * 0.6), cap: `رقم: ${n.digit ?? '؟'} ${n.read?.ok ? Math.round(n.read.confidence * 100) + '٪' : n.reasons?.[0] || ''}`, name: `number-${n.id}` }); }
  for (const s of r.suspects || []) out.push({ cv: cropCanvas(img, s.cx, s.cy, s.width * 1.2), cap: 'مشتبهة/محجوبة', name: `suspect-${s.cx}-${s.cy}` });
  for (const x of (r.debug?.rejected || []).filter((q) => !q.suspect).slice(0, 6)) out.push({ cv: cropCanvas(img, x.cx, x.cy, 30), cap: `مرفوض: ${x.why === 'thin' ? 'رفيع' : 'بلا قرص/أيقونة'}`, name: `rejected-${x.cx}-${x.cy}` });
  return out;
}

function renderGallery(img, r) {
  el.candGallery.innerHTML = '';
  for (const c of candidateCrops(img, r).slice(0, 24)) { const f = document.createElement('figure'); f.appendChild(c.cv); const cap = document.createElement('figcaption'); cap.textContent = c.cap; f.appendChild(cap); el.candGallery.appendChild(f); }
}

function drawRecogOverlay(ctx, img, r, p) {
  const color = { ok: '#00e676', uncertain: '#ffea00', unknown: '#ff1744', ghost: '#9e9e9e' };
  const orderOf = new Map((p?.order || []).map((id, i) => [id, i + 1]));
  ctx.lineWidth = Math.max(2, img.width / 320); ctx.font = `${Math.max(12, img.width / 50)}px sans-serif`;
  for (const pc of r.pieces) {
    const [x0, y0, x1, y1] = pc.bbox; ctx.strokeStyle = color[pc.status] || '#fff'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const label = `${orderOf.get(pc.id) ? orderOf.get(pc.id) + '. ' : ''}${TYPE_AR[pc.type] || pc.type}${pc.arrow?.ok ? ' ' + DIR_AR[pc.arrow.dir] : ''}${pc.number?.digit ? ' ×' + pc.number.digit : ''}`;
    ctx.fillStyle = 'rgba(0,0,0,.65)'; const tw = ctx.measureText(label).width; ctx.fillRect(x0, y0 - 18 * img.width / 960 - 4, tw + 8, 20 * img.width / 960 + 4);
    ctx.fillStyle = color[pc.status] || '#fff'; ctx.fillText(label, x0 + 4, y0 - 4);
    if (pc.arrow?.ok) {
      const a = (pc.arrow.angle * Math.PI) / 180, [ax, ay] = pc.arrow.center, len = (pc.dial?.r || 20) * 1.4;
      ctx.strokeStyle = '#ff00ff'; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + Math.cos(a) * len, ay + Math.sin(a) * len); ctx.stroke();
    }
  }
  for (const n of r.numbers) { const [x0, y0, x1, y1] = n.bbox; ctx.setLineDash([6, 4]); ctx.strokeStyle = '#ff9100'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]); }
  for (const sp of r.suspects || []) { const [x0, y0, x1, y1] = sp.bbox; ctx.setLineDash([3, 3]); ctx.strokeStyle = '#ff1744'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]); }
}

function renderRecogText(r, p) {
  const orderOf = new Map((p?.order || []).map((id, i) => [id, i + 1]));
  const conf = (v) => `${Math.round((v || 0) * 100)}٪`;
  el.recogList.innerHTML = r.pieces.map((pc) => {
    const parts = [`${orderOf.get(pc.id) ? `#${orderOf.get(pc.id)} ` : ''}${TYPE_AR[pc.type] || pc.type}`, STATUS_AR[pc.status], `ثقة ${conf(pc.confidence)}`,
      pc.arrow?.ok ? `السهم ${DIR_AR[pc.arrow.dir]} (${pc.arrow.angle}°، ${conf(pc.arrow.confidence)})` : ACTION_HINT(pc),
      pc.number ? `الرقم ${pc.number.digit ?? '؟'} (${conf(pc.number.confidence)})` : '', `الموقع ${Math.round(pc.cx)},${Math.round(pc.cy)}`,
      pc.reasons?.length ? `[${pc.reasons.join('، ')}]` : ''];
    return `<li class="${pc.status === 'ok' ? 'ok' : pc.status === 'ghost' ? 'info' : pc.status === 'unknown' ? 'error' : 'warn'}">${escapeHtml(parts.filter(Boolean).join(' · '))}</li>`;
  }).join('') + r.numbers.filter((n) => !n.attachedTo).map((n) => `<li class="warn">${escapeHtml(`رقم ${n.digit ?? '؟'} غير متصل · ${STATUS_AR[n.status] || n.status}`)}</li>`).join('');
  el.recogProgram.textContent = p.steps.length ? stepsToText(p.steps) : '—';
  const acc = state.recog.accepted;
  el.recogStatus.textContent = [
    p.ok ? (acc ? '✓ البرنامج مقبول (قراءتان متطابقتان)' : 'قراءة صحيحة — بانتظار التأكيد بقراءة ثانية') : `مرفوض: ${p.reasons.map((x) => REASON_AR[x] || x).join(' ')}`,
    `زمن التعرف ${Math.round(state.recog.ms)}ms`, `معدل التعرف ${(state.recog.runsT.length / 10).toFixed(1)}/ث`, `قراءات ناجحة ${state.recog.okReads}/${state.recog.reads}`,
    (r.suspects || []).length ? `مشتبهة ${(r.suspects || []).length}` : '', r.rejectedCount ? `مرفوض ${r.rejectedCount}` : '',
    r.scale.dialPx ? `قطر القرص ${r.scale.dialPx}px` : '', r.evidence.mirroredDigits ? `⚠ أرقام تبدو معكوسة (${r.evidence.mirroredDigits})` : '',
  ].filter(Boolean).join(' · ');
  el.btnRun.disabled = !acc;
  renderStats();
}
const ACTION_HINT = (pc) => (['walk', 'jump', 'hand'].includes(pc.type) ? 'السهم غير مقروء' : '');

function loadStats() { try { return JSON.parse(localStorage.getItem(STATS_KEY)) || { attempts: 0, correct: 0, errors: {} }; } catch { return { attempts: 0, correct: 0, errors: {} }; } }
function renderStats() {
  const st = loadStats();
  el.recogStats.textContent = st.attempts ? `مقارنات: ${st.attempts} · صحيحة بالكامل: ${st.correct} (${Math.round((st.correct / st.attempts) * 100)}٪) · أخطاء: ${Object.entries(st.errors).map(([k, v]) => `${k}=${v}`).join('، ') || 'لا شيء'}` : 'لا مقارنات بعد. اكتب البرنامج المتوقع ثم «قارن بالمتوقع».';
}
function compareWithExpected() {
  const steps = state.recog.accepted?.steps || state.recog.program?.steps;
  if (!steps) { el.recogStats.textContent = 'لا توجد قراءة بعد.'; return; }
  const exp = parseExpected(el.expectedInput.value || '');
  if (!exp.length || exp.some((e) => !e.type)) { el.recogStats.textContent = 'اكتب المتوقع بصيغة: مشي أعلى ٣، قفز يمين'; return; }
  const cmp = compareProgram(exp, steps);
  const st = loadStats(); st.attempts++; if (cmp.correct) st.correct++;
  for (const e of cmp.errors) st.errors[e.kind] = (st.errors[e.kind] || 0) + 1;
  // نسجل أيضًا خطأ الكاميرا منفصلًا عن خطأ الطفل لاحقًا؛ هنا كل خطأ = خطأ تعرف (الوالد كتب المتوقع)
  try { localStorage.setItem(STATS_KEY, JSON.stringify(st)); } catch { /* اختياري */ }
  renderStats();
  el.recogStats.textContent = (cmp.correct ? '✓ مطابق. ' : `✗ ${cmp.errors.map((e) => `#${e.index} ${e.kind}`).join('، ')}. `) + el.recogStats.textContent;
}

function teachDigit(d) {
  const nums = (state.recog.result?.numbers || []).filter((n) => n.glyph && n.glyph.length > 20);
  if (nums.length !== 1) { el.recogStatus.textContent = `للتعليم: ضع قطعة رقم واحدة فقط (موجود الآن: ${nums.length}).`; return; }
  const g = nums[0].glyph; let mx = 0, my = 0; for (const [x, y] of g) { mx += x; my += y; } mx /= g.length; my /= g.length;
  const pts = g.map(([x, y]) => [x - mx, y - my]);
  // نخزن الخريطة بالاتجاه الذي يطابق قالب هذا الرقم أكثر (اتجاه قياسي معتدل)
  let best = null; for (let deg = 0; deg < 360; deg += 5) { const bm = glyphBitmap(pts, deg); const sc = Math.max(...BUILTIN_DIGIT_TEMPLATES[d].map((t) => dice(bm, t))); if (!best || sc > best.sc) best = { sc, bm }; }
  const learned = learnedDigits(); learned[d] = [best.bm.join(''), ...(learned[d] || [])].slice(0, 8);
  try { localStorage.setItem(DIGITS_KEY, JSON.stringify(learned)); el.recogStatus.textContent = `تعلّمتُ الرقم ${d} (عينات: ${learned[d].length}). تُحفظ خريطة صغيرة فقط، بلا صورة.`; } catch { /* اختياري */ }
}

function runRobot() {
  const acc = state.recog.accepted; if (!acc) return;
  const res = runProgram(acc.steps, { cols: 7, rows: 5, start: [3, 4] });
  const c = el.robotCanvas, ctx = c.getContext('2d'); const cs = Math.min(c.width / 7, c.height / 5);
  let i = 0;
  const draw = () => {
    ctx.fillStyle = '#0b1124'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#2d3a66'; for (let x = 0; x <= 7; x++) { ctx.beginPath(); ctx.moveTo(x * cs, 0); ctx.lineTo(x * cs, 5 * cs); ctx.stroke(); } for (let y = 0; y <= 5; y++) { ctx.beginPath(); ctx.moveTo(0, y * cs); ctx.lineTo(7 * cs, y * cs); ctx.stroke(); }
    const t = res.trace[Math.min(i, res.trace.length - 1)];
    ctx.fillStyle = t.event === 'bump' ? '#ff6b6b' : '#5ad1e6'; ctx.beginPath(); ctx.arc((t.x + 0.5) * cs, (t.y + 0.5) * cs, cs * 0.35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '16px sans-serif'; ctx.fillText(`خطوة ${t.step}/${acc.steps.length}`, 8, c.height - 8);
    if (i < res.trace.length - 1) { i++; setTimeout(draw, 450); }
    else if (res.issues.length) { ctx.fillStyle = '#ffcf4a'; ctx.fillText(res.issues.map((x) => x.kind === 'blocked' ? 'اصطدم بالحافة' : `غير مدعوم: ${x.type}`).join('، '), 8, 22); }
  };
  draw();
}

function drawMiniViews() {
  const v = el.video; if (!v.videoWidth) return;
  const fit = (cv, w, h) => { const k = 240 / Math.max(w, h); const W = Math.round(w * k), H = Math.round(h * k); if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; } return k; };
  fit(el.rawCanvas, v.videoWidth, v.videoHeight); el.rawCanvas.getContext('2d').drawImage(v, 0, 0, el.rawCanvas.width, el.rawCanvas.height);
  fit(el.corrMini, el.corrected.width, el.corrected.height); el.corrMini.getContext('2d').drawImage(el.corrected, 0, 0, el.corrMini.width, el.corrMini.height);
  if (el.rectified.width > 1) { fit(el.cropMini, el.rectified.width, el.rectified.height); el.cropMini.getContext('2d').drawImage(el.rectified, 0, 0, el.cropMini.width, el.cropMini.height); }
}

/** اختبار التقريب الفعلي: نطبق عدة قيم ونقيس حجم القطع والحدة داخل منطقة اللعب ثم نعيد القيمة الأصلية. */
async function zoomSweep() {
  const cap = state.info?.capabilities?.zoom; if (!cap) return;
  const orig = state.zoom || 1; const origCorners = state.corners.map((p) => [...p]);
  const levels = [1, 1.2, 1.4, 1.7, 2].filter((z) => z <= (cap.max || 1));
  const rows = [];
  el.autoInfo.textContent = 'اختبار التقريب جارٍ… لا تحرك القطع.';
  for (const z of levels) {
    await setZoom(z);
    await new Promise((r) => setTimeout(r, 900));
    const inFrame = state.corners.every(([x, y]) => x >= 0 && y >= 0 && x <= 1 && y <= 1);
    state.rd.key = '';
    const img = grabTier(state.rd, READ_LEVELS[0]);
    const m = analyze(img.data, img.width, img.height, 2);
    const r = recognize(img.data, img.width, img.height, { learnedDigits: learnedDigits() });
    const p = state.rd.plan;
    rows.push({ zoom: z, inFrame, roiNative: `${p.nativeRoiW}×${p.nativeRoiH}`, read: `${p.outW}×${p.outH}`, sharp: Math.round(m.sharpness), pieces: r.pieces.filter((q) => q.status === 'ok').length, dialPx: r.scale.dialPx });
  }
  await setZoom(orig); state.corners = origCorners; onGeometryChanged();
  state.zoomSweep = rows;
  el.autoInfo.textContent = 'نتيجة اختبار التقريب: ' + rows.map((r) => `${r.zoom}× ${r.inFrame ? '' : '(المنطقة تخرج عن الإطار) '}قرص ${r.dialPx}px حدة ${r.sharp} قطع ${r.pieces}`).join(' | ') +
    '. ملاحظة: الالتقاط 1920 من مستشعر 2736، فالتقريب حتى ~1.4× يأخذ تفاصيل حقيقية من المستشعر، وما بعده تكبير رقمي بلا تفاصيل جديدة.';
}

// ---------- الاختبار الموجّه ----------
function loadGuided() { try { return JSON.parse(localStorage.getItem(GUIDED_KEY)) || []; } catch { return []; } }
function saveGuided(rs) { try { localStorage.setItem(GUIDED_KEY, JSON.stringify(rs.slice(-500))); } catch { /* اختياري */ } }

function showGuided() {
  const st = STEPS[state.guided.idx];
  el.guidedArt.innerHTML = stepArt(st.art);
  el.guidedTitle.textContent = `${state.guided.idx + 1}/${STEPS.length} — ${st.title}`;
  el.guidedText.textContent = st.text;
  el.guidedExpected.value = st.expected;
  el.guidedExpected.placeholder = st.expected ? '' : 'فارغ = لا قطع';
  state.guided.readsAtStart = state.recog.reads; state.guided.okAtStart = state.recog.okReads;
  const recs = loadGuided().filter((r) => r.step === st.id && r.set === el.guidedSet.value);
  el.guidedResult.textContent = recs.length ? `محاولات هذه الخطوة: ${recs.length}، صحيحة: ${recs.filter((r) => r.correct).length}` : '';
  renderGuidedSummary();
}

function guidedCapture() {
  const st = STEPS[state.guided.idx];
  const { result, program } = state.recog;
  if (!result) { el.guidedResult.textContent = 'لا توجد قراءة بعد: انتظر ثبات الصورة.'; return; }
  const rec = evaluateAttempt(st, el.guidedExpected.value, result, program, {
    set: el.guidedSet.value, recogMs: Math.round(state.recog.ms), stable: state.stable, accepted: state.recog.accepted?.text || null,
    readsInStep: state.recog.reads - state.guided.readsAtStart, okReadsInStep: state.recog.okReads - state.guided.okAtStart,
    orientation: state.orientation, appVersion: APP_VERSION,
  });
  const rs = loadGuided(); rs.push(rec); saveGuided(rs);
  const parts = [rec.correct ? '✓ صحيح' : '✗ خطأ', `الفعلي: ${rec.actual || 'لا شيء'}`];
  if (Object.keys(rec.missing).length) parts.push(`ناقص: ${JSON.stringify(rec.missing)}`);
  if (Object.keys(rec.extra).length) parts.push(`زائد: ${JSON.stringify(rec.extra)}`);
  if (rec.dirCorrect === false) parts.push('اتجاه خاطئ'); if (rec.numberCorrect === false) parts.push('رقم خاطئ');
  if (rec.reasons.length) parts.push(`أسباب: ${rec.reasons.map((x) => REASON_AR[x] || x).join(' ')}`);
  el.guidedResult.textContent = parts.join(' · ');
  renderGuidedSummary();
}

function renderGuidedSummary() {
  const s = summarize(loadGuided());
  const fmt = (x) => (x ? `${x.ok}/${x.n} (${x.pct}٪)` : '—');
  el.guidedSummary.textContent = ['validation', 'dev'].map((k) => `${k === 'validation' ? 'تحقق' : 'تطوير'}: محاولات ${s[k].attempts}، صحيحة ${s[k].correct}، قطع وهمية على السطح الفارغ ${s[k].emptyFalsePositives}، الاتجاه ${fmt(s[k].dirAccuracy)}، الأرقام ${fmt(s[k].numberAccuracy)}، قبول البرنامج ${fmt(s[k].programAccepted)}`).join(' | ');
}

// ---------- حزمة التصدير ----------
function packImages() {
  const img = state.recog.input, r = state.recog.result; if (!img || !r) return [];
  const toCanvas = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').putImageData(im, 0, 0); return c; };
  const input = toCanvas(img);
  const overlay = toCanvas(img); drawRecogOverlay(overlay.getContext('2d'), img, r, state.recog.program);
  const mask = toCanvas(maskImage(r, img.width, img.height));
  return [{ name: 'images/engine-input.png', cv: input, cap: 'الصورة الداخلة' }, { name: 'images/overlay.png', cv: overlay, cap: 'الحدود' }, { name: 'images/mask.png', cv: mask, cap: 'القناع' },
    ...candidateCrops(img, r).map((c) => ({ name: `images/candidates/${c.name}.png`, cv: c.cv, cap: c.cap }))];
}

function openPackDialog() {
  el.packPreview.innerHTML = ''; el.packImages.checked = false; el.packRaw.checked = false;
  for (const it of packImages().slice(0, 12)) { const f = document.createElement('figure'); f.appendChild(it.cv); const cap = document.createElement('figcaption'); cap.textContent = it.cap; f.appendChild(cap); el.packPreview.appendChild(f); }
  if (!state.recog.input) el.packPreview.textContent = 'لا توجد صورة تعرف بعد؛ ستُصدَّر التقارير فقط.';
  el.packDialog.showModal();
}

const canvasBytes = (cv, type = 'image/png', q) => new Promise((res) => cv.toBlob(async (b) => res(b ? new Uint8Array(await b.arrayBuffer()) : null), type, q));

async function exportPack() {
  const recs = loadGuided();
  let backup = null; try { backup = sanitizeBackup(JSON.parse(exportSettings(localStorage))); } catch { /* */ }
  const r = state.recog.result;
  const report = sanitize({
    appVersion: APP_VERSION, exportedAt: new Date().toISOString(), diagnostics: diagData(), calibration: backup,
    guided: { records: recs, summary: summarize(recs) },
    lastRecognition: r ? { pieces: r.pieces.map(({ glyph, ...p }) => p), numbers: r.numbers.map(({ glyph, ...n }) => n), suspects: r.suspects, rejected: r.debug?.rejected, scale: r.scale, timings: r.timings, table: r.table, program: state.recog.program, accepted: state.recog.accepted } : null,
    lastExpected: el.guidedExpected.value || el.expectedInput.value || null,
    imagesIncluded: el.packImages.checked, rawIncluded: el.packRaw.checked,
  });
  const files = [{ name: 'report.json', data: JSON.stringify(report, null, 1) }];
  if (el.packImages.checked) for (const it of packImages()) { const b = await canvasBytes(it.cv); if (b) files.push({ name: it.name, data: b }); }
  if (el.packRaw.checked && el.video.videoWidth) {
    const c = document.createElement('canvas'); c.width = el.video.videoWidth; c.height = el.video.videoHeight; c.getContext('2d').drawImage(el.video, 0, 0);
    const b = await canvasBytes(c, 'image/jpeg', 0.85); if (b) files.push({ name: 'images/raw-camera.jpg', data: b });
  }
  downloadBlob(new Blob([createZip(files)], { type: 'application/zip' }), `osmo-test-pack-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`);
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
    videoW: state.vw, videoH: state.vh, zoom: round4(state.zoom || 1), cameraLabel: state.cameraLabel,
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
  pruneGlobal();
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
    frame: { status: state.frame.status, valid: state.frame.valid, rvfc: state.frame.rvfc, events: state.frame.events.slice(-8), video: { paused: el.video.paused, readyState: el.video.readyState }, track: (() => { const t = state.stream?.getVideoTracks?.()[0]; return t ? { readyState: t.readyState, muted: t.muted, enabled: t.enabled } : null; })(), recoveries: recovery.attempts.length, gaveUp: state.gaveUp },
    monitorMs: stats(state.monMsHist), readMsStats: stats(state.readMsHist),
    flickerMasked: flicker.maskedCount, zoomSweep: state.zoomSweep || null,
    recognition: state.recog.result ? { pieces: state.recog.result.pieces.map((p) => ({ type: p.type, status: p.status, conf: p.confidence, dir: p.arrow?.ok ? p.arrow.dir : null, arrowConf: p.arrow?.confidence ?? null, digit: p.number?.digit ?? null, reasons: p.reasons })), numbers: state.recog.result.numbers.length, program: stepsToText(state.recog.program.steps), ok: state.recog.program.ok, reasons: state.recog.program.reasons, accepted: state.recog.accepted?.text || null, msStats: stats(state.recog.msHist), reads: state.recog.reads, okReads: state.recog.okReads, scale: state.recog.result.scale, timings: state.recog.result.timings } : null,
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
    'الإصدار': d.appVersion, 'حالة الإطار': `${d.frame.status} (صالح: ${d.frame.valid})`, 'المسار': JSON.stringify(d.frame.track), 'أحداث الكاميرا': JSON.stringify(d.frame.events), 'الفيديو': d.video,
    'زمن المراقبة avg/p95': JSON.stringify(d.monitorMs), 'زمن القراءة avg/p95': JSON.stringify(d.readMsStats), 'خلايا متذبذبة مستبعدة': d.flickerMasked, 'التقريب': d.zoom, 'منطقة اللعب (أصلية)': d.roiNative,
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
  const text = JSON.stringify(sanitize(diagData()), null, 2); // بلا deviceId/groupId
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

function saveRawSnapshot() {
  const v = el.video; if (!v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  c.toBlob((blob) => { if (blob) downloadBlob(blob, `osmo-raw-${state.orientation}-${Date.now()}.jpg`); }, 'image/jpeg', 0.9);
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
window.__osmoDebug = { state, diagData, autoCalibrate, readHighRes, health, recovery, runRecognition, guidedCapture, packImages };
