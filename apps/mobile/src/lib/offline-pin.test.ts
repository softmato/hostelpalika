import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: async (key: string) => void saved.delete(key),
  getItemAsync: async (key: string) => saved.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void saved.set(key, value),
}));

import { checkPinOffline, FREE_TRIES, forgetIfStale, rememberPin } from "@/lib/offline-pin";

describe("offline PIN", () => {
  beforeEach(() => saved.clear());

  it("stores a salted hash, never the PIN, and checks it for the same account only", async () => {
    await rememberPin("u1", "4821");
    expect([...saved.values()].join()).not.toContain("4821");
    expect(await checkPinOffline("u1", "4821")).toEqual({ ok: true });
    expect(await checkPinOffline("u2", "4821")).toEqual({ ok: false, reason: "none" });
  });

  it("allows five wrong tries, then waits, doubling; a right PIN is refused while waiting", async () => {
    await rememberPin("u1", "4821");
    const now = 1_000_000;
    for (let i = 1; i < FREE_TRIES; i += 1) {
      expect(await checkPinOffline("u1", "0000", now)).toEqual({
        ok: false,
        reason: "wrong",
        triesLeft: FREE_TRIES - i,
      });
    }
    expect(await checkPinOffline("u1", "0000", now)).toEqual({ ok: false, reason: "wait", until: now + 60_000 });
    expect(await checkPinOffline("u1", "4821", now + 1)).toMatchObject({ reason: "wait" });
    expect(await checkPinOffline("u1", "0000", now + 60_000)).toEqual({ ok: false, reason: "wait", until: now + 180_000 });
    expect(await checkPinOffline("u1", "4821", now + 180_000)).toEqual({ ok: true });
  });

  it("drops the copy when the server refuses the PIN it still accepts", async () => {
    await rememberPin("u1", "4821");
    await forgetIfStale("u1", "1111");
    expect(saved.size).toBe(1);
    await forgetIfStale("u1", "4821");
    expect(saved.size).toBe(0);
  });
});
