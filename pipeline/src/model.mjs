// HazeRadar forecasting engine.
//
// Three member families are blended in log space, per lead time:
//   1. CAMS  – ECMWF Copernicus atmospheric-composition forecast (physics + chemistry + emissions)
//   2. MET-x – direct multi-horizon ridge models (one per lead bucket) that learn how PM2.5 at
//              this location responds to ventilation, rain, humidity, monsoon flow, diurnal and
//              weekly cycles, driven separately by each NWP model (ECMWF / GFS / ICON)
//   3. CLIM  – damped persistence with a learned diurnal profile
// Blend weights are inverse-MSE, combining hold-out skill with an online, exponentially
// weighted verification record that grows every day (state.json).
import {
  LEAD_BUCKETS, HOLDOUT_DAYS, RIDGE_LAMBDAS, PRIOR_PSEUDO_COUNT, localHour, localDow,
} from "./config.mjs";
import { fitRidge, mean, rmse } from "./linalg.mjs";

const L1 = (x) => Math.log(Math.max(0, x) + 1);
const E1 = (x) => Math.max(0, Math.exp(x) - 1);
const DEG = Math.PI / 180;

export const FEATURE_NAMES = [
  "直近24h PM2.5水準", "PM2.5トレンド", "大気の換気能 (混合層高×風速)", "6時間降水量", "相対湿度",
  "気温", "地上風 東西成分", "地上風 南北成分", "850hPa風 東西成分", "850hPa風 南北成分", "雲量",
  "日周期 sin", "日周期 cos", "半日周期 sin", "半日周期 cos", "週末",
];

function fillSeries(arr, n) {
  const out = new Array(n).fill(null);
  const vals = arr.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  let last = null;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v != null && Number.isFinite(v)) { out[i] = v; last = v; } else out[i] = last ?? med;
  }
  return out;
}

// Map one NWP model's variables onto the air-quality timeline and derive physical predictors.
function deriveMet(aqTime, wxTime, vars) {
  const n = aqTime.length;
  const idx = new Map(wxTime.map((t, i) => [t, i]));
  const pick = (name) => fillSeries(aqTime.map((t) => (vars[name] ? vars[name][idx.get(t)] ?? null : null)), n);
  const ws10 = pick("wind_speed_10m"), wd10 = pick("wind_direction_10m");
  const ws850 = pick("wind_speed_850hPa"), wd850 = pick("wind_direction_850hPa");
  const blhRaw = pick("boundary_layer_height");
  const rain = pick("precipitation"), rh = pick("relative_humidity_2m"), t2m = pick("temperature_2m");
  const cloud = pick("cloud_cover");
  const hasBlh = !!vars.boundary_layer_height;
  const d = { ws10, wd10, ws850, wd850, rain, rh, t2m, cloud, blh: hasBlh ? blhRaw : null };
  d.u10 = ws10.map((s, i) => (s == null ? 0 : -s * Math.sin(wd10[i] * DEG)));
  d.v10 = ws10.map((s, i) => (s == null ? 0 : -s * Math.cos(wd10[i] * DEG)));
  d.u850 = ws850.map((s, i) => (s == null ? 0 : -s * Math.sin(wd850[i] * DEG)));
  d.v850 = ws850.map((s, i) => (s == null ? 0 : -s * Math.cos(wd850[i] * DEG)));
  d.logVent = ws10.map((s, i) => Math.log(Math.max(s ?? 1, 0.3) * Math.max(hasBlh ? blhRaw[i] ?? 600 : 600, 50)));
  d.rain6 = rain.map((_, i) => {
    let s = 0;
    for (let k = Math.max(0, i - 5); k <= i; k++) s += rain[k] ?? 0;
    return Math.log1p(s);
  });
  return d;
}

function anchorAt(lpm, e) {
  if (e < 23) return null;
  const w = [];
  for (let k = e - 23; k <= e; k++) if (lpm[k] != null) w.push(lpm[k]);
  return w.length >= 18 ? mean(w) : null;
}

