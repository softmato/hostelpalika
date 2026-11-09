import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./receipt-native", () => ({ receiptNative: null }));
vi.mock("@/lib/session-refresh-lock", () => ({ withSessionRefreshLock: <T>(f: () => T) => f() }));
vi.mock("@/lib/query-cache", () => ({ invalidateAllQueries: vi.fn() }));
vi.mock("@/lib/active-hostel", () => ({ getRequestHostelId: () => null, loadActiveHostel: async () => undefined }));
vi.mock("@/lib/session", () => ({ clearTokens: vi.fn(), readTokens: async () => null, writeAccessToken: vi.fn(), writeTokens: vi.fn() }));

const GO = "https://api.hostelpalika.com/api/v1";
const TS = "https://hostelpalika.com/api/v1";

async function client() {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_API_URL", "https://api.hostelpalika.com");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Network request failed"); })); // health probe: Go down
  const { api } = await import("@/lib/api");
  const seen: string[] = [];
  return { api, seen };
}

/** Go unreachable (no response) or answering `goStatus`; the standby always answers 200. */
function adapter(seen: string[], goStatus?: number): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig) => {
    seen.push(`${config.method?.toUpperCase()} ${config.baseURL}`);
    if (config.baseURL === GO) {
      if (!goStatus) throw new AxiosError("Network Error", "ERR_NETWORK", config);
      const response = { config, data: {}, headers: {}, status: goStatus, statusText: "" };
      throw new AxiosError("Bad gateway", "ERR_BAD_RESPONSE", config, null, response);
    }
    return { config, data: { ok: true }, headers: {}, status: 200, statusText: "OK" };
  };
}

describe("app API failover", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("retries a GET on the TS standby when Go is unreachable", async () => {
    const { api, seen } = await client();
    api.defaults.adapter = adapter(seen);
    const response = await api.get("/public/hostels");
    expect(response.data).toEqual({ ok: true });
    expect(seen).toEqual([`GET ${GO}`, `GET ${TS}`]);
  });

  it("does not resend a write after a network error (Go may have saved it)", async () => {
    const { api, seen } = await client();
    api.defaults.adapter = adapter(seen);
    await expect(api.post("/resident/complaints", {})).rejects.toThrow("Network Error");
    expect(seen).toEqual([`POST ${GO}`]);
  });

  it("resends a write Caddy answered 502 for (Go never saw it)", async () => {
    const { api, seen } = await client();
    api.defaults.adapter = adapter(seen, 502);
    await api.post("/resident/complaints", {});
    expect(seen).toEqual([`POST ${GO}`, `POST ${TS}`]);
  });

  it("leaves Go's own errors alone", async () => {
    const { api, seen } = await client();
    api.defaults.adapter = adapter(seen, 500);
    await expect(api.get("/public/hostels")).rejects.toThrow();
    expect(seen).toEqual([`GET ${GO}`]);
  });
});
