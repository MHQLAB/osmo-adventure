// إعادة تشغيل المسار البصري كاملًا على صورة كاميرا خام محفوظة + معايرة، خارج الآيباد.
// الاستخدام: node tools/replay.js <raw.jpg|png> <calibration.json|backup.json> <outDir> [readSide=960]
// المخرجات (في outDir خارج المستودع): corrected.png، engine-input.png، mask.png، overlay.png، result.json، crops/
// يستخدم الوحدات نفسها التي تعمل في التطبيق (orientationTransform، planRoi، buildRemap، recognize).
import sharp from 'sharp';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { orientationTransform } from '../src/vision/geometry.js';
import { planRoi, buildRemap, remapRGBA } from '../src/vision/rectify.js';
import { estimateIlluminant } from '../src/vision/illuminant.js';
import { recognize } from '../src/recognition/recognize.js';
import { buildProgram, stepsToText } from '../src/recognition/program.js';
import { LABEL_COLORS } from '../src/recognition/pixels.js';

const [rawPath, calPath, outDir, sideArg] = process.argv.slice(2);
if (!rawPath || !calPath || !outDir) { console.error('usage: node tools/replay.js raw.jpg cal.json outDir [side]'); process.exit(2); }
await mkdir(join(outDir, 'crops'), { recursive: true });

let cal = JSON.parse(await readFile(calPath, 'utf8'));
if (cal.format === 'osmo-backup-v1') cal = JSON.parse(Object.values(cal.data).find((v) => v.includes('"corners"')));

