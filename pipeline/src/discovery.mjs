const MIN_ROWS = 40;
const Z_CRIT = 2.0;
const ok = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (r) => Math.max(-0.999, Math.min(0.999, r));

function shift(values, lag) {
  const out = new Array(values.length).fill(NaN);
  for (let t = lag; t < values.length; t++) if (ok(values[t - lag])) out[t] = values[t - lag];
  return out;
}

function corrMatrix(cols) {
  const p = cols.length, m = Array.from({ length: p }, () => new Float64Array(p));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      const a = cols[i], b = cols[j], n = a.length;
      let sa = 0, sb = 0;
      for (let r = 0; r < n; r++) { sa += a[r]; sb += b[r]; }
      const ma = sa / n, mb = sb / n;
      let cov = 0, va = 0, vb = 0;
      for (let r = 0; r < n; r++) {
        const da = a[r] - ma, db = b[r] - mb;
        cov += da * db; va += da * da; vb += db * db;
      }
      m[i][j] = m[j][i] = va > 1e-12 && vb > 1e-12 ? clamp(cov / Math.sqrt(va * vb)) : 0;
    }
  }
  return m;
}

function inverse(m) {
  const p = m.length;
  const a = m.map((row, i) => Float64Array.from([...row, ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]));
  for (let i = 0; i < p; i++) {
    let pivot = i;
    for (let k = i + 1; k < p; k++) if (Math.abs(a[k][i]) > Math.abs(a[pivot][i])) pivot = k;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const d = a[i][i] || 1e-12;
    for (let j = 0; j < 2 * p; j++) a[i][j] /= d;
    for (let k = 0; k < p; k++) {
      if (k === i) continue;
      const f = a[k][i];
      for (let j = 0; j < 2 * p; j++) a[k][j] -= f * a[i][j];
    }
  }
  return a.map((row) => row.slice(p));
}

export function discoveryItpdParents(series, candidates, maxParents = 5) {
  if (!Array.isArray(series) || series.length < MIN_ROWS) return [];
  const n = series.length;
  const items = [{ name: "y_lag1", values: series, lag: 1 },
    ...(Array.isArray(candidates) ? candidates : []).filter((c) => c && c.name && Array.isArray(c.values))
      .map((c) => ({ name: c.name, values: c.values, lag: Math.max(1, Number(c.lag) || 1) }))];
  const vars = items.filter((v) => v.values.length === n);
  const shifted = vars.map((v) => shift(v.values, v.lag));
  const coverage = shifted.map((col) => col.reduce((s, v, t) => s + (ok(v) && ok(series[t]) ? 1 : 0), 0));
  const active = coverage.map((c, j) => (j === 0 || c >= Math.max(MIN_ROWS, 0.8 * coverage[0]) ? j : -1)).filter((j) => j >= 0);
  const rows = [];
  for (let t = 0; t < n; t++) if (ok(series[t]) && active.every((j) => ok(shifted[j][t]))) rows.push(t);
  if (rows.length < MIN_ROWS || active.length < 2) return [vars[0].name];
  const cols = new Map(active.map((j, k) => [vars[j].name, rows.map((t) => shifted[j][t])]));
  const names = active.slice(1).map((j) => vars[j].name);
  const score = (subset) => {
    const sub = [cols.get(vars[0].name), ...subset.map((nm) => cols.get(nm))];
    const p = inverse(corrMatrix(sub));
    return subset.map((nm, k) => {
      const r = clamp(-p[0][k + 1] / Math.sqrt(Math.max(1e-12, p[0][0] * p[k + 1][k + 1])));
      const z = 0.5 * Math.log((1 + r) / (1 - r)) * Math.sqrt(Math.max(1, rows.length - sub.length - 3));
      return { name: nm, z: Math.abs(z) };
    });
  };
  let selected = score(names).filter((s) => s.z > Z_CRIT).sort((a, b) => b.z - a.z)
    .slice(0, Math.max(0, maxParents)).map((s) => s.name);
  for (let pass = 0; pass < selected.length; pass++) {
    const before = selected.length;
    selected = score(selected).filter((s) => s.z > Z_CRIT).map((s) => s.name);
    if (selected.length === before) break;
  }
  return [vars[0].name, ...selected];
}
