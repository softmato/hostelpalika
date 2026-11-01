import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applySessionCookies, clearSessionCookies } from "@/lib/session-cookies";

const lines = (response: NextResponse) => response.headers.getSetCookie();
const tokens = { accessToken: "a", refreshToken: "r" };

afterEach(() => vi.unstubAllEnvs());

describe("COOKIE_DOMAIN", () => {
  it("unset: nothing carries a Domain and no extra lines are written", () => {
    vi.stubEnv("COOKIE_DOMAIN", "");
    const written = lines(applySessionCookies(NextResponse.json({}), tokens));

    expect(written.some((line) => /domain=/i.test(line))).toBe(false);
    expect(written.filter((line) => line.startsWith("hostelpalika_access_token="))).toHaveLength(1);
  });

  it("set: expires the host-only copies first, then writes the widened pair", () => {
    vi.stubEnv("COOKIE_DOMAIN", ".hostelpalika.com");
    const written = lines(applySessionCookies(NextResponse.json({}), tokens));

    expect(written[0]).toMatch(/^hostelpalika_access_token=; Path=\/; Max-Age=0/);
    expect(written[1]).toMatch(/^hostelpalika_refresh=; Path=\/; Max-Age=0/);
    expect(written[0]).not.toMatch(/domain=/i);
    expect(written.find((line) => line.startsWith("hostelpalika_access_token=a"))).toMatch(
      /Domain=\.hostelpalika\.com/,
    );
    expect(written.find((line) => line.startsWith("hostelpalika_refresh=r"))).toMatch(
      /Domain=\.hostelpalika\.com/,
    );
    // Old cookies only ever existed host-only; a Domain would miss them.
    expect(written.find((line) => line.startsWith("hostelhub_access_token="))).not.toMatch(/domain=/i);
  });

  it("set: a reuse-window refresh leaves the refresh cookie alone", () => {
    vi.stubEnv("COOKIE_DOMAIN", ".hostelpalika.com");
    const written = lines(applySessionCookies(NextResponse.json({}), { accessToken: "a", refreshToken: null }));

    expect(written.some((line) => line.startsWith("hostelpalika_refresh="))).toBe(false);
  });

  it("set: sign-out reaches both copies", () => {
    vi.stubEnv("COOKIE_DOMAIN", ".hostelpalika.com");
    const access = lines(clearSessionCookies(NextResponse.json({}))).filter((line) =>
      line.startsWith("hostelpalika_access_token="),
    );

    expect(access).toHaveLength(2);
    expect(access.filter((line) => /domain=/i.test(line))).toHaveLength(1);
  });
});
