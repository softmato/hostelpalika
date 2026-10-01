import { describe, expect, it } from "vitest";

import {
  marksRoleChange,
  notificationRoute,
  opensPlanBilling,
  PUSH_FALLBACK_PATH,
  resolvePushPath,
} from "@/lib/push-link";

describe("opensPlanBilling", () => {
  it("recognises a plan payment reminder in the bell", () => {
    expect(opensPlanBilling({ category: "PAYMENT", data: { type: "PLAN_DUE" } })).toBe(true);
  });

  it("leaves a resident's rent row and a malformed payload alone", () => {
    expect(opensPlanBilling({ category: "PAYMENT", data: { invoiceId: "inv-1" } })).toBe(false);
    expect(opensPlanBilling({ category: "FOOD", data: { type: "PLAN_DUE" } })).toBe(false);
    expect(opensPlanBilling({ category: "PAYMENT" })).toBe(false);
    expect(opensPlanBilling({ category: "PAYMENT", data: "PLAN_DUE" })).toBe(false);
  });
});

describe("resolvePushPath", () => {
  it("passes through a route that exists", () => {
    expect(resolvePushPath("/(resident)/payments")).toBe("/(resident)/payments");
    expect(resolvePushPath("/(admin)/alerts")).toBe("/(admin)/alerts");
    // The tabs the retab added. A push about money has somewhere to land that
    // can act on it.
    expect(resolvePushPath("/(admin)/money")).toBe("/(admin)/money");
    expect(resolvePushPath("/(admin)/today")).toBe("/(admin)/today");
    expect(resolvePushPath("/notifications")).toBe("/notifications");
    // Where a plan payment reminder lands.
    expect(resolvePushPath("/manage/billing")).toBe("/manage/billing");
  });

  /*
   * The one the server gets wrong rather than early: M3 put invoice detail on
   * the root stack, because a folder under a `<Tabs>` layout becomes a tab.
   */
  it("moves an invoice deep link onto the root stack", () => {
    expect(resolvePushPath("/(resident)/payments/64f0c1a2b3")).toBe("/invoice/64f0c1a2b3");
  });

  /*
   * M5.2 built these, on the root stack for the same reason invoices are there.
   * The list form matters as much as the detail one: without its own match the
   * `/(resident)/more/` rewrite would swallow it and send a complaint push to
   * the menu that links to complaints.
   */
  it("moves a complaint deep link onto the root stack", () => {
    expect(resolvePushPath("/(resident)/more/complaints")).toBe("/complaints");
    expect(resolvePushPath("/(resident)/more/complaints/abc123")).toBe(
      "/complaints/abc123",
    );
  });

  it("does not mistake a deeper complaints path for a detail route", () => {
    expect(resolvePushPath("/(resident)/more/complaints/abc/def")).toBe(
      "/(resident)/more",
    );
  });

  /*
   * The website paths that arrive as an `actionUrl`, which
   * `deepLinkForNotification` prefers over the category default. Each one is a
   * real screen in this build under a different name; without the rewrite a
   * maintenance job, a review or a guardian notification lands on the list the
   * user just came from.
   */
  it("maps the website paths carried by the newer notifications", () => {
    expect(resolvePushPath("/hostel-admin/maintenance")).toBe("/manage/maintenance");
    expect(resolvePushPath("/hostel-admin/reports")).toBe("/manage/reports");
    expect(resolvePushPath("/resident/guardians")).toBe("/guardians");
    expect(resolvePushPath("/guardian/dashboard")).toBe("/(guardian)");
  });

  // The resident's own guardian list is a real route, so it passes through
  // rather than being rewritten.
  it("opens a join link to fix a request that was sent back", () => {
    expect(resolvePushPath("/join/aB3_x-9Qz0Kp")).toBe("/join/aB3_x-9Qz0Kp");
    expect(resolvePushPath("/join/../admin")).toBe(PUSH_FALLBACK_PATH);
  });

  it("passes the guardians list through untouched", () => {
    expect(resolvePushPath("/guardians")).toBe("/guardians");
  });

  // M5.4. Ordered before the generic `/(resident)/more/` rewrite, which would
  // otherwise send it to the menu that links to it.
  it("moves a profile deep link onto the root stack", () => {
    expect(resolvePushPath("/(resident)/more/profile")).toBe("/profile");
  });

  // M5.7, same shape.
  it("moves a reviews deep link onto the root stack", () => {
    expect(resolvePushPath("/(resident)/more/reviews")).toBe("/review");
  });

  // M5.9, the last of them.
  it("moves a settings deep link onto the root stack", () => {
    expect(resolvePushPath("/(resident)/more/settings")).toBe("/settings");
  });

  /*
   * Attendance is the only `/(resident)/more/*` path left with no screen — it is
   * M7 work — so it is what keeps the generic rewrite earning its place.
   */
  it("still sends an unbuilt screen to the More tab that lists it", () => {
    expect(resolvePushPath("/(resident)/more/attendance")).toBe("/(resident)/more");
  });

  it("collapses a notice deep link onto the list, which is where reading happens", () => {
    expect(resolvePushPath("/(resident)/notices/abc123")).toBe("/(resident)/notices");
    expect(resolvePushPath("/(resident)/notices")).toBe("/(resident)/notices");
  });

  // M5.8. The one server path that was already right — the app puts community
  // where the web does — so these pass through rather than being rewritten.
  it("passes a community deep link straight through", () => {
    expect(resolvePushPath("/community")).toBe("/community");
    expect(resolvePushPath("/community/post-1")).toBe("/community/post-1");
  });

  it("still falls back for a community path with extra segments", () => {
    expect(resolvePushPath("/community/post-1/comments")).toBe(PUSH_FALLBACK_PATH);
  });

  /*
   * The server strips these before sending. Doing it again here is the point:
   * trusting a network-supplied path because another service promised to clean
   * it is one server bug away from routing anywhere.
   */
  it("refuses anything that is not a single-slash local path", () => {
    expect(resolvePushPath("//evil.example")).toBe(PUSH_FALLBACK_PATH);
    expect(resolvePushPath("https://evil.example/x")).toBe(PUSH_FALLBACK_PATH);
    expect(resolvePushPath("hostelpalika://ref/ABC")).toBe(PUSH_FALLBACK_PATH);
    expect(resolvePushPath("(resident)/payments")).toBe(PUSH_FALLBACK_PATH);
  });

  it("survives a missing or non-string path", () => {
    expect(resolvePushPath(undefined)).toBe(PUSH_FALLBACK_PATH);
    expect(resolvePushPath(null)).toBe(PUSH_FALLBACK_PATH);
    expect(resolvePushPath(42)).toBe(PUSH_FALLBACK_PATH);
    expect(resolvePushPath("")).toBe(PUSH_FALLBACK_PATH);
  });

  it("ignores a trailing slash, a query string and a fragment", () => {
    expect(resolvePushPath("/(resident)/payments/")).toBe("/(resident)/payments");
    expect(resolvePushPath("/(resident)/payments?from=push")).toBe("/(resident)/payments");
    expect(resolvePushPath("/(resident)/food#today")).toBe("/(resident)/food");
    expect(resolvePushPath("  /(resident)/food  ")).toBe("/(resident)/food");
  });

  it("does not mistake a payments path with extra segments for an invoice", () => {
    expect(resolvePushPath("/(resident)/payments/abc/def")).toBe(PUSH_FALLBACK_PATH);
  });

  /*
   * `/jobs` is the provider's only screen on the website, and the approval
   * notification carries it as an `actionUrl`. Unrewritten it is not a route in
   * this build, so the one push that converts the app into the provider app
   * would land on the notification list.
   */
  it("sends the web provider job feed to the provider tabs", () => {
    expect(resolvePushPath("/jobs")).toBe("/(provider)");
  });

  /* Where a refused applicant can send a corrected application. */
  it("routes a provider rejection to the landing screen", () => {
    expect(resolvePushPath("/service-providers")).toBe("/service-providers");
  });
});

