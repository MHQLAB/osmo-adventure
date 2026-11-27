// محرك تنفيذ أوامر بسيط للاختبار: شبكة وروبوت. منفصل عن الرؤية والرسوميات. وحدة صرفة.
// دلالات التكرار والدوال والسحر غير مؤكدة بعد مقابل ألعاب Osmo — تُسجَّل كخطوات «غير مدعومة».

const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

export function runProgram(steps, { cols = 7, rows = 5, start = [3, 2], walls = [] } = {}) {
  const wallSet = new Set(walls.map(([x, y]) => `${x},${y}`));
  let [x, y] = start; const trace = [{ x, y, step: 0, event: 'start' }]; const issues = [];
  const inside = (a, b) => a >= 0 && b >= 0 && a < cols && b < rows && !wallSet.has(`${a},${b}`);
  steps.forEach((s, i) => {
    const n = Math.max(1, s.count || 1);
    if (s.type === 'walk' || s.type === 'jump') {
      const [dx, dy] = D[s.dir] || [0, 0];
      const len = s.type === 'jump' ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const nx = x + dx * len, ny = y + dy * len;
        if (!inside(nx, ny)) { issues.push({ step: i + 1, kind: 'blocked' }); trace.push({ x, y, step: i + 1, event: 'bump' }); break; }
        x = nx; y = ny; trace.push({ x, y, step: i + 1, event: s.type });
      }
    } else if (s.type === 'hand' || s.type === 'rest') {
      for (let k = 0; k < n; k++) trace.push({ x, y, step: i + 1, event: s.type, dir: s.dir });
    } else {
      issues.push({ step: i + 1, kind: 'unsupported', type: s.type });
    }
  });
  return { end: [x, y], trace, issues };
}
