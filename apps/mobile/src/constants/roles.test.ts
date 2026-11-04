import { describe, expect, it } from "vitest";

import { ROLE, accentForAccount, resolveHome } from "@/constants/roles";

/**
 * These cases are the boot contract. Every one of them runs before the first
 * frame on a cold start, so a wrong answer here is a visible wrong screen —
 * which is precisely what the no-flash boot exists to prevent.
 */
describe("resolveHome", () => {
  it("sends a signed-out device to the discovery tabs, never to a login wall", () => {
    // The app is the website: browsing hostels needs no account, and a
    // hostel-hunting student has nothing to sign in with yet. Signing in is a
    // card at the top of the Profile tab, not a gate in front of the product.
    expect(resolveHome(null)).toBe("/(browse)");
  });

  it("gives a signed-out device the same shell a browsing account gets", () => {
    // One shell, not two. The signed-out group used to be its own stack with a
    // floating Log in pill; the difference between having an account and not is
    // now a single card, so the route has to be the same route.
    expect(resolveHome(null)).toBe(resolveHome({ role: ROLE.PUBLIC }));
  });

  it("sends an activated resident straight to the resident tabs", () => {
    expect(resolveHome({ isResidentActivated: true, role: ROLE.RESIDENT })).toBe(
      "/(resident)",
    );
  });

  it("sends an invited-but-unactivated resident to QR activation", () => {
    expect(resolveHome({ isResidentActivated: false, role: ROLE.RESIDENT })).toBe(
      "/activate",
    );
  });

  it("treats unknown activation as activated", () => {
    // A cold, offline start has no activation answer cached. Bouncing a
    // working resident to the QR scanner would be worse than showing a
    // dashboard that revalidation can correct a moment later.
    expect(resolveHome({ role: ROLE.RESIDENT })).toBe("/(resident)");
  });

  it("routes guardian, cook and warden to their own groups", () => {
    expect(resolveHome({ role: ROLE.GUARDIAN })).toBe("/(guardian)");
    expect(resolveHome({ role: ROLE.COOK })).toBe("/(cook)");
    expect(resolveHome({ role: ROLE.WARDEN })).toBe("/(admin)");
    expect(resolveHome({ role: ROLE.HOSTEL_ADMIN })).toBe("/(admin)");
  });

  it("gives the superadmin the platform shell and a moderator the browsing app", () => {
    // Owner, 2026-11-03: superadmin screens in the app. Moderators have no
    // native screen yet, so they browse.
    expect(resolveHome({ role: ROLE.SUPERADMIN })).toBe("/(platform)");
    expect(resolveHome({ role: ROLE.PLATFORM_MODERATOR })).toBe("/(browse)");
  });

  it("separates an approved service provider from an ordinary public account", () => {
    // There is no SERVICE_PROVIDER role — both of these are PUBLIC, and only
    // the approved-provider flag tells them apart.
    expect(resolveHome({ isApprovedProvider: true, role: ROLE.PUBLIC })).toBe(
      "/(provider)",
    );
    expect(resolveHome({ isApprovedProvider: false, role: ROLE.PUBLIC })).toBe(
      "/(browse)",
    );
    expect(resolveHome({ role: ROLE.PUBLIC })).toBe("/(browse)");
  });

  it("sends a provisioned account to its own group, password flag or not", () => {
    /*
     * A cook or warden signs in with the username and password its warden
     * issued and lands on its tabs. There is no set-password gate any more, so
     * a temporary password is simply a password — the account is not held
     * anywhere on its way in, and neither is an admin who arrives via Google
     * on a row that still carries the flag.
     */
    expect(resolveHome({ role: ROLE.COOK })).toBe("/(cook)");
    expect(resolveHome({ role: ROLE.WARDEN })).toBe("/(admin)");
    expect(resolveHome({ isResidentActivated: true, role: ROLE.RESIDENT })).toBe(
      "/(resident)",
    );
  });

  it("never lands a signed-in account on the login screen", () => {
    // A session always reaches a shell it can work from. Landing on `(auth)` is
    // the one answer that strands someone who is already signed in.
    const signedIn = [
      { isResidentActivated: true, role: ROLE.RESIDENT },
      { role: ROLE.GUARDIAN },
      { role: ROLE.COOK },
      { role: ROLE.WARDEN },
      { role: ROLE.HOSTEL_ADMIN },
      { role: ROLE.SUPERADMIN },
      { role: ROLE.PLATFORM_MODERATOR },
      { isApprovedProvider: true, role: ROLE.PUBLIC },
      { role: ROLE.PUBLIC },
    ] as const;

    for (const account of signedIn) {
      expect(resolveHome(account)).not.toBe("/(auth)/login");
    }
  });
});

describe("accentForAccount", () => {
  it("gives each audience its own chrome", () => {
    expect(accentForAccount(null)).toBe("PUBLIC");
    expect(accentForAccount({ role: ROLE.RESIDENT })).toBe("RESIDENT");
    expect(accentForAccount({ role: ROLE.GUARDIAN })).toBe("GUARDIAN");
    expect(accentForAccount({ role: ROLE.COOK })).toBe("COOK");
    expect(accentForAccount({ role: ROLE.WARDEN })).toBe("ADMIN");
    expect(accentForAccount({ isApprovedProvider: true, role: ROLE.PUBLIC })).toBe(
      "PROVIDER",
    );
  });
});
