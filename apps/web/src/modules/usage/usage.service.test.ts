import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/Hostel", () => ({ HostelModel: {} }));
vi.mock("@hostel/db/models/User", () => ({ UserModel: {} }));
vi.mock("@hostel/db/models/UsageDaily", () => ({ UsageDailyModel: {} }));
vi.mock("@hostel/db/models/UsageEvent", () => ({ UsageEventModel: {} }));

import { rollUpUsage, usageFeature, usagePath } from "./usage.service";

const NOW = Date.parse("2026-10-28T00:00:00Z");

describe("usage roll-up", () => {
  it("strips ids, tenant slugs and queries from names", () => {
    expect(usagePath("/education-light/admin/residents/66ab12cd34ef56ab12cd34ef?tab=dues")).toBe(
      "/:hostel/admin/residents/:id",
    );
    expect(usagePath("/manage/scan/[residentId]")).toBe("/manage/scan/[residentId]");
    expect(usageFeature("post https://hostelpalika.com/api/v1/hostel-admin/expenses/123")).toBe(
      "POST /hostel-admin/expenses/:id",
    );
  });

  it("sums opens, views, time and uses per Nepal day, and drops stale or nameless events", () => {
    const { events, rows } = rollUpUsage(
      [
        { at: new Date("2026-10-27T10:00:00Z"), kind: "open" },
        { at: new Date("2026-10-27T10:00:05Z"), kind: "open" },
        { at: new Date("2026-10-27T10:01:00Z"), durationMs: 4000, kind: "screen", screen: "/(admin)/residents" },
        { at: new Date("2026-10-27T10:02:00Z"), durationMs: 6000, kind: "screen", screen: "/(admin)/residents" },
        // 19:00 UTC is already the 28th in Nepal (UTC+5:45).
        { at: new Date("2026-10-27T19:00:00Z"), durationMs: 1000, kind: "screen", screen: "/(admin)/residents" },
        { at: new Date("2026-10-27T10:03:00Z"), feature: "POST /hostel-admin/expenses", kind: "feature" },
        { at: new Date("2026-10-27T10:04:00Z"), kind: "screen" },
        { at: new Date("2026-10-01T10:00:00Z"), kind: "open" },
      ],
      NOW,
    );

    expect(events).toHaveLength(6);
    expect(rows).toEqual([
      { day: "2026-10-27", durationMs: 0, feature: "", opens: 2, screen: "", uses: 0, views: 0 },
      { day: "2026-10-27", durationMs: 10000, feature: "", opens: 0, screen: "/(admin)/residents", uses: 0, views: 2 },
      { day: "2026-10-28", durationMs: 1000, feature: "", opens: 0, screen: "/(admin)/residents", uses: 0, views: 1 },
      { day: "2026-10-27", durationMs: 0, feature: "POST /hostel-admin/expenses", opens: 0, screen: "", uses: 1, views: 0 },
    ]);
  });
});