/**
 * The one push that changes what app this is.
 *
 * `usePush` rotates the access token and replaces the shell when this is true,
 * so a false positive throws somebody out of the screen they are reading and a
 * false negative leaves a paid-up resident stuck in the browsing app until
 * their token expires. The string is frozen in two places on purpose — here,
 * and in the server's `resident-registered-notify.ts`.
 */
describe("marksRoleChange", () => {
  it("recognises the registration push", () => {
    expect(marksRoleChange({ type: "RESIDENT_REGISTERED" })).toBe(true);
    expect(marksRoleChange({ invoiceId: "inv-1", type: "RESIDENT_REGISTERED" })).toBe(
      true,
    );
  });

  /*
   * Without this, an approved provider keeps the hostel-shopping shell until the
   * app is killed and cold-started — the whole reason the server sends it.
   */
  it("recognises the provider approval push", () => {
    expect(marksRoleChange({ type: "SERVICE_PROVIDER_APPROVED" })).toBe(true);
    expect(
      marksRoleChange({ providerId: "p-1", type: "SERVICE_PROVIDER_APPROVED" }),
    ).toBe(true);
  });

  /* A refusal changes no role, so it must not rotate the token or re-route. */
  it("does not treat a rejection as a role change", () => {
    expect(marksRoleChange({ type: "SERVICE_PROVIDER_REJECTED" })).toBe(false);
  });

  it("ignores every other notification", () => {
    expect(marksRoleChange({ type: "DOWNLOAD_COMPLETE" })).toBe(false);
    expect(marksRoleChange({ invoiceId: "inv-1" })).toBe(false);
    expect(marksRoleChange({ category: "PAYMENT" })).toBe(false);
  });

  /*
   * `data` is network input written by many call sites, and an older server
   * build sends no `type` at all. None of those may throw inside a notification
   * listener — an exception there loses the tap.
   */
  it("survives a payload that is missing, empty or the wrong shape", () => {
    expect(marksRoleChange(undefined)).toBe(false);
    expect(marksRoleChange(null)).toBe(false);
    expect(marksRoleChange({})).toBe(false);
    expect(marksRoleChange("RESIDENT_REGISTERED")).toBe(false);
    expect(marksRoleChange({ type: 42 })).toBe(false);
  });
});

