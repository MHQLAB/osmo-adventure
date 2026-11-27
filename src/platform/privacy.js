// تنظيف التقارير والنسخ الاحتياطية من المعرفات غير الضرورية قبل تصديرها. وحدة صرفة.
// المعرفات الخام (deviceId/groupId) تبقى محليًا فقط ضمن مفتاح المعايرة المجزّأ (hash).

const DROP = new Set(['deviceId', 'groupId', 'cameraId']);

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!DROP.has(k)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

/** النسخة الاحتياطية: قيمها نصوص JSON، فننظف داخلها مع إبقاء المفاتيح (مجزأة أصلًا). */
export function sanitizeBackup(backup) {
  const data = {};
  for (const [k, v] of Object.entries(backup.data || {})) {
    try { data[k] = JSON.stringify(sanitize(JSON.parse(v))); } catch { data[k] = v; }
  }
  const { origin, ...rest } = backup; // الأصل يكفي ضمنيًا، لا حاجة لتصديره
  return { ...rest, data };
}
