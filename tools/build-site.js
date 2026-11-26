// ينسخ ملفات التطبيق فقط إلى _site ويختم رقم الإصدار في sw.js وapp.js.
// ختم الإصدار يجعل كل نشر جديد يستبدل ملفات المخزن القديمة، دون لمس localStorage/IndexedDB
// حيث يُحفظ تقدم الطفل والمعايرة.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, '_site');
const build = (process.argv[2] || 'dev').replace(/[^a-zA-Z0-9.-]/g, '');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = `${pkg.version}+${build}`;

// قائمة بيضاء: لا يُنشر إلا ما هو هنا
const PUBLISH = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'src', 'icons'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const p of PUBLISH) await cp(join(root, p), join(out, p), { recursive: true });
await writeFile(join(out, '.nojekyll'), '');

const stamp = async (file, from, to) => {
  const f = join(out, file);
  const s = await readFile(f, 'utf8');
  if (!s.includes(from)) throw new Error(`stamp marker missing in ${file}`);
  await writeFile(f, s.replace(from, to));
};
await stamp('sw.js', "const VERSION = 'dev';", `const VERSION = '${version}';`);
await stamp('src/app.js', "export const APP_VERSION = 'dev';", `export const APP_VERSION = '${version}';`);
console.log(`built _site ${version}`);
