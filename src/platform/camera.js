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

/** يفتح الكاميرا. الافتراضي الكاميرا الأمامية لأن عاكس Osmo يغطيها. */
export async function openCamera({ deviceId, width = 1280, height = 720 } = {}) {
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
