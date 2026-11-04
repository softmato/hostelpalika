// Phase 10 load test (PHASES.md): a mixed workload derived from UsageDaily, run
// against a local Go API on a scaled clone of the live data (seed-scale.js).
//
//   k6 run -e BASE=http://127.0.0.1:8090 -e ADM=<token> -e RES=<token> -e MODE=sustained \
//          -e OUT=testdata/k6/results/go-local-sustained.json testdata/k6/load.js
//
// Tokens come from `bin/dev.exe token <email>` on the clone. MODE:
//   cold      Redis flushed by the caller first; one minute ramp to the sustained rate
//   warm      the sustained rate for one minute, cache already filled
//   sustained the projected peak-hour rate (RATE, default 70 req/s) for SECONDS (default 300)
//   burst     a step from the sustained rate to BURST (default 250 req/s) and back
//
// Workload (derived 2026-11-04 from usagedailies on the live copy, see
// results/README.md): admin ≈ 170 actions/day, resident ≈ 19, ≈3 API calls each;
// at 500 hostels × 40 residents the peak hour carries ≈16 % of a day → ≈64 req/s.
import http from "k6/http";
import { check } from "k6";

const BASE = (__ENV.BASE || "http://127.0.0.1:8090").replace(/\/+$/, "");
const MODE = __ENV.MODE || "sustained";
const RATE = Number(__ENV.RATE || 70);
const BURST = Number(__ENV.BURST || 250);
const SECONDS = Number(__ENV.SECONDS || 300);
const SLUG = __ENV.SLUG || "leeway-residence-buddhnagar";
const ADM = { Authorization: `Bearer ${__ENV.ADM}` };
const RES = { Authorization: `Bearer ${__ENV.RES}` };

// [weight, group, path, headers]: residents ≈60 %, admins ≈20 %, public ≈20 %.
const MIX = [
  [10, "resident", "/api/v1/resident/dashboard", RES],
  [8, "resident", "/api/v1/auth/me", RES],
  [8, "resident", "/api/v1/notifications?limit=20", RES],
  [8, "resident", "/api/v1/resident/finance/invoices", RES],
  [6, "resident", "/api/v1/resident/notices", RES],
  [6, "resident", "/api/v1/resident/food", RES],
  [5, "resident", "/api/v1/resident/attendance", RES],
  [5, "resident", "/api/v1/resident/room", RES],
  [4, "resident", "/api/v1/resident/me", RES],
  [4, "admin", "/api/v1/auth/me", ADM],
  [3, "admin", "/api/v1/hostel-admin/residents", ADM],
  [3, "admin", "/api/v1/hostel-admin/reports/dashboard", ADM],
  [2, "admin", "/api/v1/hostel-admin/reports/overview", ADM],
  [2, "admin", "/api/v1/hostel-admin/finance/invoices", ADM],
  [2, "admin", "/api/v1/hostel-admin/rooms", ADM],
  [2, "admin", "/api/v1/hostel-admin/attendance", ADM],
  [1, "admin", "/api/v1/hostel-admin/expenses", ADM],
  [1, "admin", "/api/v1/hostel-admin/complaints", ADM],
  [6, "public", "/api/v1/public/site-config", null],
  [6, "public", "/api/v1/public/hostels?limit=12", null],
  [5, "public", `/api/v1/public/hostels/${SLUG}`, null],
  [3, "public", `/api/v1/public/hostels/${SLUG}/reviews`, null],
];
const TOTAL = MIX.reduce((s, m) => s + m[0], 0);

function arrival(stages) {
  return { executor: "ramping-arrival-rate", startRate: 1, timeUnit: "1s", preAllocatedVUs: 50, maxVUs: 600, stages };
}
const SCENARIOS = {
  cold: arrival([{ target: RATE, duration: "60s" }]),
  warm: arrival([{ target: RATE, duration: "5s" }, { target: RATE, duration: "60s" }]),
  sustained: arrival([{ target: RATE, duration: "10s" }, { target: RATE, duration: `${SECONDS}s` }]),
  burst: arrival([
    { target: RATE, duration: "10s" },
    { target: RATE, duration: "30s" },
    { target: BURST, duration: "5s" },
    { target: BURST, duration: "60s" },
    { target: RATE, duration: "5s" },
    { target: RATE, duration: "60s" },
  ]),
};

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: { [MODE]: Object.assign({ exec: "hit" }, SCENARIOS[MODE]) },
  thresholds: Object.fromEntries(
    ["resident", "admin", "public"].flatMap((g) => [
      [`http_req_duration{group:${g}}`, ["p(95)>=0"]],
      [`http_req_failed{group:${g}}`, ["rate>=0"]],
    ]).concat(MIX.map((m) => [`http_req_duration{name:${m[1]} ${m[2]}}`, ["p(95)>=0"]])),
  ),
};

export function hit() {
  let r = Math.random() * TOTAL;
  let m = MIX[0];
  for (const x of MIX) {
    if ((r -= x[0]) < 0) {
      m = x;
      break;
    }
  }
  const name = `${m[1]} ${m[2]}`;
  const res = http.get(BASE + m[2], { headers: m[3] || {}, tags: { group: m[1], name } });
  check(res, { "2xx": (x) => x.status >= 200 && x.status < 300 });
}

export function handleSummary(data) {
  const pick = (metric) => {
    const v = data.metrics[metric]?.values;
    return v && { p50: v.med, p90: v["p(90)"], p95: v["p(95)"], p99: v["p(99)"], max: v.max };
  };
  const out = {
    mode: MODE,
    base: BASE,
    at: new Date().toISOString(),
    env: __ENV.ENVDESC || "local",
    target_rate: MODE === "burst" ? `${RATE}→${BURST}→${RATE}` : RATE,
    requests: data.metrics.http_reqs?.values.count,
    throughput_rps: data.metrics.http_reqs?.values.rate,
    error_rate: data.metrics.http_req_failed?.values.rate,
    dropped_iterations: data.metrics.dropped_iterations?.values.count || 0,
    vus_max: data.metrics.vus_max?.values.max,
    all_ms: pick("http_req_duration"),
    groups: Object.fromEntries(["resident", "admin", "public"].map((g) => [g, { ms: pick(`http_req_duration{group:${g}}`), error_rate: data.metrics[`http_req_failed{group:${g}}`]?.values.rate }])),
    routes: Object.fromEntries(MIX.map((m) => [`${m[1]} ${m[2]}`, pick(`http_req_duration{name:${m[1]} ${m[2]}}`)])),
  };
  const file = __ENV.OUT || "testdata/k6/results/latest.json";
  return { [file]: JSON.stringify(out, null, 2) + "\n", stdout: `${MODE}: ${out.requests} req, ${out.throughput_rps?.toFixed(1)} rps, err ${out.error_rate}, p50/p95/p99 ${out.all_ms?.p50?.toFixed(1)}/${out.all_ms?.p95?.toFixed(1)}/${out.all_ms?.p99?.toFixed(1)} ms\n` };
}
