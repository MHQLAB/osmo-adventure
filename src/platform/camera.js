// الوصول إلى الكاميرا واكتشاف إمكاناتها. لا تسجيل ولا إرسال لأي إطار.

export function cameraSupport(win = globalThis) {
  return {
    secureContext: !!win.isSecureContext,
    mediaDevices: !!win.navigator?.mediaDevices?.getUserMedia,
    standalone: !!(win.matchMedia?.('(display-mode: standalone)').matches || win.navigator?.standalone),
  };
}

export async function listCameras() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `كاميرا ${i + 1}`,
  }));
}

/**
 * يفتح الكاميرا. الافتراضي الكاميرا الأمامية لأن عاكس Osmo يغطيها.
 * نطلب 4:3 (نسبة المستشعر الأصلية) بدقة أعلى: 16:9 يقص المستشعر رأسيًا، والدقة الأعلى
 * تعطي بكسلات أكثر على الأسهم والأرقام. المعالجة لا تمس إلا منطقة اللعب.
 */
export async function openCamera({ deviceId, width = 1920, height = 1440 } = {}) {
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height } }
    : { facingMode: 'user', width: { ideal: width }, height: { ideal: height } };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export function trackInfo(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return null;
  return {
    label: track.label,
    settings: track.getSettings?.() ?? {},
    capabilities: track.getCapabilities?.() ?? null,
  };
}

export function stopStream(stream) {
  stream?.getTracks?.().forEach((t) => t.stop());
}

/** يطبّق قيدًا متقدمًا (zoom، whiteBalanceMode…) ويعيد الإعدادات الفعلية بعده، أو الخطأ. */
export async function applyTrackConstraint(stream, constraint) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track?.applyConstraints) return { ok: false, error: 'unsupported' };
  try { await track.applyConstraints({ advanced: [constraint] }); return { ok: true, settings: track.getSettings?.() ?? {} }; }
  catch (e) { return { ok: false, error: e?.name || String(e) }; }
}
