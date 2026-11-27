// تحويل القطع المكتشفة إلى برنامج مرتب، مع أسباب الرفض. وحدة صرفة.
// افتراض يحتاج تأكيدًا ماديًا: البرنامج يبدأ من طرف السلسلة الأقرب إلى الآيباد (أعلى الصورة).
import { ACTION_TYPES } from './recognize.js';

// حصر القطع المتوفرة (src/content/pieces.js) لكشف النتائج غير المنطقية
export const INVENTORY = { walk: 6, jump: 3, hand: 3, rest: 2, repeat: 2, magic: 1, 'func-star': 1, 'func-circle': 1, 'func-square': 1 };

export const REASON_AR = {
  'no-pieces': 'لا توجد قطع أوامر.',
  'unknown-piece': 'توجد قطعة غير معروفة.',
  'low-confidence': 'قطعة غير واضحة؛ عدّل وضعها.',
  'no-arrow': 'سهم غير مقروء.',
  'orphan-number': 'رقم غير متصل بقطعة.',
  'number-uncertain': 'رقم غير واضح.',
  'multiple-chains': 'القطع ليست سلسلة واحدة متصلة.',
  'branching': 'السلسلة متفرعة.',
  'unstable': 'القطع تتحرك.',
  'occluded': 'قطعة محجوبة أو غير واضحة بجانب البرنامج؛ أبعد اليد.',
  'inventory': 'عدد قطع من نوع ما أكبر مما في المجموعة؛ قراءة غير منطقية.',
};

/**
 * اتصال قطعتين: تلامس/تقارب حدودهما من أي جانب. في برامج Osmo تتراص القطع على جانبها القصير
 * (السلسلة عمودية على محور القطعة)، لذا لا نفترض الاتصال طرفًا بطرف.
 */
export function connected(a, b) {
  const W = Math.min(a.width, b.width);
  const [ax0, ay0, ax1, ay1] = a.bbox, [bx0, by0, bx1, by1] = b.bbox;
  const gapX = Math.max(0, Math.max(ax0, bx0) - Math.min(ax1, bx1));
  const gapY = Math.max(0, Math.max(ay0, by0) - Math.min(ay1, by1));
  const ovX = Math.min(ax1, bx1) - Math.max(ax0, bx0), ovY = Math.min(ay1, by1) - Math.max(ay0, by0);
  const minW = Math.min(ax1 - ax0, bx1 - bx0), minH = Math.min(ay1 - ay0, by1 - by0);
  // متجاوران رأسيًا مع تداخل أفقي كافٍ، أو أفقيًا مع تداخل رأسي كافٍ
  return (gapY < 0.45 * W && ovX > 0.3 * minW) || (gapX < 0.45 * W && ovY > 0.3 * minH);
}

export function buildProgram(result, { minConfidence = 0.6 } = {}) {
  const reasons = new Set();
  const cmds = result.pieces.filter((p) => p.status !== 'ghost');
  if (cmds.some((p) => p.status === 'unknown')) reasons.add('unknown-piece');
  const usable = cmds.filter((p) => p.status !== 'unknown');
  if (!usable.length) return { ok: false, steps: [], order: [], reasons: ['no-pieces'] };
  if (usable.some((p) => p.confidence < minConfidence)) reasons.add('low-confidence');
  for (const n of result.numbers) {
    if (n.status === 'ghost' || n.status === 'unknown') continue;
    if (!n.attachedTo) reasons.add('orphan-number');
    else if (n.status !== 'ok') reasons.add('number-uncertain');
  }
  // الرسم البياني للاتصال
  const adj = new Map(usable.map((p) => [p.id, []]));
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
    if (connected(usable[i], usable[j])) { adj.get(usable[i].id).push(usable[j].id); adj.get(usable[j].id).push(usable[i].id); }
  }
  // المكونات
  const byId = new Map(usable.map((p) => [p.id, p]));
  const seen = new Set(); const chains = [];
  for (const p of usable) {
    if (seen.has(p.id)) continue;
    const comp = []; const st = [p.id]; seen.add(p.id);
    while (st.length) { const k = st.pop(); comp.push(k); for (const n of adj.get(k)) if (!seen.has(n)) { seen.add(n); st.push(n); } }
    chains.push(comp);
  }
  if (chains.length > 1) reasons.add('multiple-chains');
  const main = chains.sort((a, b) => b.length - a.length)[0];
  if (main.some((k) => adj.get(k).length > 2)) reasons.add('branching');
  // كتلة بحجم قطعة بلا دليل بنيوي ملاصقة للسلسلة = قطعة محجوبة على الأرجح ← نرفض بدل تنفيذ برنامج ناقص
  for (const sp of result.suspects || []) {
    if (main.some((k) => connected(byId.get(k), { ...sp, width: sp.width }))) reasons.add('occluded');
  }
  // الجرد: أكثر مما في المجموعة = خطأ تعرف (نكشفه ولا نخفيه)
  const counts = {}; for (const p of usable) counts[p.type] = (counts[p.type] || 0) + 1;
  for (const [t, n] of Object.entries(counts)) if (n > (INVENTORY[t] ?? 99)) reasons.add('inventory');
  // الترتيب: من الطرف الأعلى (الأقرب للآيباد)
  const endpoints = main.filter((k) => adj.get(k).length <= 1);
  const start = (endpoints.length ? endpoints : main).reduce((a, b) => (byId.get(a).cy <= byId.get(b).cy ? a : b));
  const order = []; const vis = new Set(); let cur = start;
  while (cur !== undefined && !vis.has(cur)) { order.push(cur); vis.add(cur); cur = adj.get(cur).find((n) => !vis.has(n)); }
  for (const k of main) if (!vis.has(k)) order.push(k); // في حال التفرع
  const steps = order.map((k, i) => {
    const p = byId.get(k);
    const step = { index: i + 1, pieceId: k, type: p.type, count: p.number?.digit ?? 1, confidence: p.confidence };
    if (ACTION_TYPES.has(p.type)) {
      if (!p.arrow?.ok) reasons.add('no-arrow'); else step.dir = p.arrow.dir;
    }
    return step;
  });
  return { ok: reasons.size === 0, steps, order, chains: chains.length, reasons: [...reasons] };
}

