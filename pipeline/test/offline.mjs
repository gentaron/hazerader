// Offline end-to-end test: builds a synthetic "world" with known physics, emits API-shaped
// fixtures, and runs the real pipeline for several consecutive days so that the archive,
// verification and online-learning paths are all exercised.
//   node test/offline.mjs            -> runs the test in a temp dir
//   node test/offline.mjs --demo     -> additionally writes site/data/forecast.json (demo:true)
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NWP_MODELS } from "../src/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(here, "../src/run.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hazerader-"));
const DAYS_SIM = 8;

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Align the simulation so the last simulated issue lands on the current date.
const start = Math.floor(Date.now() / 86400000) * 86400 - (92 + DAYS_SIM) * 86400;
const H = (92 + DAYS_SIM + 8) * 24;
const W = { time: [], ws: [], wd: [], ws850: [], wd850: [], rain: [], rh: [], t2m: [], blh: [], cloud: [], pm: [] };
let ar = 0, haze = 0;
for (let i = 0; i < H; i++) {
  const t = start + i * 3600, lh = (new Date((t + 8 * 3600) * 1000).getUTCHours());
  const day = Math.floor(i / 24);
  const sw = Math.sin(day / 6) > -0.2;                      // SW monsoon regimes
  const wd850 = sw ? 225 + 25 * gauss() : 60 + 30 * gauss();
  const ws850 = 4 + 2 * Math.abs(gauss());
  const ws = Math.max(0.3, 1.5 + 1.2 * Math.sin(((lh - 9) * Math.PI) / 12) + 0.5 * gauss());
  const blh = Math.max(80, 250 + 1100 * Math.max(0, Math.sin(((lh - 7) * Math.PI) / 12)) + 100 * gauss());
  const rain = lh >= 15 && lh <= 19 && rnd() < 0.25 ? 3 + 10 * rnd() : rnd() < 0.02 ? 2 * rnd() : 0;
  haze = 0.97 * haze + (sw && day % 17 < 6 ? 0.05 : 0);
  ar = 0.9 * ar + 0.1 * gauss();
  const vent = Math.log(ws * blh);
  const lpm = 2.9 - 0.35 * (vent - 6.3) - 0.25 * Math.log1p(rain) + 1.2 * haze + 0.4 * ar
    + (lh >= 7 && lh <= 9 ? 0.15 : 0) + 0.1 * gauss();
  W.time.push(t); W.ws.push(ws); W.wd.push((wd850 + 20 + 360) % 360); W.ws850.push(ws850); W.wd850.push((wd850 + 360) % 360);
  W.rain.push(rain); W.rh.push(70 + 20 * Math.cos(((lh - 5) * Math.PI) / 12)); W.t2m.push(27 + 5 * Math.sin(((lh - 9) * Math.PI) / 12));
  W.blh.push(blh); W.cloud.push(50 + 30 * gauss()); W.pm.push(Math.max(1, Math.exp(lpm) - 1));
}

