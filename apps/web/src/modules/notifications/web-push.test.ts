import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser transport, and the routing that decides where a click lands.
 *
 * The routing half carries most of the weight here. A wrong URL is the failure
 * mode with no error attached to it: the notification arrives, the person
 * clicks, and they get their own portal's guard telling them they are not
 * allowed — for a message the platform chose to send them.
 */

const mocks = vi.hoisted(() => ({
  connectToDatabase: vi.fn(),
  findDevices: vi.fn(),
  findUsers: vi.fn(),
  sendNotification: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));

vi.mock("@hostel/db/models/DeviceToken", () => ({
  DeviceTokenModel: { find: mocks.findDevices, updateMany: mocks.updateMany },
}));

vi.mock("@hostel/db/models/User", () => ({
  UserModel: { find: mocks.findUsers },
}));

vi.mock("web-push", () => ({
  default: {
    sendNotification: mocks.sendNotification,
    setVapidDetails: vi.fn(),
  },
}));

import { sendPushToUsers } from "@/modules/notifications/push.service";
import { webLinkForNotification } from "@/modules/notifications/web-routing";

type DeviceRow = {
  capabilities?: string[];
  keys?: { auth?: string; p256dh?: string };
  platform: string;
  token: string;
  userId: string;
};

/** `find().select().lean()` — the chain both services actually call. */
function devicesResolveTo(rows: DeviceRow[]) {
  mocks.findDevices.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(rows) }),
  });
}

function usersResolveTo(rows: { _id: string; role: string }[]) {
  mocks.findUsers.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(rows) }),
  });
}

function browser(userId: string, endpoint: string): DeviceRow {
  return {
    keys: { auth: "auth-secret", p256dh: "p256dh-public-key" },
    platform: "WEB",
    token: endpoint,
    userId,
  };
}

const payload = {
  body: "Your rent for Bhadra is due in 3 days.",
  category: "PAYMENT",
  data: { invoiceId: "inv-1" },
  title: "Payment due",
};

