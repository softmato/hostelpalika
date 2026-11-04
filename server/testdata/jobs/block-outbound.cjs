// Preloaded into the TS server for the Phase 9 shadow (shadow-ts.sh): every
// request to a host that is not this machine fails at once and is logged to
// $SHADOW_OUTBOUND_LOG, so a job on live data reaches no phone, inbox or API.
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const log = process.env.SHADOW_OUTBOUND_LOG;
const local = (host) => !host || /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(String(host).replace(/:\d+$/, ""));
const note = (host) => log && fs.appendFileSync(log, `ts ${host}\n`);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) {
    note(url.hostname);
    throw new TypeError(`shadow: outbound blocked (${url.hostname})`);
  }
  return realFetch(input, init);
};

for (const mod of [http, https]) {
  for (const name of ["request", "get"]) {
    const real = mod[name];
    mod[name] = function (...args) {
      const first = args[0];
      const host = typeof first === "string" || first instanceof URL ? new URL(first).hostname : first && (first.hostname || first.host);
      if (!local(host)) {
        note(host);
        throw new Error(`shadow: outbound blocked (${host})`);
      }
      return real.apply(this, args);
    };
  }
}