function featureRow(t, e, lpm, met, time) {
  const a = anchorAt(lpm, e), aPrev = anchorAt(lpm, e - 24);
  if (a == null || aPrev == null) return null;
  const h = localHour(time[t]), dow = localDow(time[t]);
  return [
    a, a - aPrev, met.logVent[t], met.rain6[t], (met.rh[t] ?? 80) / 100, met.t2m[t] ?? 28,
    met.u10[t], met.v10[t], met.u850[t], met.v850[t], (met.cloud[t] ?? 50) / 100,
    Math.sin((2 * Math.PI * h) / 24), Math.cos((2 * Math.PI * h) / 24),
    Math.sin((4 * Math.PI * h) / 24), Math.cos((4 * Math.PI * h) / 24),
    dow === 0 || dow === 6 ? 1 : 0,
  ];
}

// Diurnal anomaly profile in log space over the last `days` of analysis.
function diurnalProfile(lpm, time, n0, days = 30) {
  const sum = new Array(24).fill(0), cnt = new Array(24).fill(0);
  for (let t = Math.max(24, n0 - days * 24); t <= n0; t++) {
    const a = anchorAt(lpm, t + 11 > n0 ? n0 : t + 11);
    if (lpm[t] == null || a == null) continue;
    const h = localHour(time[t]);
    sum[h] += lpm[t] - a; cnt[h]++;
  }
  return sum.map((s, h) => (cnt[h] ? s / cnt[h] : 0));
}

function climPredict(lpm, time, e, t, profile, longMean) {
  const a = anchorAt(lpm, e);
  if (a == null) return null;
  const L = t - e;
  const level = a + (longMean - a) * (1 - Math.exp(-L / 72));
  return level + profile[localHour(time[t])];
}

function interpBuckets(L, valuesByBucket) {
  if (L <= LEAD_BUCKETS[0]) return valuesByBucket[0];
  for (let b = 1; b < LEAD_BUCKETS.length; b++) {
    if (L <= LEAD_BUCKETS[b]) {
      const w = (L - LEAD_BUCKETS[b - 1]) / (LEAD_BUCKETS[b] - LEAD_BUCKETS[b - 1]);
      return valuesByBucket[b - 1] * (1 - w) + valuesByBucket[b] * w;
    }
  }
  return valuesByBucket.at(-1);
}

