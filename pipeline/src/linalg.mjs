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
