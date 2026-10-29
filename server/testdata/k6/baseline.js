// Read-only latency baseline (TESTING.md §5).
//
//   k6 run -e BASE=https://hostelpalika.com testdata/k6/baseline.js
//   k6 run -e BASE=https://localhost -e INSECURE=1 testdata/k6/baseline.js
//
// Gentle on purpose: production serves real users on an M0 cluster, so each
// route gets 2 req/s for 60 s (600 requests in all), GETs only, no login.
// TS sends no Server-Timing, so the comparable number is what the client sees:
// TTFB (http_req_waiting) and total duration, per route, from this machine.
import http from "k6/http";
import { check } from "k6";

const BASE = (__ENV.BASE || "https://hostelpalika.com").replace(/\/+$/, "");
const SLUG = __ENV.SLUG || "education-light-hostel-narephat";

const ROUTES = {
  health: "/api/v1/health",
  site_config: "/api/v1/public/site-config",
  hostels_list: "/api/v1/public/hostels?limit=12",
  hostel_detail: `/api/v1/public/hostels/${SLUG}`,
  hostel_reviews: `/api/v1/public/hostels/${SLUG}/reviews`,
};

export const options = {
  insecureSkipTLSVerify: !!__ENV.INSECURE,
  summaryTrendStats: ["min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: Object.fromEntries(
    Object.keys(ROUTES).map((name) => [
      name,
      {
        executor: "constant-arrival-rate",
        rate: 2,
        timeUnit: "1s",
        duration: "60s",
        preAllocatedVUs: 4,
        maxVUs: 10,
        exec: "hit",
        env: { ROUTE: name },
        tags: { route: name },
      },
    ]),
  ),
  // One sub-metric per route so the summary shows each separately.
  thresholds: Object.fromEntries(
    Object.keys(ROUTES).flatMap((name) => [
      [`http_req_waiting{route:${name}}`, ["p(95)>=0"]],
      [`http_req_duration{route:${name}}`, ["p(95)>=0"]],
      [`http_req_failed{route:${name}}`, ["rate>=0"]],
    ]),
  ),
};

export function hit() {
  const res = http.get(BASE + ROUTES[__ENV.ROUTE]);
  check(res, { "200": (r) => r.status === 200 });
}

export function handleSummary(data) {
  const pick = (metric) => {
    const v = data.metrics[metric]?.values;
    return v && { med: v.med, p90: v["p(90)"], p95: v["p(95)"], p99: v["p(99)"], max: v.max };
  };
  const routes = Object.fromEntries(
    Object.keys(ROUTES).map((name) => [
      name,
      {
        path: ROUTES[name],
        ttfb_ms: pick(`http_req_waiting{route:${name}}`),
        total_ms: pick(`http_req_duration{route:${name}}`),
        error_rate: data.metrics[`http_req_failed{route:${name}}`]?.values.rate,
      },
    ]),
  );
  const out = { base: BASE, at: new Date().toISOString(), routes };
  const file = __ENV.OUT || "testdata/k6/results/latest.json";
  return { [file]: JSON.stringify(out, null, 2) + "\n", stdout: JSON.stringify(out, null, 2) + "\n" };
}
