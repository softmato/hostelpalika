import { beforeEach, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), clear: vi.fn(), active: null as string | null }));
vi.mock("@/lib/session", () => ({ readTokens: mocks.read, writeTokens: mocks.write, writeAccessToken: vi.fn(), clearTokens: mocks.clear }));
vi.mock("@/lib/active-hostel", () => ({ getActiveHostelId: () => mocks.active, loadActiveHostel: vi.fn() }));
vi.mock("@/lib/receipt-native", () => ({ receiptNative: null }));
beforeEach(() => { mocks.active = null; vi.resetModules(); vi.clearAllMocks(); mocks.read.mockResolvedValue({ accessToken: "old", refreshToken: "saved" }); });
it.each([undefined, 429, 500, 503])("keeps credentials after refresh failure %s", async (status) => {
  const { api, publicApi, bindSessionHandlers } = await import("./api");
  const ended = vi.fn();
  bindSessionHandlers({ getAccessToken: () => "old", onAccessToken: vi.fn(), onSessionEnded: ended });
  api.defaults.adapter = async (config) => { throw new AxiosError("expired", "", config, null, { status: 401, data: {}, statusText: "", headers: {}, config }); };
  publicApi.defaults.adapter = async (config) => { throw new AxiosError("unavailable", "", config, null, status ? { status, data: {}, statusText: "", headers: {}, config } : undefined); };
  await expect(api.get("/resident/test")).rejects.toThrow();
  expect(mocks.clear).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
});
it("ends the session on a rejected refresh token", async () => {
  const { api, publicApi, bindSessionHandlers } = await import("./api");
  const ended = vi.fn();
  bindSessionHandlers({ getAccessToken: () => "old", onAccessToken: vi.fn(), onSessionEnded: ended });
  const fail = async (config: InternalAxiosRequestConfig) => { throw new AxiosError("expired", "", config, null, { status: 401, data: {}, statusText: "", headers: {}, config }); };
  api.defaults.adapter = fail; publicApi.defaults.adapter = fail;
  await expect(api.get("/resident/test")).rejects.toThrow();
  expect(mocks.clear).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledWith("EXPIRED");
});
it("does not log out when the replay is forbidden", async () => {
  const { api, publicApi, bindSessionHandlers } = await import("./api");
  let token = "old";
  const ended = vi.fn();
  bindSessionHandlers({ getAccessToken: () => token, onAccessToken: (next) => { token = next; }, onSessionEnded: ended });
  api.defaults.adapter = async (config) => { throw new AxiosError("denied", "", config, null, { status: token === "old" ? 401 : 403, data: {}, statusText: "", headers: {}, config }); };
  publicApi.defaults.adapter = async (config) => ({ data: { data: { accessToken: "fresh", refreshToken: "rotated" } }, status: 200, statusText: "OK", headers: new AxiosHeaders(), config });
  await expect(api.get("/resident/test")).rejects.toThrow();
  expect(mocks.write).toHaveBeenCalledWith({ accessToken: "fresh", refreshToken: "rotated" });
  expect(mocks.clear).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
});


it("keeps the original branch while a session read is delayed", async () => {
  const { api } = await import("./api");
  let release!: (value: { accessToken: string; refreshToken: string }) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  mocks.read.mockImplementationOnce(() => { began(); return new Promise((resolve) => { release = resolve; }); });
  mocks.active = "branch-A";
  const sent = vi.fn(async (config: InternalAxiosRequestConfig) => ({ data: {}, status: 200, statusText: "OK", headers: new AxiosHeaders(), config }));
  api.defaults.adapter = sent;
  const request = api.get("/hostel-admin/dashboard");
  await started;
  mocks.active = "branch-B";
  release({ accessToken: "opaque-token", refreshToken: "refresh" });
  await request;
  expect(sent.mock.calls[0][0].headers.get("x-hostel-id")).toBe("branch-A");
});
