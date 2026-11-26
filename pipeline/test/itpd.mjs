import assert from "node:assert/strict";
import { discoveryItpdParents } from "../src/discovery.mjs";

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const N = 800;
const y = new Array(N).fill(NaN), x = new Array(N).fill(NaN), z = new Array(N).fill(NaN);
for (let t = 0; t < N; t++) {
  x[t] = 0.5 * (t ? x[t - 1] : 0) + gauss();
  z[t] = -0.3 * (t ? z[t - 1] : 0) + gauss();
  y[t] = 0.6 * (t ? y[t - 1] : 0) + 0.5 * (t ? x[t - 1] : 0) + gauss();
}

const parents = discoveryItpdParents(y, [
  { name: "x_lag1", values: x, lag: 1 },
  { name: "z_lag1", values: z, lag: 1 },
], 3);
assert.ok(parents.includes("y_lag1"), "autoregressive lag is a parent");
assert.ok(parents.includes("x_lag1"), "true parent x[t-1] discovered");
assert.ok(!parents.includes("z_lag1"), "irrelevant z[t-1] pruned");
assert.equal(parents.length, 2, "no spurious parents");
console.log("ITPD parents:", parents.join(", "));
console.log("OK – ITPD discovery test passed");
