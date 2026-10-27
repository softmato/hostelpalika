import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: {} }));

import { mergeFeed } from "@/lib/notification-queries";
import type { AppNotification, NotificationFeed } from "@/lib/notifications-api";

const row = (id: string, isRead = false): AppNotification => ({
  body: "",
  category: "SYSTEM",
  id,
  isRead,
  needsAction: false,
  priority: "NORMAL",
  title: id,
});
const feed = (rows: AppNotification[], unreadCount: number): NotificationFeed => ({
  actionCount: 0,
  notifications: rows,
  unreadCount,
});

describe("notification feed merge (F1)", () => {
  it("puts newer rows on top, keeps cached ones once, takes the server's counts", () => {
    const merged = mergeFeed(feed([row("b"), row("a", true)], 1), feed([row("c"), row("b")], 2));
    expect(merged.notifications.map((n) => n.id)).toEqual(["c", "b", "a"]);
    expect(merged.unreadCount).toBe(2);
  });

  it("marks cached rows read when the server says nothing is unread", () => {
    const merged = mergeFeed(feed([row("a")], 1), feed([], 0));
    expect(merged.notifications[0].isRead).toBe(true);
  });

  it("takes a full page of newer rows alone — there may be a gap behind it", () => {
    const page = Array.from({ length: 100 }, (_, i) => row(`n${i}`));
    expect(mergeFeed(feed([row("old")], 1), feed(page, 100)).notifications).toHaveLength(100);
  });
});