async function writeFixtures(dir, nowIdx) {
  await fs.mkdir(dir, { recursive: true });
  const a = nowIdx - 92 * 24 - (nowIdx % 24), b = nowIdx - (nowIdx % 24) + 5 * 24 + 24;
  const time = W.time.slice(a, b);
  const fcNoise = (i, scale) => (i > nowIdx ? Math.exp(scale * Math.sqrt((i - nowIdx) / 48) * gauss() + 0.12) : 1);
  const aq = {
    hourly: {
      time,
      pm2_5: time.map((_, k) => +(W.pm[a + k] * fcNoise(a + k, 0.25)).toFixed(1)),
      pm10: time.map((_, k) => +(W.pm[a + k] * 1.45).toFixed(1)),
      ozone: time.map((t) => 40 + 50 * Math.max(0, Math.sin((((t / 3600 + 8) % 24 - 8) * Math.PI) / 10))),
      nitrogen_dioxide: time.map(() => 15 + 10 * rnd()), sulphur_dioxide: time.map(() => 4),
      carbon_monoxide: time.map(() => 300), aerosol_optical_depth: time.map((_, k) => +(0.2 + W.pm[a + k] / 80).toFixed(2)),
      dust: time.map(() => 0), uv_index: time.map((t) => Math.max(0, 11 * Math.sin((((t / 3600 + 8) % 24 - 7) * Math.PI) / 12))),
    },
  };
  const hourly = { time };
  NWP_MODELS.forEach((m, j) => {
    const nz = (i, s) => (i > nowIdx ? s * gauss() * Math.sqrt((i - nowIdx) / 24) : 0);
    hourly[`temperature_2m_${m}`] = time.map((_, k) => W.t2m[a + k] + nz(a + k, 0.5));
    hourly[`relative_humidity_2m_${m}`] = time.map((_, k) => W.rh[a + k]);
    hourly[`precipitation_${m}`] = time.map((_, k) => Math.max(0, W.rain[a + k] + nz(a + k, 1)));
    hourly[`wind_speed_10m_${m}`] = time.map((_, k) => Math.max(0.1, W.ws[a + k] + nz(a + k, 0.3)));
    hourly[`wind_direction_10m_${m}`] = time.map((_, k) => W.wd[a + k]);
    hourly[`boundary_layer_height_${m}`] = j === 0 ? time.map(() => null) : time.map((_, k) => W.blh[a + k] * (1 + nz(a + k, 0.1)));
    hourly[`wind_speed_850hPa_${m}`] = time.map((_, k) => W.ws850[a + k]);
    hourly[`wind_direction_850hPa_${m}`] = time.map((_, k) => W.wd850[a + k] + nz(a + k, 10));
    hourly[`cloud_cover_${m}`] = time.map((_, k) => W.cloud[a + k]);
  });
  await fs.writeFile(path.join(dir, "air_quality.json"), JSON.stringify(aq));
  await fs.writeFile(path.join(dir, "weather.json"), JSON.stringify({ hourly }));
  await fs.writeFile(path.join(dir, "waqi.json"), JSON.stringify({
    status: "ok", data: { aqi: 70, city: { name: "Putrajaya (synthetic)", geo: [2.9166, 101.6917] },
      time: { iso: new Date((W.time[nowIdx - 1]) * 1000).toISOString() }, iaqi: { pm25: { v: 70 } } } }));
  await fs.writeFile(path.join(dir, "firms.csv"),
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
    + Array.from({ length: 120 }, () => `${(-1 + 3 * rnd()).toFixed(3)},${(101 + 3 * rnd()).toFixed(3)},330,0.4,0.4,2026-09-01,0600,N,VIIRS,n,2.0NRT,290,${(5 + 40 * rnd()).toFixed(1)},D`).join("\n"));
}

const env = { ...process.env, HZ_DATA: path.join(tmp, "data"), HZ_OUT: path.join(tmp, "site/forecast.json"), HZ_FORCE: "1" };
let out;
for (let d = 0; d < DAYS_SIM; d++) {
  const nowIdx = (92 + d) * 24 + 22 + 6;   // ~06:00 local
  const dir = path.join(tmp, `fx${d}`);
  await writeFixtures(dir, nowIdx);
  execFileSync("node", [RUN], { env: { ...env, HZ_MOCK_DIR: dir, HZ_NOW: String(W.time[nowIdx] + 60) }, stdio: "inherit" });
  out = JSON.parse(await fs.readFile(env.HZ_OUT, "utf8"));
}

const assert = (c, msg) => { if (!c) { console.error("FAIL:", msg); process.exit(1); } };
assert(out.daily.length >= 5, "5 daily forecasts");
assert(out.hourly.length >= 100, "hourly horizon");
assert(out.hourly.every((h) => h.p10 <= h.p50 && h.p50 <= h.p90), "quantiles ordered");
assert(out.daily.every((d) => d.aqi.value >= 0 && d.aqi.value <= 500), "AQI range");
assert(out.model.verifiedForecasts > 0, "verification ran");
const w = out.model.leadDayWeights[0].weights;
assert(Math.abs(w.cams + w.met + w.clim - 1) < 1e-9, "weights normalised");
console.log("\nHold-out skill:", out.model.holdoutSkill.map((s) => `${s.lead}h:${s.skillVsPersistence}`).join(" "));
console.log("Verification:", JSON.stringify(out.model.verification));
console.log("Day-1 weights:", JSON.stringify(w));
console.log("Haze day0:", JSON.stringify(out.daily[0].haze));
console.log("OK – offline pipeline test passed");

if (process.argv.includes("--demo")) {
  const demo = { ...out, demo: true };
  await fs.writeFile(path.join(here, "../../site/data/forecast.json"), JSON.stringify(demo));
  console.log("Wrote demo site/data/forecast.json");
}
