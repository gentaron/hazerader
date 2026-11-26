// Minimal ridge regression with feature standardisation (no dependencies).

function cholSolve(A, b) {
  const n = A.length;
  const L = A.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i][j] = s / L[j][j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function fitRidgeRaw(X, y, lambda) {
  const n = X.length, p = X[0].length;
  const ym = mean(y);
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let r = 0; r < n; r++) {
    const yr = y[r] - ym;
    for (let i = 0; i < p; i++) {
      b[i] += X[r][i] * yr;
      for (let j = 0; j <= i; j++) A[i][j] += X[r][i] * X[r][j];
    }
  }
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < i; j++) A[j][i] = A[i][j];
    A[i][i] += lambda * n;
  }
  const beta = cholSolve(A, b);
  return (x) => ym + beta.reduce((s, v, j) => s + v * x[j], 0);
}

function principalComponents(Z) {
  const n = Z.length, p = Z[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p));
  for (const z of Z) for (let i = 0; i < p; i++) for (let j = i; j < p; j++) {
    A[i][j] += (z[i] * z[j]) / n;
    if (i !== j) A[j][i] = A[i][j];
  }
  const V = Array.from({ length: p }, (_, i) =>
    Float64Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) off += A[i][j] ** 2;
    if (off < 1e-18) break;
    for (let q = 1; q < p; q++) for (let i = 0; i < q; i++) {
      const apq = A[i][q];
      if (Math.abs(apq) < 1e-14) continue;
      const theta = (A[q][q] - A[i][i]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(1 + t * t), s = t * c;
      const app = A[i][i], aqq = A[q][q];
      for (let k = 0; k < p; k++) {
        if (k !== i && k !== q) {
          const aki = A[k][i], akq = A[k][q];
          A[k][i] = A[i][k] = c * aki - s * akq;
          A[k][q] = A[q][k] = s * aki + c * akq;
        }
        const vki = V[k][i], vkq = V[k][q];
        V[k][i] = c * vki - s * vkq;
        V[k][q] = s * vki + c * vkq;
      }
      A[i][i] = app - t * apq;
      A[q][q] = aqq + t * apq;
      A[i][q] = A[q][i] = 0;
    }
  }
  return { values: Array.from({ length: p }, (_, i) => Math.max(0, A[i][i])), vectors: V };
}

export function fitTargetAwarePca(X, y, k, targetAware = true, lambda = 0.1) {
  const n = X.length, p = X[0].length;
  const mu = new Float64Array(p), sd = new Float64Array(p);
  for (const row of X) for (let j = 0; j < p; j++) mu[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < p; j++) sd[j] += (row[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((row) => Float64Array.from(row, (v, j) => (v - mu[j]) / sd[j]));
  const { values, vectors } = principalComponents(Z);
  const ym = mean(y), ys = Math.sqrt(mean(y.map((v) => (v - ym) ** 2))) || 1;
  const scores = Z.map((z) => values.map((_, c) => {
    let sum = 0;
    for (let j = 0; j < p; j++) sum += z[j] * vectors[j][c];
    return sum;
  }));
  const weights = values.map((_, c) => {
    if (!targetAware) return 1;
    const sm = mean(scores.map((r) => r[c]));
    let cov = 0, ss = 0;
    for (let r = 0; r < n; r++) {
      const a = scores[r][c] - sm;
      cov += (a * (y[r] - ym)) / ys;
      ss += a * a;
    }
    return ss > 1e-12 ? Math.abs(cov) / (Math.sqrt(ss) * Math.sqrt(n)) : 0;
  });
  const components = values.map((v, c) => ({ c, rank: targetAware ? v * weights[c] ** 2 : v }))
    .sort((a, b) => b.rank - a.rank).slice(0, Math.min(k, p)).map((o) => o.c);
  const transform = (rows) => rows.map((row) => {
    const z = new Float64Array(p);
    for (let j = 0; j < p; j++) z[j] = (row[j] - mu[j]) / sd[j];
    return Float64Array.from(components, (c) => {
      let sum = 0;
      for (let j = 0; j < p; j++) sum += z[j] * vectors[j][c];
      return sum * weights[c];
    });
  });
  const fit = fitRidgeRaw(transform(X), y, lambda);
  return { predict: (row) => fit(transform([row])[0]), weights, components };
}

export function fitRidge(X, y, lambda) {
  const n = X.length, p = X[0].length;
  const mu = new Float64Array(p), sd = new Float64Array(p);
  for (const row of X) for (let j = 0; j < p; j++) mu[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < p; j++) sd[j] += (row[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let r = 0; r < n; r++) {
    const z = X[r].map((v, j) => (v - mu[j]) / sd[j]);
    const yr = y[r] - ym;
    for (let i = 0; i < p; i++) {
      b[i] += z[i] * yr;
      for (let j = 0; j <= i; j++) A[i][j] += z[i] * z[j];
    }
  }
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < i; j++) A[j][i] = A[i][j];
    A[i][i] += lambda * n;
  }
  const beta = cholSolve(A, b);
  return {
    predict: (x) => ym + x.reduce((s, v, j) => s + beta[j] * ((v - mu[j]) / sd[j]), 0),
    beta: Array.from(beta), mu: Array.from(mu), sd: Array.from(sd), intercept: ym,
  };
}

export const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
export const rmse = (pred, obs) => Math.sqrt(mean(pred.map((p, i) => (p - obs[i]) ** 2)));

// Standard normal CDF (Abramowitz–Stegun 7.1.26)
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
