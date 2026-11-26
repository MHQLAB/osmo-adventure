// يفشل إذا احتوى المستودع على صور خارج الأيقونات، أو عينات كاميرا، أو ملفات أسرار، أو نصوص تشبه المفاتيح.
// يعمل محليًا (قبل الرفع) وفي GitHub Actions.
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const problems = [];
const MEDIA = /\.(png|jpe?g|heic|heif|webp|gif|bmp|tiff?|mov|mp4|m4v|webm|avi)$/i;
const ALLOWED_MEDIA = /^icons\/icon-\d+\.png$/;
const SECRET_NAMES = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|id_rsa.*|credentials.*\.json|secrets?\..*)$/i;
const SAMPLE_PATHS = /(^|\/)(samples?|captures?|dataset|training|osmo-sample-)/i;
const SECRET_TEXT = /(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

for (const f of files) {
  if (MEDIA.test(f) && !ALLOWED_MEDIA.test(f)) problems.push(`صورة/فيديو غير مسموح: ${f}`);
  if (SECRET_NAMES.test(f)) problems.push(`ملف أسرار: ${f}`);
  if (SAMPLE_PATHS.test(f)) problems.push(`مسار عينات: ${f}`);
  try {
    if (statSync(f).size > 2_000_000) problems.push(`ملف كبير (>2MB): ${f}`);
    if (!MEDIA.test(f) && SECRET_TEXT.test(readFileSync(f, 'utf8'))) problems.push(`نص يشبه مفتاحًا سريًا: ${f}`);
  } catch { /* ملف محذوف */ }
}

if (problems.length) { console.error('فحص المستودع فشل:\n' + problems.join('\n')); process.exit(1); }
console.log(`فحص المستودع: ${files.length} ملف — سليم`);
