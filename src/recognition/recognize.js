// محرك التعرف على القطع v0 — وحدة صرفة بلا DOM (تعمل في Node للاختبار وفي المتصفح).
// المدخل: صورة منطقة اللعب المقوّمة (RGBA). المخرج: قطع بأنواعها وحدودها واتجاهاتها وأرقامها وثقتها.
// لا يُعتمد على اللون وحده: النوع = لون (بعد استبعاد الطاولة) + شكل + دليل بنيوي (قرص السهم، الأيقونة، الحبر).
import { L, tableModel, classifyPixels, majorityFill, PROTOTYPES } from './pixels.js';
import { components, shapeOf, radialProfileCV, holesOf } from './components.js';
import { readArrow } from './arrow.js';
import { readDigit } from './digits.js';
import { BUILTIN_DIGIT_TEMPLATES } from './digit-templates.js';
import { REAL_DIGIT_TEMPLATES } from './digit-templates-real.js';

const COLOR_TYPE = { [L.BLUE]: 'walk', [L.RED]: 'jump', [L.ORANGE]: 'hand', [L.PURPLE]: 'rest', [L.MAGENTA]: 'magic', [L.TEAL]: 'function' };
export const ACTION_TYPES = new Set(['walk', 'jump', 'hand']);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const protoSat = Object.fromEntries(PROTOTYPES.map((p) => [p.label, p.s]));

/** يجد مكوّن سهم داكن عند طرف القطعة ويعيد قرصًا مركزه منتصف السهم. */
export function findDialByArrow(c, inks, used, blockWid) {
  const ux = Math.cos(c.theta), uy = Math.sin(c.theta);
  const W = Math.max(c.width, blockWid * 0.8);
  let best = null, bd = Infinity;
  inks.forEach((k, idx) => {
    if (used.has(idx)) return;
    if (k.length < 0.28 * W || k.length > 1.15 * W || k.elong < 1.25) return;
    const dx = k.cx - c.cx, dy = k.cy - c.cy;
    const along = Math.abs(dx * ux + dy * uy), perp = Math.abs(-dx * uy + dy * ux);
    if (along < 0.2 * c.length || along > 0.95 * c.length || perp > 0.55 * W) return;
    const d = Math.hypot(dx, dy); if (d < bd) { bd = d; best = idx; }
  });
  if (best === null) return null;
  used.add(best);
  const k = inks[best];
  return { cx: k.cx, cy: k.cy, r: Math.max(k.length * 0.62, 0.36 * W), score: 1, via: 'arrow' };
}

/**
 * يبحث عن قرص السهم داخل القطعة قرب أحد طرفيها. شروط القبول (لا لون وحده):
 * فاتح ومنخفض التشبع في الداخل + سهم داكن في الداخل + محاط بلون القطعة نفسها (القرص مركّب على جسمها).
 */
export function findDial(c, sat, val, labels, w, h, blockWid) {
  const ux = Math.cos(c.theta), uy = Math.sin(c.theta);
  const W = Math.max(c.width, blockWid * 0.8);
  let best = null;
  for (const side of [1, -1]) for (let t = 0.12; t <= 0.8; t += 0.04) for (const rf of [0.36, 0.44, 0.52]) {
    const r = rf * W, cx = c.cx + side * ux * t * c.length, cy = c.cy + side * uy * t * c.length;
    let n = 0, light = 0, body = 0, ink = 0, ringN = 0, ringBody = 0;
    const r2 = r * r, R2 = (r * 1.45) ** 2, rr = r * 1.45;
    for (let y = Math.max(0, Math.floor(cy - rr)); y <= Math.min(h - 1, Math.ceil(cy + rr)); y += 2) {
      for (let x = Math.max(0, Math.floor(cx - rr)); x <= Math.min(w - 1, Math.ceil(cx + rr)); x += 2) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2; const i = y * w + x;
        if (d2 <= r2) {
          n++;
          if (labels[i] === c.lab) body++;
          else if (labels[i] === 9 || (val[i] < 0.35 && sat[i] < 0.45)) ink++;
          else if (sat[i] < 0.22 && val[i] > 0.3) light++;
        } else if (d2 <= R2) { ringN++; if (labels[i] === c.lab) ringBody++; }
      }
    }
    if (n < 10 || !ringN) continue;
    const inkF = ink / n, ringF = ringBody / ringN;
    if (inkF < 0.03) continue; // لا سهم = ليس قرصًا
    const score = (light + ink) / n - 0.8 * (body / n) + 0.6 * ringF + 0.1 * rf;
    if (!best || score > best.score) best = { cx, cy, r, score, ringF };
  }
  return best && best.score > 0.75 && best.ringF > 0.2 ? { cx: best.cx, cy: best.cy, r: best.r, score: +best.score.toFixed(2), ring: +best.ringF.toFixed(2) } : null;
}

