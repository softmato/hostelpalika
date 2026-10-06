import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-local-authentication", () => ({}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("@/lib/api", () => ({ api: {} }));

async function freshLock() {
  vi.resetModules();
  return import("@/lib/app-lock");
}

describe("app lock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts locked, and a trip away before unlocking never opens it", async () => {
    const lock = await freshLock();
    expect(lock.isLocked()).toBe(true);

    lock.onAppStateChange("background");
    lock.onAppStateChange("active");
    expect(lock.isLocked()).toBe(true);
  });

  it("locks the moment it leaves, and a quick return (a photo picked) opens it again", async () => {
    const lock = await freshLock();
    lock.unlockApp();

    lock.onAppStateChange("background");
    expect(lock.isLocked()).toBe(true);

    vi.advanceTimersByTime(10_000);
    lock.onAppStateChange("active");
    expect(lock.isLocked()).toBe(false);
  });

  it("asks again after the grace", async () => {
    const lock = await freshLock();
    lock.unlockApp();

    lock.onAppStateChange("background");
    vi.advanceTimersByTime(31_000);
    lock.onAppStateChange("active");
    expect(lock.isLocked()).toBe(true);
  });

  it("offers cooks the lock only where the owner switched it on", async () => {
    const { canOfferLock, hasMailbox } = await freshLock();
    const cook = { email: "sunr@cook.local", role: "COOK" } as Parameters<typeof canOfferLock>[0];

    expect(canOfferLock(cook)).toBe(false);
    expect(canOfferLock({ ...cook!, cookFingerprintLock: true })).toBe(true);
    expect(hasMailbox(cook)).toBe(false);
    expect(canOfferLock({ ...cook!, email: "owner@gmail.com", role: "HOSTEL_ADMIN" })).toBe(true);
    expect(canOfferLock({ ...cook!, email: null, role: "RESIDENT" })).toBe(false);
  });

  it("masks the recovery address", async () => {
    const { maskEmail } = await freshLock();
    expect(maskEmail("siddhant@gmail.com")).toBe("s••••••t@gmail.com");
    expect(maskEmail("ab@x.com")).toBe("ab@x.com");
  });
});
