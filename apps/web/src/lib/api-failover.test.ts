import { describe, expect, it } from "vitest";

import { ApiBreaker, PROBE_EVERY_MS } from "@hostel/constants/api-failover";

const GO = "https://api.test";
const TS = "https://web.test";

/** A fake network: Go is up or down; every call is recorded. */
function setup() {
  const state = { goUp: true, clock: 1_000_000, calls: [] as string[] };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    state.calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith(GO) && !state.goUp) throw new TypeError("fetch failed");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const breaker = new ApiBreaker(GO, TS, fetcher, () => state.clock);
  return { breaker, state };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ApiBreaker", () => {
  it("stays on Go while Go answers", async () => {
    const { breaker, state } = setup();
    await breaker.fetch("/api/v1/x");
    expect(state.calls).toEqual([`GET ${GO}/api/v1/x`]);
    expect(breaker.origin()).toBe(GO);
  });

  it("serves a failed GET from the standby and trips once the probe confirms Go is down", async () => {
    const { breaker, state } = setup();
    state.goUp = false;
    const response = await breaker.fetch("/api/v1/x");
    expect(response.ok).toBe(true);
    await settle();
    expect(breaker.onStandby).toBe(true);
    expect(breaker.origin()).toBe(TS);
  });

  it("does not trip on a blip when the probe finds Go healthy", async () => {
    const { state } = setup();
    let first = true;
    const flaky = new ApiBreaker(GO, TS, (async (input: RequestInfo | URL) => {
      if (first && String(input).endsWith("/x")) {
        first = false;
        throw new TypeError("blip");
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch, () => state.clock);
    await flaky.fetch("/api/v1/x");
    await settle();
    expect(flaky.onStandby).toBe(false);
  });

  it("never resends a write that may have reached Go", async () => {
    const { breaker, state } = setup();
    state.goUp = false;
    await expect(breaker.fetch("/api/v1/x", { method: "POST" })).rejects.toThrow();
    expect(state.calls.filter((c) => c.startsWith(`POST ${TS}`))).toHaveLength(0);
    await settle();
    await breaker.fetch("/api/v1/x", { method: "POST" }); // the retry, now on the standby
    expect(state.calls.at(-1)).toBe(`POST ${TS}/api/v1/x`);
  });

  it("returns to Go after two healthy probes", async () => {
    const { breaker, state } = setup();
    state.goUp = false;
    await breaker.fetch("/api/v1/x");
    await settle();
    state.goUp = true;
    for (let i = 0; i < 2; i++) {
      state.clock += PROBE_EVERY_MS;
      breaker.origin();
      await settle();
    }
    expect(breaker.onStandby).toBe(false);
    expect(breaker.origin()).toBe(GO);
  });

  it("is a plain fetch when there is no separate API host", async () => {
    const calls: string[] = [];
    const same = new ApiBreaker("", "", (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new TypeError("down");
    }) as typeof fetch);
    await expect(same.fetch("/api/v1/x")).rejects.toThrow();
    expect(calls).toEqual(["/api/v1/x"]);
  });
});
