// Location & model configuration. Everything here can be overridden via env vars.
export const SITE = {
  name: "Mutiara Ville, Cyberjaya",
  // Approximate coordinates of Mutiara Ville (Cyberjaya, Selangor).
  lat: Number(process.env.HZ_LAT ?? 2.9213),
  lon: Number(process.env.HZ_LON ?? 101.6559),
  tz: "Asia/Kuala_Lumpur",
  utcOffsetHours: 8,
};

// Numerical weather prediction models used as independent meteorological drivers.
export const NWP_MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"];

export const PAST_DAYS = 92;       // training window (Open-Meteo max)
export const FORECAST_DAYS = 5;    // CAMS global horizon
export const LEAD_BUCKETS = [1, 6, 12, 24, 36, 48, 72, 96, 120]; // hours, one ridge model per bucket
export const HOLDOUT_DAYS = 21;    // time-ordered validation window
export const RIDGE_LAMBDAS = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100];

// Online learning of blend weights (per lead day)
export const EW_ALPHA = 0.12;
export const PRIOR_PSEUDO_COUNT = 6;

export const CLAUDE_MODEL = process.env.HZ_CLAUDE_MODEL ?? "claude-opus-5-5";

export const localDate = (unixSec) =>
  new Date((unixSec + SITE.utcOffsetHours * 3600) * 1000).toISOString().slice(0, 10);
export const localHour = (unixSec) =>
  new Date((unixSec + SITE.utcOffsetHours * 3600) * 1000).getUTCHours();
export const localDow = (unixSec) =>
  new Date((unixSec + SITE.utcOffsetHours * 3600) * 1000).getUTCDay();
