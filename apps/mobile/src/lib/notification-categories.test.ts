import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_CATEGORIES,
  notificationVisual,
} from "@/lib/notification-categories";

/**
 * The table itself is not worth asserting row by row — a test that restates a
 * map is a copy of it. What is worth asserting is everything the map *cannot*
 * express: the ordering rules between the variants, the words whose meaning
 * inverts, and the categories that refuse to be refined at all.
 */

describe("notificationVisual", () => {
  it("gives an unmapped category a bell and its own name", () => {
    const visual = notificationVisual({
      body: "Something happened.",
      category: "STORE_PROMO",
      title: "Promo",
    });

    expect(visual.icon).toBe("notifications");
    expect(visual.tone).toBe("neutral");
    // The server's own word, not "Update" — `category` is free text there.
    expect(visual.label).toBe("Store promo");
  });

  it("falls back to a bell when there is no category at all", () => {
    expect(notificationVisual({ title: "Hello" })).toEqual({
      icon: "notifications",
      label: "Update",
      tone: "neutral",
    });
  });

  it("leaves the kitchen's 'ready' alone", () => {
    /*
     * The most frequent notification in the product — the cook calling a meal —
     * and the reason `ready` is not in the completed-outcome pattern. A green
     * tick where the plate should be is what an over-eager keyword costs.
     */
    const visual = notificationVisual({
      body: "Dal bhat is ready in the dining hall.",
      category: "FOOD",
      title: "Lunch is served",
    });

    expect(visual).toEqual({ icon: "restaurant", label: "Food", tone: "brand" });
  });

  it("keeps the category's label when an event changes the glyph", () => {
    const visual = notificationVisual({
      body: "Your complaint about the shower has been resolved.",
      category: "COMPLAINT",
      title: "Complaint closed",
    });

    // The chip answers "which part of the product", which the outcome has not
    // changed — only the picture and the colour move.
    expect(visual.label).toBe("Complaint");
    expect(visual.icon).toBe("checkmark-circle");
    expect(visual.tone).toBe("success");
  });
});

/**
 * The `UNPAID` renders green trap, from `lib/status.ts`. Every pair below is a
 * word that contains, or reads like, the word for the opposite outcome.
 */
describe("words whose meaning inverts", () => {
  it("does not read UNPAID as paid", () => {
    expect(
      notificationVisual({
        body: "Bhadra rent is still unpaid.",
        category: "PAYMENT",
        title: "Rent unpaid",
      }).tone,
    ).toBe("danger");
  });

  it("does not read 'not paid' as paid", () => {
    expect(
      notificationVisual({
        body: "This invoice has not paid out yet.",
        category: "PAYMENT",
        title: "Rent",
      }).tone,
    ).toBe("danger");
  });

  it("reads an actual payment as success", () => {
    const visual = notificationVisual({
      body: "NPR 8,500 received from Sita Gurung.",
      category: "PAYMENT",
      title: "Payment received",
    });

    expect(visual.icon).toBe("wallet");
    expect(visual.tone).toBe("success");
  });

  it("reads overdue before due", () => {
    const visual = notificationVisual({
      body: "Rent for Bhadra is now overdue.",
      category: "PAYMENT",
      title: "Rent overdue",
    });

    expect(visual.icon).toBe("alert-circle");
    expect(visual.tone).toBe("danger");
  });

  it("reads a plain due date as a warning, not a failure", () => {
    const visual = notificationVisual({
      body: "Rent for Bhadra is due on the 5th.",
      category: "PAYMENT",
      title: "Rent reminder",
    });

    expect(visual.icon).toBe("alarm");
    expect(visual.tone).toBe("warning");
  });

  it("reads a refund as neither good news nor bad", () => {
    const visual = notificationVisual({
      body: "NPR 1,200 has been refunded to you.",
      category: "PAYMENT",
      title: "Refund issued",
    });

    expect(visual.icon).toBe("arrow-undo");
    expect(visual.tone).toBe("neutral");
  });
});

