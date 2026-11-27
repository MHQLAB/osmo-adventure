// يولّد قوالب الأرقام 2–5 من خطوط حرة عريضة (ليست أصول Osmo) كخرائط بت صغيرة.
// القوالب المدمجة بداية فقط؛ قوالب «تعليم الأرقام» من القطع الحقيقية (محلية) لها الأولوية.
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { glyphBitmap, GW, GH } from '../src/recognition/digits.js';

const FONTS = ['DejaVu Sans', 'DM Sans', 'Archivo Black'];
const out = {};
for (const d of ['2', '3', '4', '5']) {
  out[d] = [];
  for (const f of FONTS) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#fff"/><text x="60" y="128" font-family="${f}" font-weight="bold" font-size="140" text-anchor="middle" fill="#000">${d}</text></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
    const pts = [];
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[y * info.width + x] < 128) pts.push([x, y]);
    out[d].push(glyphBitmap(pts, 0).join(''));
  }
}
const js = `// مولَّد بواسطة tools/make-digit-templates.js — لا تعدّله يدويًا.\n// خرائط ${GW}×${GH} لأرقام 2–5 من خطوط حرة (DejaVu Sans، DM Sans، Archivo Black).\nexport const BUILTIN_DIGIT_TEMPLATES = ${JSON.stringify(out, null, 1)};\n`;
await writeFile(new URL('../src/recognition/digit-templates.js', import.meta.url), js);
console.log('templates ok');
