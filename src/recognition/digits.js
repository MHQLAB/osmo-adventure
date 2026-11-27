// قراءة الرقم المطبوع على القطعة الصفراء. وحدة صرفة.
// اتجاه الرقم غير ثابت بالنسبة لشكل القطعة، لذا نبحث بكل الزوايا (كل 10°).
// نقارن أيضًا بالقوالب المعكوسة: إن تفوقت باستمرار فالصورة معكوسة (دليل لمعايرة الانعكاس).
export const GW = 14, GH = 18;

/** يحوّل نقاط الحبر (بعد تدويرها بزاوية deg) إلى خريطة GW×GH مطبّعة على مستطيلها المحيط. */
export function glyphBitmap(pts, deg, mirror = false) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const rot = pts.map(([x, y]) => { const X = mirror ? -x : x; return [X * c - y * s, X * s + y * c]; });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of rot) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = x1 - x0 || 1, bh = y1 - y0 || 1;
  // نحافظ على النسبة: الرقم أطول من عرضه
  const scale = Math.max(bw / GW, bh / GH);
  const ox = (GW - bw / scale) / 2, oy = (GH - bh / scale) / 2;
  const bm = new Array(GW * GH).fill(0);
  // كل بكسل مصدر مربع بضلع 1: عند التكبير (أرقام صغيرة في الصورة) يغطي عدة خلايا فلا تظهر فجوات
  const half = 0.5 / scale;
  for (const [x, y] of rot) {
    const fx = (x - x0) / scale + ox, fy = (y - y0) / scale + oy;
    const ga = Math.max(0, Math.floor(fx - half)), gb = Math.min(GW - 1, Math.floor(fx + half));
    const ha = Math.max(0, Math.floor(fy - half)), hb = Math.min(GH - 1, Math.floor(fy + half));
    for (let gy = ha; gy <= hb; gy++) for (let gx = ga; gx <= gb; gx++) bm[gy * GW + gx] = 1;
  }
  return bm;
}

export function dice(a, b) {
  let inter = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { const x = +a[i], y = +b[i]; inter += x & y; sa += x; sb += y; }
  return sa + sb ? (2 * inter) / (sa + sb) : 0;
}

/**
 * @param {Array<[number,number]>} pts نقاط حبر الرقم
 * @param {Record<string,string[]>} templates قوالب كسلاسل '0101…'
 */
/**
 * prior: الاتجاه المتوقع للرقم (درجات). الطفل يضع القطع مقابلة له، والصورة المصححة تضع الآيباد أعلى،
 * فالرقم معتدل غالبًا. نبحث أولًا ضمن ±35° من الأولوية، ثم بكل الزوايا فقط إن كانت المطابقة ضعيفة.
 */
export function readDigit(pts, templates, { step = 10, prior = null } = {}) {
  if (prior !== null) {
    const priors = Array.isArray(prior) ? prior : [prior];
    const near = readDigitRange(pts, templates, step, (deg) => priors.some((p) => Math.abs(((deg - p + 540) % 360) - 180) <= 35));
    if (near.ok && near.score >= 0.68) return { ...near, prior: true };
    const all = readDigitRange(pts, templates, step, () => true);
    return all.ok && near.ok && near.score >= all.score - 0.03 ? { ...near, prior: true } : all;
  }
  return readDigitRange(pts, templates, step, () => true);
}

function readDigitRange(pts, templates, step, allow) {
  if (pts.length < 15) return { ok: false, reason: 'no-ink' };
  let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
  const centered = pts.map(([x, y]) => [x - mx, y - my]);
  const scores = {}; let mirrorBest = 0;
  for (let deg = 0; deg < 360; deg += step) {
    if (!allow(deg)) continue;
    const bm = glyphBitmap(centered, deg), bmm = glyphBitmap(centered, deg, true);
    for (const [digit, list] of Object.entries(templates)) {
      for (const tpl of list) {
        const sc = dice(bm, tpl); if (!(scores[digit]?.score >= sc)) scores[digit] = { score: sc, deg };
        const scm = dice(bmm, tpl); if (scm > mirrorBest) mirrorBest = scm;
      }
    }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  const [best, second] = ranked;
  const margin = best[1].score - (second ? second[1].score : 0);
  const confidence = Math.max(0, Math.min(1, (best[1].score - 0.55) / 0.25)) * Math.min(1, margin / 0.08);
  return {
    ok: true, digit: +best[0], score: +best[1].score.toFixed(3), margin: +margin.toFixed(3), rotation: best[1].deg,
    confidence: +confidence.toFixed(2), mirroredBetter: mirrorBest > best[1].score + 0.05,
  };
}
