// حفظ المعايرة محليًا لكل جهاز/كاميرا ولكل اتجاه.

export const CALIBRATION_VERSION = 1;

/** مفتاح جهاز ثابت نسبيًا: معرّف الكاميرا + أبعاد الشاشة (بغض النظر عن الاتجاه) + كثافة البكسل. */
export function makeDeviceKey({ cameraId = '', screenW = 0, screenH = 0, dpr = 1 }) {
  const a = Math.min(screenW, screenH), b = Math.max(screenW, screenH);
  const s = `${cameraId}|${a}x${b}|${dpr}`;
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

export function validateCalibration(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (c.version !== CALIBRATION_VERSION) errors.push('version');
  if (!['portrait', 'landscape'].includes(c.orientation)) errors.push('orientation');
  if (![0, 90, 180, 270].includes(c.rotation)) errors.push('rotation');
  if (typeof c.flipH !== 'boolean' || typeof c.flipV !== 'boolean') errors.push('flip');
  if (!Array.isArray(c.corners) || c.corners.length !== 4 ||
      !c.corners.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)))
    errors.push('corners');
  if (!(c.videoW > 0 && c.videoH > 0)) errors.push('videoSize');
  return errors;
}

/** هل تصلح المعايرة لدقة الفيديو الحالية؟ (نسمح بتغير الدقة مع ثبات النسبة) */
export function isCompatible(c, videoW, videoH) {
  if (!c) return false;
  const r1 = c.videoW / c.videoH, r2 = videoW / videoH;
  return Math.abs(r1 - r2) < 0.02;
}

export class CalibrationStore {
  constructor(storage, prefix = 'osmo.cal') { this.s = storage; this.prefix = prefix; }
  key(deviceKey, orientation) { return `${this.prefix}.v${CALIBRATION_VERSION}.${deviceKey}.${orientation}`; }
  save(deviceKey, cal) {
    const errs = validateCalibration(cal);
    if (errs.length) throw new Error('invalid calibration: ' + errs.join(','));
    this.s.setItem(this.key(deviceKey, cal.orientation), JSON.stringify(cal));
  }
  load(deviceKey, orientation) {
    try {
      const raw = this.s.getItem(this.key(deviceKey, orientation));
      if (!raw) return null;
      const c = JSON.parse(raw);
      return validateCalibration(c).length ? null : c;
    } catch { return null; }
  }
  remove(deviceKey, orientation) { this.s.removeItem(this.key(deviceKey, orientation)); }
}