describe("browser push delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "test-public-key");
    vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
    vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.com");
    mocks.updateMany.mockResolvedValue({ modifiedCount: 1 });
    mocks.sendNotification.mockResolvedValue(undefined);
    // No phones in these cases; Expo must never be called.
    vi.stubGlobal("fetch", vi.fn());
  });

  it("sends to a subscribed browser without touching Expo", async () => {
    devicesResolveTo([browser("user-1", "https://fcm.googleapis.com/a")]);
    usersResolveTo([{ _id: "user-1", role: "RESIDENT" }]);

    const result = await sendPushToUsers(["user-1"], payload);

    expect(result.sent).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();

    const [subscription, body] = mocks.sendNotification.mock.calls[0];

    expect(subscription.endpoint).toBe("https://fcm.googleapis.com/a");
    expect(subscription.keys).toEqual({ auth: "auth-secret", p256dh: "p256dh-public-key" });
    expect(JSON.parse(body).title).toBe("Payment due");
  });

  it("routes the same notification to each recipient's own portal", async () => {
    devicesResolveTo([
      browser("resident-1", "https://fcm.googleapis.com/fcm/send/r"),
      browser("admin-1", "https://fcm.googleapis.com/fcm/send/a"),
    ]);
    usersResolveTo([
      { _id: "resident-1", role: "RESIDENT" },
      { _id: "admin-1", role: "HOSTEL_ADMIN" },
    ]);

    await sendPushToUsers(["resident-1", "admin-1"], {
      body: "A payment claim is waiting.",
      category: "PAYMENT",
      title: "Claim raised",
    });

    const urls = mocks.sendNotification.mock.calls.map(
      ([subscription, body]) => [subscription.endpoint, JSON.parse(body).url] as const,
    );

    expect(new Map(urls)).toEqual(
      new Map([
        ["https://fcm.googleapis.com/fcm/send/r", "/resident/payments"],
        ["https://fcm.googleapis.com/fcm/send/a", "/hostel-admin/payments"],
      ]),
    );
  });

  it("sends the installed app's subscription to the app's own screen, not the portal", async () => {
    devicesResolveTo([
      browser("resident-1", "https://fcm.googleapis.com/fcm/send/site"),
      { ...browser("resident-1", "https://fcm.googleapis.com/fcm/send/app"), capabilities: ["pwa"] },
    ]);
    usersResolveTo([{ _id: "resident-1", role: "RESIDENT" }]);

    await sendPushToUsers(["resident-1"], payload);

    const urls = new Map(
      mocks.sendNotification.mock.calls.map(
        ([subscription, body]) => [subscription.endpoint, JSON.parse(body).url] as const,
      ),
    );

    expect(urls.get("https://fcm.googleapis.com/fcm/send/site")).toMatch(/^\/resident\//);
    expect(urls.get("https://fcm.googleapis.com/fcm/send/app")).toMatch(/^\/app\?push=%2F/);
  });

  it("reaches a phone and a browser held by the same person", async () => {
    devicesResolveTo([
      { platform: "ANDROID", token: "ExponentPushToken[a]", userId: "user-1" },
      browser("user-1", "https://fcm.googleapis.com/fcm/send/b"),
    ]);
    usersResolveTo([{ _id: "user-1", role: "RESIDENT" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: [{ status: "ok" }] }),
        ok: true,
      }),
    );

    const result = await sendPushToUsers(["user-1"], payload);

    // One Expo ticket plus one web send — `sent` counts both transports.
    expect(result.sent).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("revokes an endpoint the push service reports as gone, and only that one", async () => {
    devicesResolveTo([
      browser("user-1", "https://fcm.googleapis.com/fcm/send/live"),
      browser("user-1", "https://fcm.googleapis.com/fcm/send/dead"),
    ]);
    usersResolveTo([{ _id: "user-1", role: "RESIDENT" }]);
    mocks.sendNotification.mockImplementation((subscription: { endpoint: string }) =>
      subscription.endpoint.endsWith("/dead")
        ? Promise.reject(Object.assign(new Error("Gone"), { statusCode: 410 }))
        : Promise.resolve(undefined),
    );

    const result = await sendPushToUsers(["user-1"], payload);

    expect(result.sent).toBe(1);

    const [filter, update] = mocks.updateMany.mock.calls[0];

    expect(filter.token).toEqual({ $in: ["https://fcm.googleapis.com/fcm/send/dead"] });
    expect(update.$set.status).toBe("REVOKED");
  });

  it("leaves an endpoint alone when the push service is merely unhappy", async () => {
    devicesResolveTo([browser("user-1", "https://fcm.googleapis.com/fcm/send/busy")]);
    usersResolveTo([{ _id: "user-1", role: "RESIDENT" }]);
    mocks.sendNotification.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), { statusCode: 429 }),
    );

    const result = await sendPushToUsers(["user-1"], payload);

    expect(result.sent).toBe(0);
    // A 429 is about right now, not about the subscription existing.
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  /*
   * Web Push has no batch endpoint: one encrypted HTTPS request per browser.
   * A platform-wide announcement is thousands of them, and firing the lot in
   * one tick is a self-inflicted outage on the notification that matters most.
   */
  it("bounds how many browsers it dials at once", async () => {
    const endpoints = Array.from({ length: 120 }, (_, index) =>
      browser("user-1", `https://fcm.googleapis.com/fcm/send/${index}`),
    );
    devicesResolveTo(endpoints);
    usersResolveTo([{ _id: "user-1", role: "RESIDENT" }]);

    let inFlight = 0;
    let peak = 0;

    mocks.sendNotification.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    const result = await sendPushToUsers(["user-1"], payload);

    expect(result.sent).toBe(120);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(120);
    expect(peak).toBeLessThanOrEqual(50);
  });

  it("skips a row whose encryption keys never arrived rather than revoking it", async () => {
    devicesResolveTo([
      { keys: {}, platform: "WEB", token: "https://fcm.googleapis.com/fcm/send/keyless", userId: "u" },
    ]);
    usersResolveTo([{ _id: "u", role: "RESIDENT" }]);

    const result = await sendPushToUsers(["u"], payload);

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  /*
   * Loaded fresh, because `web-push.service.ts` caches "VAPID is configured"
   * after the first successful send — `setVapidDetails` is process-wide state,
   * not per-call. Env does not change under a running deployment, so the cache
   * is right and the test has to reach around it rather than the other way up.
   */
  it("stays quiet when the deployment has no VAPID pair", async () => {
    vi.resetModules();
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    devicesResolveTo([browser("user-1", "https://fcm.googleapis.com/fcm/send/a")]);
    usersResolveTo([{ _id: "user-1", role: "RESIDENT" }]);

    const { sendPushToUsers: send } = await import(
      "@/modules/notifications/push.service"
    );
    const result = await send(["user-1"], payload);

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });
});