const TYPE_AR = { walk: 'مشي', jump: 'قفز', hand: 'يد', rest: 'راحة', repeat: 'تكرار', magic: 'سحر', 'func-star': 'نجمة', 'func-circle': 'دائرة', 'func-square': 'مربع', function: 'دالة' };
const DIR_AR = { up: 'أعلى', down: 'أسفل', left: 'يسار', right: 'يمين' };

export function stepsToText(steps) {
  return steps.map((s) => [TYPE_AR[s.type] || s.type, s.dir ? DIR_AR[s.dir] : null, s.count > 1 ? s.count : null].filter(Boolean).join(' ')).join('، ');
}

/** يحلل البرنامج المتوقع من نص عربي أو إنجليزي: «مشي أعلى 3، قفز يمين، يد يسار». */
export function parseExpected(text) {
  const TYPES = { walk: 'walk', 'مشي': 'walk', jump: 'jump', 'قفز': 'jump', hand: 'hand', 'يد': 'hand', rest: 'rest', 'راحة': 'rest', repeat: 'repeat', 'تكرار': 'repeat', magic: 'magic', 'سحر': 'magic', star: 'func-star', 'نجمة': 'func-star', circle: 'func-circle', 'دائرة': 'func-circle', square: 'func-square', 'مربع': 'func-square' };
  const DIRS = { up: 'up', 'أعلى': 'up', 'فوق': 'up', down: 'down', 'أسفل': 'down', 'تحت': 'down', left: 'left', 'يسار': 'left', right: 'right', 'يمين': 'right' };
  const norm = (s) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return norm(text).split(/[،,;\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const toks = part.split(/\s+/).map((x) => x.toLowerCase());
    const step = { type: null, count: 1 };
    for (const tk of toks) {
      if (TYPES[tk]) step.type = TYPES[tk];
      else if (DIRS[tk]) step.dir = DIRS[tk];
      else if (/^\d+$/.test(tk)) step.count = +tk;
    }
    return step;
  });
}

/** مقارنة المتوقع بالفعلي: صحيح فقط إذا تطابق التسلسل كاملًا. */
export function compareProgram(expected, actual) {
  const errors = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i], a = actual[i];
    if (!e) { errors.push({ index: i + 1, kind: 'extra', actual: a }); continue; }
    if (!a) { errors.push({ index: i + 1, kind: 'missing', expected: e }); continue; }
    if (e.type !== a.type) errors.push({ index: i + 1, kind: 'type', expected: e.type, actual: a.type });
    if ((e.dir || null) !== (a.dir || null)) errors.push({ index: i + 1, kind: 'dir', expected: e.dir, actual: a.dir });
    if ((e.count || 1) !== (a.count || 1)) errors.push({ index: i + 1, kind: 'count', expected: e.count, actual: a.count });
  }
  return { correct: errors.length === 0, errors };
}