const { data, info } = await sharp(rawPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const vw = info.width, vh = info.height;
// 1) تصحيح الاتجاه بالتحويل نفسه المستخدم في Canvas
const t = orientationTransform(vw, vh, cal);
const [a, b, c, d, e, f] = t.matrix; const det = a * d - b * c;
const corrected = Buffer.alloc(t.outW * t.outH * 4);
for (let y = 0; y < t.outH; y++) for (let x = 0; x < t.outW; x++) {
  const X = x - e, Y = y - f; const sx = Math.round((d * X - c * Y) / det), sy = Math.round((-b * X + a * Y) / det);
  const o = (y * t.outW + x) * 4;
  if (sx < 0 || sy < 0 || sx >= vw || sy >= vh) { corrected[o + 3] = 255; continue; }
  const p = (sy * vw + sx) * 4; corrected[o] = data[p]; corrected[o + 1] = data[p + 1]; corrected[o + 2] = data[p + 2]; corrected[o + 3] = 255;
}
await sharp(corrected, { raw: { width: t.outW, height: t.outH, channels: 4 } }).png().toFile(join(outDir, 'corrected.png'));
// 2) منطقة اللعب وتقويم المنظور (planRoi بمقياس 1 ثم remap)
const side = +(sideArg || 960);
const plan = planRoi(cal.corners, t.outW, t.outH, side);
const crop = Buffer.alloc(plan.canvasW * plan.canvasH * 4);
for (let y = 0; y < plan.canvasH; y++) for (let x = 0; x < plan.canvasW; x++) {
  const sx = Math.min(t.outW - 1, Math.round(plan.bx + x / plan.scale)), sy = Math.min(t.outH - 1, Math.round(plan.by + y / plan.scale));
  corrected.copy(crop, (y * plan.canvasW + x) * 4, (sy * t.outW + sx) * 4, (sy * t.outW + sx) * 4 + 4);
}
const map = buildRemap(plan.cornersCanvas, plan.canvasW, plan.canvasH, plan.outW, plan.outH);
const input = remapRGBA(new Uint8ClampedArray(crop), new Uint8ClampedArray(plan.outW * plan.outH * 4), map);
await sharp(Buffer.from(input.buffer), { raw: { width: plan.outW, height: plan.outH, channels: 4 } }).png().toFile(join(outDir, 'engine-input.png'));
// 3) التعرف
const ill = estimateIlluminant(input);
const res = recognize(input, plan.outW, plan.outH, { gains: ill.reliable ? ill.gains : undefined, debug: true });
const prog = buildProgram(res);
// القناع اللوني
const labs = res.debug.labels; const mask = Buffer.alloc(plan.outW * plan.outH * 3);
for (let i = 0; i < labs.length; i++) { const col = LABEL_COLORS[labs[i]]; mask[i * 3] = col[0]; mask[i * 3 + 1] = col[1]; mask[i * 3 + 2] = col[2]; }
await sharp(mask, { raw: { width: plan.outW, height: plan.outH, channels: 3 } }).png().toFile(join(outDir, 'mask.png'));
// الطبقة التوضيحية
const col = { ok: '#00e676', uncertain: '#ffea00', unknown: '#ff1744', ghost: '#9e9e9e' };
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.outW}" height="${plan.outH}">`;
for (const p of res.pieces) {
  const [x0, y0, x1, y1] = p.bbox;
  svg += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${col[p.status]}" stroke-width="3"/><text x="${x0 + 3}" y="${y0 + 16}" font-size="15" font-family="DejaVu Sans" fill="${col[p.status]}" stroke="#000" stroke-width="0.5">${p.id}:${p.type}${p.arrow?.ok ? ' ' + p.arrow.dir : ''}${p.number ? ' x' + p.number.digit : ''}</text>`;
  if (p.dial) svg += `<circle cx="${p.dial.cx}" cy="${p.dial.cy}" r="${p.dial.r}" fill="none" stroke="#2979ff" stroke-width="2"/>`;
  if (p.arrow?.ok) { const an = p.arrow.angle * Math.PI / 180, [ax, ay] = p.arrow.center; svg += `<line x1="${ax}" y1="${ay}" x2="${ax + Math.cos(an) * 40}" y2="${ay + Math.sin(an) * 40}" stroke="#ff00ff" stroke-width="4"/>`; }
}
for (const n of res.numbers) { const [x0, y0, x1, y1] = n.bbox; svg += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#ff9100" stroke-width="2" stroke-dasharray="5"/><text x="${x0}" y="${y1 + 14}" font-size="14" fill="#ff9100">${n.digit ?? '?'}</text>`; }
svg += '</svg>';
await sharp(Buffer.from(input.buffer), { raw: { width: plan.outW, height: plan.outH, channels: 4 } }).composite([{ input: Buffer.from(svg) }]).png().toFile(join(outDir, 'overlay.png'));
const summary = {
  raw: `${vw}x${vh}`, corrected: `${t.outW}x${t.outH}`, transform: { rotation: cal.rotation, flipH: cal.flipH, flipV: cal.flipV },
  roiNative: `${plan.nativeRoiW}x${plan.nativeRoiH}`, engineInput: `${plan.outW}x${plan.outH}`, scale: +plan.scale.toFixed(3),
  illuminant: ill.white.map(Math.round), table: res.table, timings: res.timings, scaleEst: res.scale,
  pieces: res.pieces.map((p) => ({ id: p.id, type: p.type, status: p.status, conf: p.confidence, c: [Math.round(p.cx), Math.round(p.cy)], L: Math.round(p.length), W: Math.round(p.width), dir: p.arrow?.ok ? p.arrow.dir : null, digit: p.number?.digit ?? null, reasons: p.reasons, iconCV: p.iconCV, iconPx: p.iconPx })),
  numbers: res.numbers.map((n) => ({ id: n.id, digit: n.digit, status: n.status, c: [Math.round(n.cx), Math.round(n.cy)], read: n.read && { score: n.read.score, conf: n.read.confidence, mirrored: n.read.mirroredBetter } })),
  rejected: res.debug.rejected, program: stepsToText(prog.steps), ok: prog.ok, reasons: prog.reasons,
};
await writeFile(join(outDir, 'result.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, pieces: summary.pieces.map((p) => `${p.id} ${p.type} ${p.status} L${p.L} W${p.W} ${p.dir || ''} ${p.reasons.join(',')}`) }, null, 1));