describe("the events with their own picture", () => {
  it("marks a successful registration", () => {
    const visual = notificationVisual({
      body: "Sita Gurung has registered and is waiting for a room.",
      category: "RESIDENT",
      title: "New resident registered",
    });

    expect(visual.icon).toBe("person-add");
    expect(visual.tone).toBe("success");
  });

  it("marks the account holder's own signup the same way", () => {
    const visual = notificationVisual({
      body: "Welcome to HostelPalika.",
      category: "ACCOUNT",
      title: "Registration successful",
    });

    expect(visual.icon).toBe("person-add");
    expect(visual.tone).toBe("success");
  });

  it("marks a move-out as neither", () => {
    expect(
      notificationVisual({
        body: "Ram Thapa has moved out of room 204.",
        category: "RESIDENT",
        title: "Resident moved out",
      }).icon,
    ).toBe("person-remove");
  });

  it("marks a shared post", () => {
    const visual = notificationVisual({
      body: "Anita shared your post with the hostel.",
      category: "COMMUNITY",
      title: "Your post was shared",
    });

    expect(visual.icon).toBe("share-social");
  });

  it("tells a mention from a comment from a reaction", () => {
    const mention = notificationVisual({
      body: "Anita mentioned you in a comment.",
      category: "COMMUNITY",
      title: "You were mentioned",
    });
    const comment = notificationVisual({
      body: "Anita commented on your post.",
      category: "COMMUNITY",
      title: "New comment",
    });
    const reaction = notificationVisual({
      body: "5 people reacted to your post.",
      category: "COMMUNITY",
      title: "Reactions",
    });

    expect(mention.icon).toBe("at");
    expect(comment.icon).toBe("chatbubble-ellipses");
    expect(reaction.icon).toBe("heart");
  });

  it("tells a delivered order from one still on its way", () => {
    expect(
      notificationVisual({
        body: "Your order has been delivered.",
        category: "STORE_ORDER",
        title: "Order delivered",
      }).icon,
    ).toBe("bag-check");

    expect(
      notificationVisual({
        body: "Your order has been shipped and is on its way.",
        category: "STORE_ORDER",
        title: "Order shipped",
      }).icon,
    ).toBe("cube");
  });

  it("treats a new sign-in as amber rather than red", () => {
    const visual = notificationVisual({
      body: "A new device signed in to your account.",
      category: "ACCOUNT",
      title: "Security alert",
    });

    expect(visual.icon).toBe("shield");
    expect(visual.tone).toBe("warning");
  });
});

describe("scoping", () => {
  it("does not apply a payment word to another category", () => {
    // "Due" in a notice is a date, not money — the payment variants are scoped
    // so a notice about a due date does not turn amber and grow an alarm clock.
    const visual = notificationVisual({
      body: "The water tank clean is due this week.",
      category: "NOTICE",
      title: "Tank cleaning",
    });

    expect(visual.icon).toBe("megaphone");
    expect(visual.tone).toBe("brand");
  });

  it("applies an outcome word to any category", () => {
    expect(
      notificationVisual({
        body: "Your hostel listing was approved.",
        category: "HOSTEL_APPROVAL",
        title: "Listing approved",
      }).tone,
    ).toBe("success");
  });

  it("never refines an SOS, whatever its body says", () => {
    const visual = notificationVisual({
      body: "The alert has been resolved by the warden.",
      category: "SOS",
      title: "SOS resolved",
    });

    // Green here would be the one row on the screen that has to still read as an
    // alarm when the day is scanned.
    expect(visual.icon).toBe("warning");
    expect(visual.tone).toBe("danger");
  });

  it("is case-insensitive about the category the server sent", () => {
    expect(notificationVisual({ category: "payment", title: "Rent" }).label).toBe(
      "Payment",
    );
  });
});

describe("NOTIFICATION_CATEGORIES", () => {
  it("covers every category the server writes today", () => {
    // From the `createInAppNotification` call sites in `apps/web/src/modules`,
    // plus everything `push-routing.ts` maps to a destination. A category added
    // there without one here still renders — as a bell — so this is a nudge, not
    // a wall.
    for (const category of [
      "ACCOUNT",
      "ACCOUNT_DELETION",
      "ANNOUNCEMENT",
      "ATTENDANCE",
      "COMMUNITY",
      "COMPLAINT",
      "FOOD",
      "HOSTEL_APPROVAL",
      "INQUIRY",
      "MAINTENANCE",
      "NOTICE",
      "PAYMENT",
      "RESIDENT",
      "SERVICE_PROVIDER",
      "SOS",
      "STORE_ORDER",
    ]) {
      expect(NOTIFICATION_CATEGORIES).toContain(category);
    }
  });
});
