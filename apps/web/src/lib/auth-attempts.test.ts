import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import type { FakeModel } from "../../test/fake-mongo";

const store = vi.hoisted(() => ({ model: null as unknown as FakeModel }));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@hostel/db/models/AuthAttempt", async () => {
  const { fakeModel } = await import("../../test/fake-mongo");

  store.model = fakeModel();

  return { AuthAttemptModel: store.model };
});

const {
  FAILED_ATTEMPTS_PER_IP,
  recordFailedAttempt,
  refuseIfTooManyFailures,
} = await import("@/lib/auth-attempts");

function from(ip: string) {
  return new NextRequest("https://hostelpalika.local/api/v1/auth/login", {
    headers: { "x-forwarded-for": ip },
    method: "POST",
  });
}

describe("failed-attempt limits", () => {
  it("stops one address spraying many accounts", async () => {
    for (let i = 0; i < FAILED_ATTEMPTS_PER_IP; i += 1) {
      await recordFailedAttempt(from("198.51.100.1"), "auth-login", `user${i}@example.com`);
    }

    // A fresh account from the same address is refused…
    expect(
      (await refuseIfTooManyFailures(from("198.51.100.1"), "auth-login", "new@example.com"))
        ?.status,
    ).toBe(429);
    // …another address is not.
    expect(
      await refuseIfTooManyFailures(from("198.51.100.2"), "auth-login", "new@example.com"),
    ).toBeNull();
  });

  it("never lets a failed count replace the real error", async () => {
    vi.spyOn(store.model, "updateOne").mockRejectedValueOnce(new Error("mongo is down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      recordFailedAttempt(from("198.51.100.3"), "auth-login", "someone@example.com"),
    ).resolves.toBeUndefined();
  });
});
