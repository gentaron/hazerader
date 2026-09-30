// Self-verification and online learning.
// Every issued forecast is archived; once its target day has passed, it is scored against the
// best available truth (ground station if configured, otherwise the CAMS re-analysis) and the
// per-member error statistics / uncertainty calibration in state.json are updated.
import fs from "node:fs/promises";
import path from "node:path";
import { EW_ALPHA, localDate } from "./config.mjs";
import { legacyPm25AqiToConc } from "./aqi.mjs";

const MAX_STATION_KM = 40;
const L1 = (x) => Math.log(Math.max(0, x) + 1);
const E1 = (x) => Math.max(0, Math.exp(x) - 1);
const ew = (old, x, n) => (old == null || n === 0 ? x : old + EW_ALPHA * (x - old));

export async function loadState(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch {
    return { version: 1, members: {}, verified: [], log: [], sigmaScale: 1, z2: null, zN: 0,
      stationBiasLog: 0, stationBiasRaw: null, stationN: 0 };
  }
}

// Daily mean log-PM2.5 from the analysis part of the timeline (complete days only).
export function truthByDate(lpmSeries, time) {
  const acc = {};
  lpmSeries.forEach((v, i) => {
    if (v == null) return;
    const d = localDate(time[i]);
    (acc[d] ??= []).push(v);
  });
  return Object.fromEntries(Object.entries(acc).filter(([, a]) => a.length >= 22)
    .map(([d, a]) => [d, a.reduce((s, x) => s + x, 0) / a.length]));
}

export function updateStationBias(state, station, aq) {
  if (!station?.pm25Aqi || !station.time) return;
  if (station.distanceKm == null || station.distanceKm > MAX_STATION_KM) {
    console.warn(`[station] ignoring ${station.station} (${station.distanceKm?.toFixed(0) ?? "?"} km away)`);
    return;
  }
  const conc = legacyPm25AqiToConc(station.pm25Aqi);
  const hr = Math.floor(station.time / 3600) * 3600;
  const i = aq.time.indexOf(hr);
  if (i < 0 || aq.pm2_5[i] == null) return;
  const diff = Math.max(-1, Math.min(1, L1(conc) - L1(aq.pm2_5[i])));
  state.stationBiasRaw = ew(state.stationBiasRaw, diff, state.stationN);
  state.stationN += 1;
  // Shrink towards zero until enough evidence has accumulated.
  state.stationBiasLog = +(state.stationBiasRaw * Math.min(1, state.stationN / 4)).toFixed(4);
  state.lastStation = { ...station, pm25Conc: +conc.toFixed(1), camsAtHour: aq.pm2_5[i] };
}

export async function verifyArchive(state, archiveDir, truth) {
  let files = [];
  try { files = (await fs.readdir(archiveDir)).filter((f) => f.endsWith(".json")).sort(); } catch { return; }
  const done = new Set(state.verified);
  for (const f of files) {
    const arc = JSON.parse(await fs.readFile(path.join(archiveDir, f), "utf8"));
    for (const day of arc.days) {
      const key = `${arc.issueDate}|${day.date}`;
      if (done.has(key) || truth[day.date] == null || day.lead < 1) continue;
      const y = truth[day.date];
      const bucket = (state.members[`d${day.lead}`] ??= {});
      for (const k of ["cams", "met", "clim"]) {
        const o = (bucket[k] ??= { mse: null, n: 0 });
        o.mse = +ew(o.mse, (day.log[k] - y) ** 2, o.n).toFixed(5);
        o.n += 1;
      }
      const z = (day.log.blend - y) / day.sigmaRaw;
      state.z2 = ew(state.z2, z * z, state.zN);
      state.zN += 1;
      state.log.push({
        issued: arc.issueDate, date: day.date, lead: day.lead, truth: +E1(y).toFixed(1),
        blend: +E1(day.log.blend).toFixed(1), cams: +E1(day.log.cams).toFixed(1),
        persistence: +E1(day.log.persistence).toFixed(1),
        inBand: Math.abs(z) <= 1.2816,
      });
      done.add(key);
    }
  }
  if (state.zN >= 5) state.sigmaScale = +Math.min(2.5, Math.max(0.6, Math.sqrt(state.z2))).toFixed(3);
  state.verified = [...done].slice(-400);
  state.log = state.log.slice(-300);
}

export function skillSummary(state) {
  const out = {};
  for (const lead of [1, 2, 3]) {
    const rows = state.log.filter((r) => r.lead === lead).slice(-30);
    if (!rows.length) continue;
    const mae = (k) => +(rows.reduce((s, r) => s + Math.abs(r[k] - r.truth), 0) / rows.length).toFixed(2);
    out[`day${lead}`] = {
      n: rows.length, maeBlend: mae("blend"), maeCams: mae("cams"), maePersistence: mae("persistence"),
      coverage80: +(rows.filter((r) => r.inBand).length / rows.length).toFixed(2),
    };
  }
  return out;
}
