import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, string>();
const post = vi.fn();
vi.mock("expo-local-authentication", () => ({
  getEnrolledLevelAsync: async () => 0,
  SecurityLevel: { BIOMETRIC_STRONG: 3, BIOMETRIC_WEAK: 2, NONE: 0 },
}));
vi.mock("@/constants/branding", () => ({ APP_NAME: "HostelPalika" }));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: async (key: string) => void saved.delete(key),
  getItemAsync: async (key: string) => saved.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void saved.set(key, value),
}));
vi.mock("@/lib/api", () => ({ api: { post: (...args: unknown[]) => post(...args) } }));
vi.mock("@/store", () => ({ store: { getState: () => ({ auth: { account: { id: "u1" } } }) } }));

const refused = (errorCode: string) => ({ response: { data: { errorCode, message: errorCode } } });

describe("PIN check: the phone's copy first", () => {
  beforeEach(() => {
    saved.clear();
    post.mockReset();
    vi.resetModules();
  });

  it("opens on the copy, and a server refusal behind it locks again and drops the copy", async () => {
    const { rememberPin } = await import("@/lib/offline-pin");
    const lock = await import("@/lib/app-lock");
    await rememberPin("u1", "4821");
    post.mockRejectedValue(refused("LOCK_PIN_INCORRECT"));

    lock.unlockApp();
    await lock.checkLockPin("4821");
    await vi.waitFor(() => expect(lock.isLocked()).toBe(true));
    expect(lock.lockRefusal()?.blocked).toBe(false);
    expect(saved.size).toBe(0);
  });

  it("stays open when the server cannot be reached", async () => {
    const { rememberPin } = await import("@/lib/offline-pin");
    const lock = await import("@/lib/app-lock");
    await rememberPin("u1", "4821");
    post.mockRejectedValue(new Error("Network Error"));

    lock.unlockApp();
    await lock.checkLockPin("4821");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lock.isLocked()).toBe(false);
    expect(saved.size).toBe(1);
  });

  it("sends a PIN the copy refuses to the server, which counts it", async () => {
    const { rememberPin } = await import("@/lib/offline-pin");
    const lock = await import("@/lib/app-lock");
    await rememberPin("u1", "4821");
    post.mockRejectedValue(refused("LOCK_PIN_INCORRECT"));

    await expect(lock.checkLockPin("0000")).rejects.toBeTruthy();
    expect(post).toHaveBeenCalledWith("/auth/lock-pin/verify", { pin: "0000" });
  });
});
