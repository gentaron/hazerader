// Daily pipeline entry point: fetch → verify yesterday's forecasts → train → forecast → AI briefing → publish.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE, localDate, localHour } from "./config.mjs";
import { fetchAirQuality, fetchWeather, fetchStation, fetchFires } from "./fetchers.mjs";
import { runModel } from "./model.mjs";
import { subIndex, category, ugToPpb } from "./aqi.mjs";
import { normCdf } from "./linalg.mjs";
import { dailyHaze, monsoonPhase, fireSummary } from "./haze.mjs";
import { loadState, truthByDate, updateStationBias, verifyArchive, skillSummary } from "./verify.mjs";
import { writeNarrative } from "./narrative.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.env.HZ_OUT ?? path.join(ROOT, "site/data/forecast.json");
const DATA = process.env.HZ_DATA ?? path.join(ROOT, "data");
const STATE_FILE = path.join(DATA, "state.json");
const ARCHIVE = path.join(DATA, "archive");

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const L1 = (x) => Math.log(Math.max(0, x) + 1);

async function main() {
  const nowSec = Number(process.env.HZ_NOW ?? Math.floor(Date.now() / 1000));
  const today = localDate(nowSec);

  // Once-per-day guard: the published forecast is only regenerated once per local day.
  if (!process.env.HZ_FORCE) {
    try {
      const prev = JSON.parse(await fs.readFile(OUT, "utf8"));
      if (prev.issueDate === today && !prev.demo) {
        console.log(`Forecast for ${today} already issued at ${prev.generatedAt}; skipping.`);
        return;
      }
    } catch { /* first run */ }
  }

  console.log(`[${new Date(nowSec * 1000).toISOString()}] fetching data for ${SITE.name}`);
  const [aq, wx, station, fires] = await Promise.all([fetchAirQuality(), fetchWeather(), fetchStation(), fetchFires()]);
  console.log(`  CAMS hours: ${aq.time.length}, NWP models: ${Object.keys(wx.models).join(", ")}`
    + `, station: ${station?.station ?? "none"}, fires: ${fires?.length ?? "n/a"}`);

  const state = await loadState(STATE_FILE);
  updateStationBias(state, station, aq);

  const result = runModel({ aq, wx, nowSec, state });
  await verifyArchive(state, ARCHIVE, truthByDate(result.analysis.lpmSeries, result.analysis.time));

  // ---- Daily aggregation (local time) ----
  const month = Number(today.slice(5, 7));
  const byDate = new Map();
  for (const h of result.hourly) {
    const d = localDate(h.t);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(h);
  }
  const todaysAnalysis = result.recent.filter((r) => localDate(r.t) === today && r.pm25 != null);
  const n0 = result.analysis.time.indexOf(result.issueTime);
  const persistLog = avg(result.analysis.lpmSeries.slice(n0 - 23, n0 + 1).filter((v) => v != null));
  const daily = [];
  for (const [date, hrs] of byDate) {
    const lead = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
    if (hrs.length < 20 && date !== today) continue;
    if (daily.length >= 5) break;
    const obsPart = date === today ? todaysAnalysis.map((r) => r.pm25) : [];
    const pm25Hours = [...obsPart, ...hrs.map((h) => h.p50)];
    const center = avg(pm25Hours);
    const fcFrac = hrs.length / pm25Hours.length;
    const sigmaD = Math.max(0.08, avg(hrs.map((h) => h.sigma)) * 0.8 * Math.sqrt(fcFrac));
    const lc = L1(center);
    const probOver = (thr) => +(1 - normCdf((L1(thr) - lc) / sigmaD)).toFixed(3);
    const ratio = (h) => (h.pm25Cams > 0 ? Math.min(2, Math.max(0.5, h.p50 / h.pm25Cams)) : 1);
    const pm10 = avg([...(date === today ? todaysAnalysis.map((r) => r.pm10 ?? 0) : []), ...hrs.map((h) => (h.pm10Cams ?? 0) * ratio(h))]);
    const o3h = hrs.map((h) => h.o3 ?? 0);
    let o3max8 = 0;
    for (let i = 0; i + 8 <= o3h.length; i++) o3max8 = Math.max(o3max8, avg(o3h.slice(i, i + 8)));
    if (o3h.length < 8) o3max8 = avg(o3h);
    const no2max = Math.max(...hrs.map((h) => h.no2 ?? 0));
    const sub = {
      pm25: subIndex("pm25_24h", center),
      pm10: subIndex("pm10_24h", pm10),
      o3: subIndex("o3_8h_ppb", ugToPpb.o3(o3max8)),
      no2: subIndex("no2_1h_ppb", ugToPpb.no2(no2max)),
    };
    const [dominant, value] = Object.entries(sub).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
    const cat = category(value);
    const mLog = (k) => avg(hrs.map((h) => h.memberLog[k]));
    daily.push({
      date, lead, partial: date === today, hoursForecast: hrs.length,
      pm25: {
        p10: r1(center * Math.exp(-1.2816 * sigmaD)), p50: r1(center), p90: r1(center * Math.exp(1.2816 * sigmaD)),
        probOver35: probOver(35.4), probOver55: probOver(55.4), cams: r1(avg(hrs.map((h) => h.pm25Cams ?? 0))),
      },
      pm10: r1(pm10), o3_8hmax: r1(o3max8), no2_1hmax: r1(no2max),
      aqi: { value, category: cat.ja, key: cat.key, color: cat.color, dominant, sub },
      aqiRange: { low: subIndex("pm25_24h", center * Math.exp(-1.2816 * sigmaD)), high: subIndex("pm25_24h", center * Math.exp(1.2816 * sigmaD)) },
      uvMax: r1(Math.max(...hrs.map((h) => h.uv ?? 0))),
      rainTotal: r1(hrs.reduce((s, h) => s + (h.rain ?? 0), 0)),
      windMean: r1(avg(hrs.map((h) => h.wind10))),
      tMax: r1(Math.max(...hrs.map((h) => h.t2m ?? 0))), tMin: r1(Math.min(...hrs.map((h) => h.t2m ?? 99))),
      haze: dailyHaze({ dayHours: hrs, month, fires }),
      _archive: {
        lead, sigmaRaw: sigmaD / (result.sigmaScale || 1),
        log: { cams: mLog("cams"), met: mLog("met"), clim: mLog("clim"),
          blend: avg(hrs.map((h) => h.mu)) - result.stationBiasLog,
          persistence: persistLog },
      },
    });
  }

  // Cleanest 3-hour window during daytime (07–19 local) within the next 36 h
  let bestWindow = null;
  const day = result.hourly.slice(0, 36).filter((h) => { const lh = localHour(h.t); return lh >= 7 && lh <= 19; });
  for (let i = 0; i + 3 <= day.length; i++) {
    const seg = day.slice(i, i + 3);
    if (seg[2].t - seg[0].t !== 7200) continue;
    const m = avg(seg.map((h) => h.p50));
    if (!bestWindow || m < bestWindow.pm25) {
      const fmt = (t) => `${localDate(t) === today ? "今日" : "明日"} ${String(localHour(t)).padStart(2, "0")}:00`;
      bestWindow = { from: fmt(seg[0].t), to: fmt(seg[2].t + 3600), pm25: r1(m) };
    }
  }

  const season = monsoonPhase(month);
  const skill = skillSummary(state);
  const current = {
    t: result.analysis.t,
    pm25: r1(result.analysis.pm25 * Math.exp(result.stationBiasLog)),
    aqi: subIndex("pm25_24h", avg(result.recent.slice(-24).map((r) => r.pm25 ?? 0)) * Math.exp(result.stationBiasLog)),
    station: state.lastStation ?? null,
  };

  const briefingInput = {
    location: SITE.name, issueDate: today, season, current, bestWindow,
    daily: daily.map(({ _archive, ...d }) => d),
    drivers: result.drivers, blendWeights: result.leadDayWeights.map((w) => ({ day: w.day, weights: w.weights })),
    verification: skill, fires: fireSummary(fires),
    notes: "Truth for training/verification is the CAMS analysis unless a ground station is configured.",
  };
  const narrative = await writeNarrative(briefingInput);

  const output = {
    version: 1, demo: !!process.env.HZ_DEMO, generatedAt: new Date(nowSec * 1000).toISOString(), issueDate: today,
    location: { name: SITE.name, lat: SITE.lat, lon: SITE.lon, tz: SITE.tz },
    current, season, bestWindow, narrative,
    daily: briefingInput.daily,
    hourly: result.hourly.map((h) => ({
      t: h.t, p10: r1(h.p10), p50: r1(h.p50), p90: r1(h.p90), cams: r1(h.pm25Cams),
      members: Object.fromEntries(Object.entries(h.members).map(([k, v]) => [k, r1(v)])),
      aqi: subIndex("pm25_24h", h.p50), pm10: r1((h.pm10Cams ?? 0) * (h.pm25Cams > 0 ? h.p50 / h.pm25Cams : 1)),
      o3: r1(h.o3), no2: r1(h.no2), uv: r1(h.uv), rain: r1(h.rain), wind: r1(h.wind10), rh: Math.round(h.rh),
      t2m: r1(h.t2m), blh: h.blh != null ? Math.round(h.blh) : null,
    })),
    recent: result.recent.map((r) => ({ t: r.t, pm25: r1(r.pm25) })),
    model: {
      nwp: result.modelNames, drivers: result.drivers, leadDayWeights: result.leadDayWeights,
      holdoutSkill: result.skill, sigmaScale: result.sigmaScale, stationBiasLog: result.stationBiasLog,
      verification: skill, verifiedForecasts: state.log.length,
    },
    fires: fireSummary(fires),
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(output));
  if (!process.env.HZ_DEMO) {
    await fs.mkdir(ARCHIVE, { recursive: true });
    await fs.writeFile(path.join(ARCHIVE, `${today}.json`), JSON.stringify({
      issueDate: today, issueTime: result.issueTime, days: daily.map((d) => ({ date: d.date, ...d._archive })),
    }));
    const old = (await fs.readdir(ARCHIVE)).filter((f) => f.endsWith(".json")).sort().slice(0, -20);
    await Promise.all(old.map((f) => fs.rm(path.join(ARCHIVE, f))));
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1));
  }
  const d0 = daily[0];
  console.log(`Issued ${today}: AQI ${d0.aqi.value} (${d0.aqi.category}), PM2.5 ${d0.pm25.p50} µg/m³`
    + ` [${d0.pm25.p10}–${d0.pm25.p90}], narrative: ${narrative.source}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