describe("webLinkForNotification", () => {
  it("prefers a hand-picked actionUrl over the category default", () => {
    expect(
      webLinkForNotification({
        actionUrl: "/hostel-admin/inquiries",
        category: "PAYMENT",
        role: "HOSTEL_ADMIN",
      }),
    ).toBe("/hostel-admin/inquiries");
  });

  it("refuses an actionUrl that is not a same-origin path", () => {
    // The service worker resolves whatever it is given against the origin and
    // opens a window on it, so an absolute or protocol-relative value here is
    // an open redirect with a click already attached.
    expect(
      webLinkForNotification({
        actionUrl: "https://evil.example",
        category: "FOOD",
        role: "RESIDENT",
      }),
    ).toBe("/resident/food");
    expect(
      webLinkForNotification({
        actionUrl: "//evil.example",
        category: "FOOD",
        role: "RESIDENT",
      }),
    ).toBe("/resident/food");
  });

  it("gives each portal its own screen for one category", () => {
    expect(webLinkForNotification({ category: "COMPLAINT", role: "RESIDENT" })).toBe(
      "/resident/complaints",
    );
    expect(webLinkForNotification({ category: "COMPLAINT", role: "HOSTEL_ADMIN" })).toBe(
      "/hostel-admin/complaints",
    );
    // A warden works the hostel portal, so it reads the admin's table.
    expect(webLinkForNotification({ category: "COMPLAINT", role: "WARDEN" })).toBe(
      "/hostel-admin/complaints",
    );
    expect(webLinkForNotification({ category: "COMPLAINT", role: "SUPERADMIN" })).toBe(
      "/platform/complaints",
    );
  });

  it("opens the record itself when the payload identifies one", () => {
    expect(
      webLinkForNotification({
        category: "PAYMENT",
        data: { invoiceId: "inv-9" },
        role: "RESIDENT",
      }),
    ).toBe("/resident/payments/inv-9");
    // An admin has no per-invoice page, so the id must not fabricate one.
    expect(
      webLinkForNotification({
        category: "PAYMENT",
        data: { invoiceId: "inv-9" },
        role: "HOSTEL_ADMIN",
      }),
    ).toBe("/hostel-admin/payments");
  });

  it("opens the hostel's own Billing page for a plan payment reminder", () => {
    const data = { hostelSlug: "rupa hostel", type: "PLAN_DUE" };

    expect(webLinkForNotification({ category: "PAYMENT", data, role: "HOSTEL_ADMIN" })).toBe(
      "/rupa%20hostel/admin/billing",
    );
    expect(
      webLinkForNotification({
        category: "PAYMENT",
        data: { type: "PLAN_DUE" },
        role: "HOSTEL_ADMIN",
      }),
    ).toBe("/hostel-admin/billing");
    // Not a page anyone outside the hostel admin portal can open.
    expect(webLinkForNotification({ category: "PAYMENT", data, role: "RESIDENT" })).toBe(
      "/resident/payments",
    );
  });

  it("sends the kitchen's copy of a food announcement to the kitchen screen", () => {
    expect(
      webLinkForNotification({
        category: "FOOD",
        data: { audience: "STAFF" },
        role: "WARDEN",
      }),
    ).toBe("/hostel-admin/food");
    expect(webLinkForNotification({ category: "FOOD", role: "RESIDENT" })).toBe(
      "/resident/food",
    );
  });

  it("falls back to the portal's own notification list, never to a dead end", () => {
    expect(
      webLinkForNotification({ category: "SOMETHING_UNMAPPED", role: "RESIDENT" }),
    ).toBe("/resident/notifications");
    expect(
      webLinkForNotification({ category: "SOMETHING_UNMAPPED", role: "GUARDIAN" }),
    ).toBe("/guardian/notifications");
    // No role known — an account whose row could not be read. Public ground.
    expect(webLinkForNotification({ category: "SOMETHING_UNMAPPED" })).toBe("/community");
  });

  it("keeps a store order on the website's own path, not the app's", () => {
    // `actionUrl` here is `/store/order/<id>`, which is a mobile screen.
    expect(
      webLinkForNotification({
        actionUrl: "/store/order/order-1",
        category: "STORE_ORDER",
        data: { orderId: "order-1" },
        role: "SUPERADMIN",
      }),
    ).toBe("/platform/store");
  });
});