describe("notificationRoute", () => {
  it("opens the screen a row's push would", () => {
    expect(notificationRoute({ actionUrl: "/hostel-admin/inquiries" })).toBe("/manage/inquiries");
    expect(notificationRoute({ actionUrl: "/hostel-admin/payments" })).toBe("/(admin)/money");
    expect(notificationRoute({ actionUrl: "/resident/payments" })).toBe("/(resident)/payments");
    expect(notificationRoute({ actionUrl: "/bookings/b1" })).toBe("/booking/b1");
    expect(notificationRoute({ actionUrl: "/store/order/o1" })).toBe("/store/order/o1");
    expect(notificationRoute({ actionUrl: "/join/abc_12" })).toBe("/join/abc_12");
  });

  it("sends a join request to the requests screen, not the roster its actionUrl names", () => {
    expect(
      notificationRoute({ actionUrl: "/hostel-admin/residents", data: { type: "JOIN_REQUEST" } }),
    ).toBe("/manage/join-requests");
  });

  it("keeps the plan reminder on Billing", () => {
    expect(
      notificationRoute({ actionUrl: "/rupa-hostel/admin/billing", category: "PAYMENT", data: { type: "PLAN_DUE" } }),
    ).toBe("/manage/billing");
  });

  it("expands a row nothing in the app can open", () => {
    expect(notificationRoute({ actionUrl: "/platform/hostels" })).toBeNull();
    expect(notificationRoute({ actionUrl: "https://evil.example" })).toBeNull();
    expect(notificationRoute({})).toBeNull();
  });
});