export function mergeTemplates(learned) {
  const out = {};
  for (const [d, list] of Object.entries(BUILTIN_DIGIT_TEMPLATES)) out[d] = [...(REAL_DIGIT_TEMPLATES[d] || []), ...list];
  for (const [d, list] of Object.entries(learned || {})) out[d] = [...(list || []), ...(out[d] || [])];
  return out;
}

/**
 * @param {Uint8ClampedArray} rgba
 * @param {{gains?:number[], learnedDigits?:Record<string,string[]>, minArea?:number}} opts
 */
export function recognize(rgba, w, h, opts = {}) {
  const T0 = performance.now(); const t = {};
  const table = tableModel(rgba, w, h);
  const { labels: raw, s: sat, v: val } = classifyPixels(rgba, w, h, table, opts.gains);
  const labels = majorityFill(raw, w, h);
  t.classify = performance.now() - T0;

  const minArea = opts.minArea ?? Math.max(30, Math.round(w * h * 0.0003));
  const colored = [];
  for (const lab of [L.BLUE, L.RED, L.ORANGE, L.YELLOW, L.TEAL, L.PURPLE, L.MAGENTA]) {
    for (const px of components(labels, w, h, lab, minArea)) {
      const sh = shapeOf(px, w);
      let ms = 0; for (const j of px) ms += sat[j]; ms /= px.length;
      colored.push({ lab, px, ...sh, meanSat: ms });
    }
  }
  const neutral = components(labels, w, h, L.NEUTRAL, Math.max(12, minArea / 4)).map((px) => ({ px, ...shapeOf(px, w) }));
  const inks = components(labels, w, h, L.INK, 8).map((px) => ({ px, ...shapeOf(px, w) }));
  const usedInk = new Set();
  t.components = performance.now() - T0 - t.classify;

  // مكونات صغيرة داخل قطعة أكبر من اللون نفسه (لون الجسم بين خطوط الأيقونة) جزء منها لا قطع مستقلة
  const inside = (a, b) => a.bbox[0] >= b.bbox[0] && a.bbox[1] >= b.bbox[1] && a.bbox[2] <= b.bbox[2] && a.bbox[3] <= b.bbox[3];
  for (const c of colored) c.internal = colored.some((o) => o !== c && o.lab === c.lab && o.area > c.area * 2 && inside(c, o));
  for (let k = colored.length - 1; k >= 0; k--) if (colored[k].internal) colored.splice(k, 1);


  // المقياس: القطع الأفقية/الرأسية غير الصفراء المستطيلة
  const blocks = colored.filter((c) => c.lab !== L.YELLOW && c.elong > 1.4);
  const blockArea = median(blocks.map((c) => c.area)) || median(colored.map((c) => c.area)) || 1;
  const blockLen = median(blocks.map((c) => c.length)) || Math.sqrt(blockArea * 2.4);
  const blockWid = median(blocks.map((c) => c.width)) || blockLen / 2.4;

  // قطع متلاصقة من اللون نفسه (مشي + مشي في برنامج) تندمج في مكون واحد: نقسمها بالمساحة على محورها
  for (let k = colored.length - 1; k >= 0; k--) {
    const c = colored[k];
    if (c.lab === L.YELLOW) continue;
    const parts = Math.round(c.area / blockArea);
    if (parts < 2 || parts > 8 || c.elong < 1.25 * Math.min(parts, 3) * 0.9) continue;
    const ux = Math.cos(c.theta), uy = Math.sin(c.theta);
    const proj = c.px.map((j) => ((j % w) - c.cx) * ux + (((j / w) | 0) - c.cy) * uy);
    let lo = Infinity, hi = -Infinity; for (const v of proj) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const bins = Array.from({ length: parts }, () => []);
    c.px.forEach((j, i) => bins[Math.min(parts - 1, Math.floor(((proj[i] - lo) / (hi - lo + 1e-6)) * parts))].push(j));
    const subs = bins.filter((b) => b.length > minArea).map((b) => { let ms = 0; for (const j of b) ms += sat[j]; return { lab: c.lab, px: b, ...shapeOf(b, w), meanSat: ms / b.length, splitFrom: parts }; });
    colored.splice(k, 1, ...subs);
  }

  const pieces = []; const usedDials = new Set();
  let id = 0;
  for (const c of colored) {
    if (c.lab === L.YELLOW) continue;
    const reasons = []; let conf = 1;
    const piece = { id: ++id, type: COLOR_TYPE[c.lab], color: c.lab, cx: c.cx, cy: c.cy, theta: c.theta, length: c.length, width: c.width, bbox: c.bbox, area: c.area };
    // انعكاس/شبح: تشبع أقل بكثير من لون القطعة الحقيقي
    if (c.meanSat < 0.55 * protoSat[c.lab]) { piece.status = 'ghost'; piece.reasons = ['low-saturation']; piece.confidence = 0; pieces.push(piece); continue; }
    const ar = c.area / blockArea;
    if (ar < 0.35 || ar > 2.6 || c.elong < 1.25 || c.elong > 4.8) { reasons.push('shape'); conf *= 0.3; }

    if (ACTION_TYPES.has(piece.type)) {
      // قرص السهم: نبحث هندسيًا عند طرفي القطعة عن قرص فاتح منخفض التشبع، دون الاعتماد على لون الطاولة
      // الأولوية: السهم الداكن نفسه قرب طرف القطعة (شكل مميز لا يشبه أي سطح)، ثم البحث الهندسي عن القرص
      const dial = findDialByArrow(c, inks, usedInk, blockWid) || findDial(c, sat, val, labels, w, h, blockWid);
      if (!dial) { reasons.push('no-dial'); conf *= 0.5; }
      else {
        piece.dial = dial;
        const arrow = readArrow(labels, val, w, h, dial, L.INK, sat);
        piece.arrow = arrow;
        if (!arrow?.ok) { reasons.push('arrow-unread'); conf *= 0.5; }
        else if (arrow.confidence < 0.5) { reasons.push('arrow-uncertain'); conf *= 0.5 + arrow.confidence / 2; }
      }
    } else if (piece.type === 'function' || piece.type === 'magic') {
      const holes = holesOf(c.px, w, c.bbox).filter((j) => labels[j] === L.NEUTRAL);
      if (holes.length < 8) { reasons.push('no-icon'); conf *= 0.5; }
      else if (piece.type === 'function') {
        let hx = 0, hy = 0; for (const j of holes) { hx += j % w; hy += (j / w) | 0; } hx /= holes.length; hy /= holes.length;
        const cv = radialProfileCV(holes, w, hx, hy);
        piece.iconCV = cv == null ? null : +cv.toFixed(3);
        if (cv == null) { reasons.push('icon-unclear'); conf *= 0.5; }
        else {
          piece.symbol = cv < 0.065 ? 'circle' : cv < 0.17 ? 'square' : 'star';
          piece.type = `func-${piece.symbol}`;
          const edge = Math.min(Math.abs(cv - 0.065), Math.abs(cv - 0.17));
          if (edge < 0.015) { reasons.push('icon-ambiguous'); conf *= 0.6; }
        }
      }
    }
    piece.reasons = reasons; piece.confidence = +conf.toFixed(2);
    piece.status = reasons.includes('shape') ? 'unknown' : conf >= 0.6 ? 'ok' : 'uncertain';
    pieces.push(piece);
  }

  // التكرار: أيقونة حلقة داكنة كبيرة (مكوّن حبر فيه ثقب) خارج القطع الملونة وأقراصها.
  // نعتمد الأيقونة لا اللون الرمادي، لأن الرمادي يختفي على الطاولات الرمادية/البيج.
  const insideAny = (x, y) => pieces.some((p) => p.status !== 'ghost' && x >= p.bbox[0] && x <= p.bbox[2] && y >= p.bbox[1] && y <= p.bbox[3]) ||
    colored.some((c) => c.lab === L.YELLOW && x >= c.bbox[0] && x <= c.bbox[2] && y >= c.bbox[1] && y <= c.bbox[3]);
  for (const px of components(labels, w, h, L.INK, Math.max(12, minArea / 3))) {
    const sh = shapeOf(px, w);
    if (insideAny(sh.cx, sh.cy)) continue;
    const span = Math.max(sh.bbox[2] - sh.bbox[0], sh.bbox[3] - sh.bbox[1]);
    if (span < 0.35 * blockLen || span > 1.2 * blockLen) continue;
    const hole = holesOf(px, w, sh.bbox).length;
    if (hole < 0.15 * sh.area) continue; // الحلقة مجوفة
    const ux = Math.cos(sh.theta), uy = Math.sin(sh.theta);
    pieces.push({ id: ++id, type: 'repeat', color: L.NEUTRAL, cx: sh.cx, cy: sh.cy, theta: sh.theta, length: blockLen, width: blockWid,
      bbox: [Math.round(sh.cx - Math.abs(ux) * blockLen / 2 - Math.abs(uy) * blockWid / 2), Math.round(sh.cy - Math.abs(uy) * blockLen / 2 - Math.abs(ux) * blockWid / 2), Math.round(sh.cx + Math.abs(ux) * blockLen / 2 + Math.abs(uy) * blockWid / 2), Math.round(sh.cy + Math.abs(uy) * blockLen / 2 + Math.abs(ux) * blockWid / 2)],
      area: blockArea, reasons: [], confidence: 0.7, status: 'ok', evidence: 'loop-icon' });
  }

  // الأرقام
  const templates = mergeTemplates(opts.learnedDigits);
  const numbers = [];
  for (const c of colored) {
    if (c.lab !== L.YELLOW) continue;
    const ar = c.area / blockArea;
    if (c.meanSat < 0.55 * protoSat[L.YELLOW]) { numbers.push({ id: ++id, cx: c.cx, cy: c.cy, bbox: c.bbox, status: 'ghost', reasons: ['low-saturation'] }); continue; }
    if (ar < 0.08 || ar > 1.1) { numbers.push({ id: ++id, cx: c.cx, cy: c.cy, bbox: c.bbox, status: 'unknown', reasons: ['shape'] }); continue; }
    const holes = holesOf(c.px, w, c.bbox).filter((j) => labels[j] === L.INK || val[j] < 0.45);
    const pts = holes.map((j) => [j % w, (j / w) | 0]);
    const d = readDigit(pts, templates);
    numbers.push({ id: ++id, cx: c.cx, cy: c.cy, bbox: c.bbox, area: c.area, digit: d.ok ? d.digit : null, read: d, glyph: pts, status: d.ok && d.confidence >= 0.5 ? 'ok' : 'uncertain', reasons: d.ok ? (d.confidence < 0.5 ? ['digit-uncertain'] : []) : ['digit-unread'] });
  }
  // ربط كل رقم بأقرب قطعة تقبل رقمًا (قرص السهم للقطع ذات الأسهم)
  const accepts = pieces.filter((p) => p.status !== 'ghost' && p.type !== 'magic');
  const pairs = [];
  for (const nb of numbers) {
    if (nb.status === 'ghost' || nb.status === 'unknown') continue;
    for (const p of accepts) {
      const ax = p.dial ? p.dial.cx : p.cx, ay = p.dial ? p.dial.cy : p.cy;
      const d = Math.hypot(nb.cx - ax, nb.cy - ay);
      if (d < 0.85 * Math.max(p.length, blockLen)) pairs.push([d, nb, p]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const taken = new Set();
  for (const [, nb, p] of pairs) { if (nb.attachedTo || taken.has(p.id)) continue; nb.attachedTo = p.id; p.number = { id: nb.id, digit: nb.digit, confidence: nb.read?.confidence ?? 0 }; taken.add(p.id); }

  t.total = performance.now() - T0;
  const mirrorVotes = numbers.filter((n) => n.read?.mirroredBetter).length;
  return {
    pieces, numbers, table,
    scale: { blockLength: +blockLen.toFixed(1), blockWidth: +blockWid.toFixed(1), dialPx: +(median(pieces.filter((p) => p.dial).map((p) => p.dial.r * 2)) || 0).toFixed(1) },
    evidence: { mirroredDigits: mirrorVotes, digitsRead: numbers.filter((n) => n.read?.ok).length },
    timings: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)])),
  };
}
