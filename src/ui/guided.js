// الاختبار الموجّه للوالدين: خطوات مرتبة، توقعات، وتقييم كل محاولة. وحدة صرفة (بلا DOM).
import { parseExpected, compareProgram, stepsToText } from '../recognition/program.js';

/** expected: نص البرنامج المتوقع (يُعدَّل قبل التسجيل)، '' = لا قطع. art: أنواع للصورة التوضيحية. */
export const STEPS = [
  { id: 'empty', title: 'سطح فارغ', text: 'أزل كل القطع وأبعد يديك. يجب ألا يكتشف النظام أي قطعة.', expected: '', art: [] },
  { id: 'walk1', title: 'قطعة مشي واحدة', text: 'ضع قطعة مشي زرقاء وسط المنطقة، سهمها نحو الآيباد، ثم أبعد يدك.', expected: 'مشي أعلى', art: ['walk'] },
  { id: 'walk-dir', title: 'اتجاهات السهم', text: 'أدر سهم قطعة المشي. عدّل المتوقع لكل اتجاه وسجّل 4 مرات (أعلى، يمين، أسفل، يسار).', expected: 'مشي يمين', art: ['walk'] },
  { id: 'walk-pos', title: 'موقع ومسافة', text: 'حرّك قطعة المشي: قرب الآيباد، بعيدًا عنه، يمينًا، يسارًا. سجّل في كل موقع.', expected: 'مشي أعلى', art: ['walk'] },
  { id: 'num2', title: 'الرقم ٢', text: 'صِل الرقم ٢ بقطعة المشي بجانب القرص.', expected: 'مشي أعلى ٢', art: ['walk', 'n2'] },
  { id: 'num345', title: 'الأرقام ٣ و٤ و٥', text: 'بدّل الرقم ٣ ثم ٤ ثم ٥، وعدّل المتوقع كل مرة.', expected: 'مشي أعلى ٣', art: ['walk', 'n3'] },
  { id: 'jump', title: 'قطعة القفز', text: 'قطعة قفز حمراء وحدها.', expected: 'قفز أعلى', art: ['jump'] },
  { id: 'hand', title: 'قطعة اليد', text: 'قطعة يد برتقالية وحدها.', expected: 'يد أعلى', art: ['hand'] },
  { id: 'rest', title: 'قطعة الراحة', text: 'قطعة راحة (Zzz) وحدها.', expected: 'راحة', art: ['rest'] },
  { id: 'magic', title: 'قطعة السحر', text: 'قطعة السحر (النجوم) وحدها.', expected: 'سحر', art: ['magic'] },
  { id: 'funcs', title: 'الدوال الثلاث', text: 'ضع دالة واحدة كل مرة: دائرة، مربع، نجمة. عدّل المتوقع.', expected: 'دائرة', art: ['func-circle'] },
  { id: 'repeat', title: 'التكرار', text: 'قطعة التكرار الرمادية وحدها.', expected: 'تكرار', art: ['repeat'] },
  { id: 'chain2', title: 'قطعتان متصلتان', text: 'مشي ثم قفز متصلتان؛ الأولى الأقرب للآيباد.', expected: 'مشي أعلى، قفز يمين', art: ['walk', 'jump'] },
  { id: 'chain3', title: 'ثلاث قطع متصلة', text: 'مشي، قفز، يد متصلة.', expected: 'مشي أعلى، قفز يمين، يد يسار', art: ['walk', 'jump', 'hand'] },
  { id: 'program', title: 'برنامج كامل', text: 'برنامج من 4–6 قطع مع أرقام. اكتب المتوقع كاملًا.', expected: 'مشي أعلى ٣، قفز يمين، يد أعلى، راحة', art: ['walk', 'n3', 'jump', 'hand', 'rest'] },
];

const countBy = (arr) => arr.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});

/**
 * يقيّم محاولة. result: مخرج recognize، program: مخرج buildProgram.
 * @returns سجل قابل للتصدير (بلا صور).
 */
export function evaluateAttempt(step, expectedText, result, program, extra = {}) {
  const exp = expectedText.trim() ? parseExpected(expectedText) : [];
  const actual = program?.steps || [];
  const real = (result?.pieces || []).filter((p) => p.status !== 'ghost');
  const expCounts = countBy(exp.map((e) => e.type)), actCounts = countBy(real.map((p) => p.type));
  const types = new Set([...Object.keys(expCounts), ...Object.keys(actCounts)]);
  const missing = {}, extraPieces = {};
  for (const t of types) { const d = (expCounts[t] || 0) - (actCounts[t] || 0); if (d > 0) missing[t] = d; if (d < 0) extraPieces[t] = -d; }
  let correct, errors = [];
  if (!exp.length) { correct = real.length === 0 && !(result?.numbers || []).some((n) => n.status === 'ok'); }
  else { const cmp = compareProgram(exp, actual); correct = cmp.correct && program?.ok === true; errors = cmp.errors; }
  const dirChecks = exp.map((e, i) => (e.dir ? { expected: e.dir, actual: actual[i]?.dir ?? null } : null)).filter(Boolean);
  const numChecks = exp.map((e, i) => (e.count > 1 || actual[i]?.count > 1 ? { expected: e.count, actual: actual[i]?.count ?? null } : null)).filter(Boolean);
  return {
    step: step.id, time: new Date().toISOString(), expected: expectedText, actual: stepsToText(actual), programOk: !!program?.ok,
    correct, errors, missing, extra: extraPieces,
    dirCorrect: dirChecks.length ? dirChecks.every((c) => c.expected === c.actual) : null,
    numberCorrect: numChecks.length ? numChecks.every((c) => c.expected === c.actual) : null,
    reasons: program?.reasons || [], pieces: real.map((p) => ({ type: p.type, status: p.status, conf: p.confidence, dir: p.arrow?.ok ? p.arrow.dir : null, digit: p.number?.digit ?? null })),
    ...extra,
  };
}

/** ملخص موحد لكل الخطوات، مفصول حسب مجموعة العينات (تطوير / تحقق). */
export function summarize(records) {
  const out = {};
  for (const set of ['dev', 'validation']) {
    const rs = records.filter((r) => r.set === set);
    const byStep = {};
    for (const r of rs) { const s = (byStep[r.step] ||= { attempts: 0, correct: 0 }); s.attempts++; if (r.correct) s.correct++; }
    const nonEmpty = rs.filter((r) => r.step !== 'empty');
    out[set] = {
      attempts: rs.length, correct: rs.filter((r) => r.correct).length,
      emptyFalsePositives: rs.filter((r) => r.step === 'empty' && !r.correct).length,
      dirAccuracy: ratio(nonEmpty.filter((r) => r.dirCorrect !== null), (r) => r.dirCorrect),
      numberAccuracy: ratio(nonEmpty.filter((r) => r.numberCorrect !== null), (r) => r.numberCorrect),
      programAccepted: ratio(nonEmpty, (r) => r.programOk), byStep,
    };
  }
  return out;
}
function ratio(arr, pred) { return arr.length ? { n: arr.length, ok: arr.filter(pred).length, pct: Math.round((arr.filter(pred).length / arr.length) * 100) } : null; }
