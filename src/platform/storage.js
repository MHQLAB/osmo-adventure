// تخزين محلي آمن عبر التحديثات: كل مفاتيح التطبيق تبدأ بـ "osmo." ولا تُحذف عند تحديث الإصدار.
// قاعدة: أي تغيير في صيغة البيانات يتطلب ترحيلًا (migration)، لا حذفًا.

export const PREFIX = 'osmo.';
export const BACKUP_FORMAT = 'osmo-backup-v1';

/** يصدّر كل إعدادات التطبيق (معايرة، ولاحقًا التقدم) كنص JSON — لا يحتوي صورًا. */
export function exportSettings(storage) {
  const data = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PREFIX)) data[k] = storage.getItem(k);
  }
  return JSON.stringify({ format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), data });
}

/** يستورد نسخة احتياطية؛ يقبل مفاتيح التطبيق فقط. يعيد عدد المفاتيح المستوردة. */
export function importSettings(storage, text) {
  const obj = JSON.parse(text);
  if (obj?.format !== BACKUP_FORMAT || typeof obj.data !== 'object') throw new Error('invalid backup');
  let n = 0;
  for (const [k, v] of Object.entries(obj.data)) {
    if (typeof k === 'string' && k.startsWith(PREFIX) && typeof v === 'string') { storage.setItem(k, v); n++; }
  }
  return n;
}

/** يطلب من المتصفح عدم حذف البيانات تلقائيًا عند ضيق المساحة (قد يُرفض بصمت). */
export async function requestPersistence() {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