export function runModel({ aq, wx, nowSec, state }) {
  const time = aq.time;
  const n = time.length;
  let n0 = 0;
  for (let i = 0; i < n; i++) if (time[i] <= nowSec) n0 = i;
  const lpm = aq.pm2_5.map((v, i) => (i <= n0 && v != null ? L1(v) : null));
  const camsL = aq.pm2_5.map((v) => (v != null ? L1(v) : null));
  const holdoutStart = nowSec - HOLDOUT_DAYS * 86400;

  const profile = diurnalProfile(lpm, time, n0);
  const longWin = lpm.slice(Math.max(0, n0 - 60 * 24), n0 + 1).filter((v) => v != null);
  const longMean = mean(longWin);

  const metByModel = Object.fromEntries(
    Object.entries(wx.models).map(([m, vars]) => [m, deriveMet(time, wx.time, vars)]));
  const modelNames = Object.keys(metByModel);
  if (!modelNames.length) throw new Error("No NWP model data available");

  // ---- Train one ridge model per (NWP model, lead bucket) ----
  const fits = {};          // fits[m][b] = { model, lambda, valRmse }
  const bucketStats = [];   // per bucket: validation RMSEs for clim, persistence, met(avg)
  for (const m of modelNames) {
    fits[m] = [];
    LEAD_BUCKETS.forEach((L, b) => {
      const Xtr = [], ytr = [], Xva = [], yva = [], climVa = [], persVa = [];
      for (let t = 48 + L; t <= n0; t++) {
        if (lpm[t] == null) continue;
        const e = t - L;
        const row = featureRow(t, e, lpm, metByModel[m], time);
        if (!row) continue;
        if (time[t] >= holdoutStart) {
          Xva.push(row); yva.push(lpm[t]);
          climVa.push(climPredict(lpm, time, e, t, profile, longMean) ?? row[0]);
          persVa.push(row[0]);
        } else { Xtr.push(row); ytr.push(lpm[t]); }
      }
      let best = { lambda: 1, val: Infinity };
      if (Xtr.length > 50 && Xva.length > 24) {
        for (const lam of RIDGE_LAMBDAS) {
          const f = fitRidge(Xtr, ytr, lam);
          const r = rmse(Xva.map(f.predict), yva);
          if (r < best.val) best = { lambda: lam, val: r };
        }
      }
      const all = Xtr.concat(Xva), yall = ytr.concat(yva);
      const model = fitRidge(all, yall, best.lambda);
      fits[m][b] = { model, lambda: best.lambda, valRmse: Number.isFinite(best.val) ? best.val : 0.35 };
      if (m === modelNames[0]) {
        bucketStats[b] = {
          lead: L, nTrain: Xtr.length, nVal: Xva.length,
          climRmse: yva.length ? rmse(climVa, yva) : 0.35,
          persRmse: yva.length ? rmse(persVa, yva) : 0.4,
        };
      }
    });
  }
  LEAD_BUCKETS.forEach((_, b) => {
    bucketStats[b].metRmse = mean(modelNames.map((m) => fits[m][b].valRmse));
    bucketStats[b].lambda = fits[modelNames[0]][b].lambda;
  });

  // ---- Blend weights per lead day: prior (hold-out skill) + online verification record ----
  const leadDayWeights = [];
  for (let d = 1; d <= 5; d++) {
    const L = Math.min(120, 24 * d);
    const val = (key) => interpBuckets(L, bucketStats.map((s) => s[key]));
    const prior = {
      // Before any verification history exists, CAMS is assumed as skilful as the best statistical member.
      cams: Math.min(val("metRmse"), val("climRmse")) ** 2,
      met: val("metRmse") ** 2,
      clim: val("climRmse") ** 2,
    };
    const online = state?.members?.[`d${d}`] ?? {};
    const w = {}, mse = {};
    for (const k of Object.keys(prior)) {
      const o = online[k];
      const nObs = o?.n ?? 0;
      mse[k] = (PRIOR_PSEUDO_COUNT * prior[k] + Math.min(nObs, 60) * (o?.mse ?? prior[k])) / (PRIOR_PSEUDO_COUNT + Math.min(nObs, 60));
      w[k] = 1 / Math.max(mse[k], 1e-4);
    }
    const s = Object.values(w).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(w)) w[k] /= s;
    leadDayWeights.push({ day: d, weights: w, mse, nVerified: Math.max(0, ...Object.values(online).map((o) => o?.n ?? 0)) });
  }

  // ---- Forecast ----
  const sigmaScale = state?.sigmaScale ?? 1;
  const bias = state?.stationBiasLog ?? 0; // learned from ground-station observations, log space
  const hourly = [];
  for (let t = n0 + 1; t < n; t++) {
    if (camsL[t] == null) continue;
    const L = t - n0;
    const dIdx = Math.min(4, Math.floor((L - 1) / 24));
    const { weights, mse } = leadDayWeights[dIdx];
    const metPreds = modelNames.map((m) => {
      const row = featureRow(t, n0, lpm, metByModel[m], time);
      return row ? interpBuckets(L, fits[m].map((f) => f.model.predict(row))) : null;
    }).filter((v) => v != null);
    const met = metPreds.length ? mean(metPreds) : camsL[t];
    const clim = climPredict(lpm, time, n0, t, profile, longMean) ?? camsL[t];
    const cams = camsL[t];
    const mu = weights.cams * cams + weights.met * met + weights.clim * clim + bias;
    const members = [cams, ...metPreds, clim];
    const mm = mean(members);
    const spread = Math.sqrt(mean(members.map((x) => (x - mm) ** 2)));
    const mseBlend = weights.cams * mse.cams + weights.met * mse.met + weights.clim * mse.clim;
    const sigma = Math.max(0.1, sigmaScale * Math.sqrt(0.8 * mseBlend + 0.5 * spread ** 2));
    const metAvg = (k) => mean(modelNames.map((m) => metByModel[m][k][t] ?? 0));
    hourly.push({
      t: time[t], lead: L, mu, sigma,
      p10: E1(mu - 1.2816 * sigma), p50: E1(mu), p90: E1(mu + 1.2816 * sigma),
      members: {
        cams: E1(cams), clim: E1(clim),
        ...Object.fromEntries(modelNames.map((m, i) => [`met_${m}`, metPreds[i] != null ? E1(metPreds[i]) : null])),
      },
      memberLog: { cams, met, clim },
      pm10Cams: aq.pm10[t], o3: aq.ozone[t], no2: aq.nitrogen_dioxide[t], so2: aq.sulphur_dioxide[t],
      co: aq.carbon_monoxide[t], aod: aq.aerosol_optical_depth[t], dust: aq.dust[t], uv: aq.uv_index[t],
      pm25Cams: aq.pm2_5[t],
      wind10: Math.hypot(metAvg("u10"), metAvg("v10")), u850: metAvg("u850"), v850: metAvg("v850"),
      u10: metAvg("u10"), v10: metAvg("v10"),
      rain: mean(modelNames.map((m) => metByModel[m].rain[t] ?? 0)), rh: metAvg("rh"), t2m: metAvg("t2m"),
      blh: (() => { const b = modelNames.map((m) => metByModel[m].blh?.[t]).filter((v) => v != null); return b.length ? mean(b) : null; })(),
    });
  }

  // Driver attribution for the next 24 h (standardised ridge contributions, first NWP model)
  const b24 = LEAD_BUCKETS.indexOf(24);
  const f24 = fits[modelNames[0]][b24].model;
  const contrib = new Array(FEATURE_NAMES.length).fill(0);
  let cnt = 0;
  for (let t = n0 + 1; t <= Math.min(n - 1, n0 + 24); t++) {
    const row = featureRow(t, n0, lpm, metByModel[modelNames[0]], time);
    if (!row) continue;
    row.forEach((v, j) => { contrib[j] += f24.beta[j] * ((v - f24.mu[j]) / f24.sd[j]); });
    cnt++;
  }
  const drivers = FEATURE_NAMES.map((name, j) => ({ name, effect: cnt ? contrib[j] / cnt : 0 }))
    .filter((d) => !/周期|週末/.test(d.name))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 5)
    .map((d) => ({ ...d, pctEffect: Math.round((Math.exp(d.effect) - 1) * 100) }));

  // Recent analysis for context (last 72 h)
  const recent = [];
  for (let t = Math.max(0, n0 - 71); t <= n0; t++) {
    recent.push({ t: time[t], pm25: aq.pm2_5[t], pm10: aq.pm10[t], o3: aq.ozone[t], no2: aq.nitrogen_dioxide[t] });
  }

  return {
    issueTime: time[n0], hourly, recent, drivers, leadDayWeights, modelNames, sigmaScale, stationBiasLog: bias,
    skill: bucketStats.map((s) => ({
      lead: s.lead, nTrain: s.nTrain, nVal: s.nVal, lambda: s.lambda,
      metRmse: +s.metRmse.toFixed(3), climRmse: +s.climRmse.toFixed(3), persRmse: +s.persRmse.toFixed(3),
      skillVsPersistence: +(1 - (s.metRmse / s.persRmse) ** 2).toFixed(3),
    })),
    analysis: { pm25: aq.pm2_5[n0], pm10: aq.pm10[n0], o3: aq.ozone[n0], no2: aq.nitrogen_dioxide[n0], t: time[n0], lpmSeries: lpm, time },
  };
}
