import { beforeEach, describe, expect, it } from "vitest";

import {
  CLAIM_TTL_MS,
  claimNotificationSound,
  resetNotificationSoundClaims,
} from "@/lib/notification-sound";

describe("claimNotificationSound", () => {
  beforeEach(() => resetNotificationSoundClaims());

  it("lets the first arrival sound and quiets the second", () => {
    // The socket, then the push for the same row a couple of seconds later.
    expect(claimNotificationSound("row-1", 0)).toBe(true);
    expect(claimNotificationSound("row-1", 2_000)).toBe(false);
  });

  it("keeps separate notifications independent", () => {
    expect(claimNotificationSound("row-1", 0)).toBe(true);
    expect(claimNotificationSound("row-2", 10)).toBe(true);
  });

  it("always sounds a notification it cannot match with a twin", () => {
    expect(claimNotificationSound(undefined, 0)).toBe(true);
    expect(claimNotificationSound(undefined, 1)).toBe(true);
    expect(claimNotificationSound("", 2)).toBe(true);
    expect(claimNotificationSound(42, 3)).toBe(true);
  });

  it("sounds again once the claim has expired", () => {
    expect(claimNotificationSound("row-1", 0)).toBe(true);
    expect(claimNotificationSound("row-1", CLAIM_TTL_MS - 1)).toBe(false);
    expect(claimNotificationSound("row-1", CLAIM_TTL_MS)).toBe(true);
  });
});

describe("claimNotificationDisplay", () => {
  it("lets one of the socket echo and its push show the banner, not both", async () => {
    const { claimNotificationDisplay } = await import("./notification-sound");

    expect(claimNotificationDisplay("row-display-1")).toBe(true);
    expect(claimNotificationDisplay("row-display-1")).toBe(false);
    expect(claimNotificationDisplay("campaign:c1")).toBe(true);
  });

  it("always shows a notification that carries no id", async () => {
    const { claimNotificationDisplay } = await import("./notification-sound");

    expect(claimNotificationDisplay(undefined)).toBe(true);
    expect(claimNotificationDisplay(undefined)).toBe(true);
  });
});
