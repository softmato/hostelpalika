/**
 * What a notification looks like before it is read: the glyph in its tile, the
 * tone that tile is tinted, and the word on its chip.
 *
 * Its own module so it can be tested — Vitest here is node-side with no React
 * Native shim, so anything importing a component cannot be. Same split as
 * `lib/complaints.ts`, which is the other category-to-glyph table in the app and
 * the one this follows.
 *
 * ## Why a row needs a picture at all
 *
 * Every reference in `ui_inspiration_folder/app_recordings` leads a list row
 * with a tinted glyph — see NOTES §5 and §11 — and the bell is the one list in
 * this app whose rows come from *everywhere*. Rent, a complaint reply, a cook's
 * meal call, an SOS and a store delivery arrive in one column with nothing but a
 * sentence to tell them apart, and a reader scanning for the one that matters
 * ends up reading all of them. The glyph is what makes that scan work; the tone
 * is what makes "resolved" and "overdue" different before either is read.
 *
 * ## Two layers, because the category is not the event
 *
 * `category` says which part of the product sent the row — `PAYMENT`,
 * `RESIDENT`, `STORE_ORDER`. It does **not** say what happened, and the same
 * category carries opposite news: a payment received and a payment overdue are
 * both `PAYMENT`, a registration and a move-out are both `RESIDENT`. So:
 *
 * 1. {@link CATEGORY_VISUALS} gives every category its home glyph and label.
 * 2. {@link EVENT_VARIANTS} refines the glyph and the tone from the wording of
 *    the row itself — "registered", "shared", "delivered", "overdue".
 *
 * The category list mirrors what the server actually writes
 * (`createInAppNotification` call sites) plus everything `push-routing.ts` has a
 * destination for. An unmapped category is not a bug here: it falls back to a
 * neutral bell, which is what every row looked like before this file existed.
 *
 * ## The matching is word-bounded, and that is not fussiness
 *
 * `lib/status.ts` documents the trap this file would otherwise walk into: the
 * web's badge tests `includes("PAID")`, so `UNPAID` renders green. Every pattern
 * below is anchored on word boundaries, and the ones whose meaning inverts —
 * `unpaid` before `paid`, `overdue` before `due` — are ordered so the negative is
 * tested first. `notification-categories.test.ts` holds those pairs.
 *
 * ## Urgency is deliberately not a tone here
 *
 * A row's tile says *what happened*; the screen's left border says *how loudly*.
 * `app/notifications.tsx` draws urgent rows with a destructive edge and its own
 * note explains why that is an edge rather than a red card — colouring the tile
 * red as well would spend the alarm twice and leave no way to tell an urgent
 * complaint from a resolved one. `SOS` is the single exception: it is not an
 * ordinary event at a high priority, the alarm *is* the content.
 */

import type { Ionicons } from "@expo/vector-icons";

import { humanizeEnum } from "@/lib/format";

/**
 * The tile tones, which are `<CardRow>`'s tones and not `BadgeTone`.
 *
 * Deliberately the same five words the rest of the kit tints a leading square
 * with — `brand` where `BadgeTone` says `info` — so a tone chosen here can be
 * handed straight to a row without a translation table in between. A second
 * vocabulary for the same five colours is how two surfaces start disagreeing
 * about what amber means.
 */
export type NotificationTone = "brand" | "danger" | "neutral" | "success" | "warning";

export type NotificationVisual = {
  icon: keyof typeof Ionicons.glyphMap;
  /** The word on the row's chip — the category as a person would say it. */
  label: string;
  tone: NotificationTone;
};

/**
 * Outline glyphs, because the tile is already a filled shape.
 *
 * The rest of the app's tinted squares — the More menus, the complaint category
 * grid — are outline-on-tint, and a solid glyph inside a solid tint has no air
 * left in it at 19 points.
 */
const CATEGORY_VISUALS: Record<string, NotificationVisual> = {
  /** The account itself: profile, sign-in, credentials. */
  ACCOUNT: { icon: "person-circle-outline", label: "Account", tone: "brand" },
  ACCOUNT_DELETION: { icon: "trash-outline", label: "Account", tone: "danger" },
  ANNOUNCEMENT: { icon: "megaphone-outline", label: "Notice", tone: "brand" },
  ATTENDANCE: { icon: "finger-print-outline", label: "Attendance", tone: "brand" },
  /** A room booking: the guest's own, or a request to the hostel. */
  BOOKING: { icon: "calendar-outline", label: "Booking", tone: "brand" },
  COMMUNITY: { icon: "chatbubbles-outline", label: "Community", tone: "brand" },
  COMPLAINT: { icon: "chatbox-ellipses-outline", label: "Complaint", tone: "warning" },
  /** A trade. The provider portal's own jobs use the same two glyphs. */
  ELECTRICAL: { icon: "flash-outline", label: "Electrical", tone: "warning" },
  ELECTRICIAN: { icon: "flash-outline", label: "Electrical", tone: "warning" },
  FOOD: { icon: "restaurant-outline", label: "Food", tone: "brand" },
  GENERAL: { icon: "notifications-outline", label: "Update", tone: "neutral" },
  /** Platform to owner: a listing cleared for publication, or refused. */
  HOSTEL_APPROVAL: {
    icon: "shield-checkmark-outline",
    label: "Approval",
    tone: "brand",
  },
  /** Khata: a request to open one, an ask, an answer. The Khata card's own glyph. */
  KHATA: { icon: "receipt-outline", label: "Khata", tone: "brand" },
  /** A lead. `mail-outline` is what the portal's own Inquiries door uses. */
  INQUIRY: { icon: "mail-outline", label: "Inquiry", tone: "warning" },
  MAINTENANCE: { icon: "construct-outline", label: "Maintenance", tone: "warning" },
  /*
   * The nightly "are you in tonight?" prompt. A moon rather than the
   * fingerprint `ATTENDANCE` carries: the two are different signals — one is
   * what the phone was sensed doing, this is what the resident said — and a
   * shared glyph would put them in the same visual bucket in the one list where
   * they arrive side by side.
   */
  NIGHT_STATUS: { icon: "moon-outline", label: "Night status", tone: "brand" },
  NOTICE: { icon: "megaphone-outline", label: "Notice", tone: "brand" },
  PAYMENT: { icon: "wallet-outline", label: "Payment", tone: "brand" },
  PLUMBER: { icon: "water-outline", label: "Plumbing", tone: "warning" },
  PLUMBING: { icon: "water-outline", label: "Plumbing", tone: "warning" },
  RESIDENT: { icon: "people-outline", label: "Resident", tone: "brand" },
  REVIEW: { icon: "star-outline", label: "Review", tone: "brand" },
  ROOM: { icon: "bed-outline", label: "Room", tone: "brand" },
  SERVICE_PROVIDER: { icon: "briefcase-outline", label: "Provider", tone: "brand" },
  /**
   * The one category whose tile is red on its own account. Everything else earns
   * its colour from what happened.
   */
  SOS: { icon: "warning-outline", label: "SOS", tone: "danger" },
  /** Stock sent between buildings, and Got it. The Stock door's cube. */
  STOCK: { icon: "cube-outline", label: "Stock", tone: "warning" },
  STORE_ORDER: { icon: "bag-handle-outline", label: "Order", tone: "brand" },
  URGENT: { icon: "alert-circle-outline", label: "Urgent", tone: "danger" },
};

/** Anything the server sends that nobody has mapped. A bell, and no colour. */
const FALLBACK_VISUAL: NotificationVisual = {
  icon: "notifications-outline",
  label: "Update",
  tone: "neutral",
};

type EventVariant = {
  /** Limits the variant to these categories. Absent means every category. */
  categories?: readonly string[];
  icon: keyof typeof Ionicons.glyphMap;
  match: RegExp;
  tone: NotificationTone;
};

/**
 * What happened, read off the row's own wording. **Ordered — first match wins.**
 *
 * Two ordering rules, and both are load-bearing:
 *
 * 1. **A negative is tested before the positive it contains.** `unpaid` before
 *    `paid`, `overdue` before `due`, `declined` before `confirmed`. This is the
 *    `UNPAID`-renders-green bug from `lib/status.ts`, and word boundaries alone
 *    do not prevent it — "not paid" is two words, both of them boundaried.
 * 2. **The specific is tested before the general.** "Delivered" is more than
 *    "shipped"; "escalated" is more than "updated".
 *
 * Patterns are matched against the title *and* the body, because the two split
 * the news unpredictably: a title reads "Rent for Bhadra" and the body carries
 * "is now overdue".
 */
const EVENT_VARIANTS: readonly EventVariant[] = [
  /* Money that has not arrived — before any of the good news below it. */
  {
    categories: ["PAYMENT"],
    icon: "alert-circle-outline",
    match: /\b(overdue|unpaid|not paid|failed|declined|bounced)\b/i,
    tone: "danger",
  },
  {
    categories: ["PAYMENT"],
    icon: "arrow-undo-outline",
    match: /\b(refund|refunded|reversed|reversal)\b/i,
    tone: "neutral",
  },
  {
    categories: ["PAYMENT"],
    icon: "alarm-outline",
    match: /\b(due|reminder|pending|awaiting|outstanding)\b/i,
    tone: "warning",
  },
  {
    categories: ["PAYMENT"],
    icon: "wallet-outline",
    match: /\b(received|paid|settled|cleared|credited|confirmed)\b/i,
    tone: "success",
  },

  /* Somebody joined, or left. The registration case, in both its categories. */
  {
    categories: ["ACCOUNT", "RESIDENT"],
    icon: "person-add-outline",
    match: /\b(registered|registration|signed up|welcome|joined|moved in|onboarded)\b/i,
    tone: "success",
  },
  {
    categories: ["RESIDENT"],
    icon: "person-remove-outline",
    match: /\b(moved out|move-out|checked out|vacated)\b/i,
    tone: "neutral",
  },

  /* An order: on its way, and then there. */
  {
    categories: ["STORE_ORDER"],
    icon: "bag-check-outline",
    match: /\b(delivered|received)\b/i,
    tone: "success",
  },
  {
    categories: ["STORE_ORDER"],
    icon: "cube-outline",
    match: /\b(shipped|dispatched|on its way|out for delivery|packed)\b/i,
    tone: "brand",
  },

  /* Community, where the verb is the whole message. */
  {
    categories: ["COMMUNITY"],
    icon: "share-social-outline",
    match: /\b(shared|shares|reposted)\b/i,
    tone: "brand",
  },
  {
    categories: ["COMMUNITY"],
    icon: "at-outline",
    match: /\b(mentioned|tagged)\b/i,
    tone: "brand",
  },
  {
    categories: ["COMMUNITY"],
    icon: "chatbubble-ellipses-outline",
    match: /\b(commented|replied|reply|answered)\b/i,
    tone: "brand",
  },
  {
    categories: ["COMMUNITY"],
    icon: "heart-outline",
    match: /\b(reacted|reaction|liked|likes)\b/i,
    tone: "brand",
  },

  /*
   * Sign-in and credentials. Amber rather than red: a new sign-in is usually the
   * reader themselves, and a red tile on every login is how somebody learns to
   * ignore the one that was not.
   */
  {
    categories: ["ACCOUNT"],
    icon: "key-outline",
    match: /\b(otp|verification code|one-?time)\b/i,
    tone: "warning",
  },
  {
    categories: ["ACCOUNT"],
    icon: "shield-outline",
    match: /\b(sign-?in|signed in|log-?in|logged in|new device|password|security)\b/i,
    tone: "warning",
  },

  /* Outcomes, which read the same whichever queue they came out of. */
  {
    icon: "close-circle-outline",
    match: /\b(rejected|declined|denied|refused)\b/i,
    tone: "danger",
  },
  {
    icon: "trending-up-outline",
    match: /\b(escalated|breached|overdue)\b/i,
    tone: "danger",
  },
  {
    icon: "close-outline",
    match: /\b(cancelled|canceled|withdrawn)\b/i,
    tone: "neutral",
  },
  { icon: "time-outline", match: /\b(expired|lapsed)\b/i, tone: "neutral" },
  {
    icon: "shield-checkmark-outline",
    match: /\b(approved|verified|accepted|activated)\b/i,
    tone: "success",
  },
  /*
   * `ready` is deliberately absent. It is the kitchen's word — "Lunch is ready"
   * is the single most frequent notification the cook portal sends — and every
   * meal call was arriving as a green tick with no plate on it.
   */
  {
    icon: "checkmark-circle-outline",
    match: /\b(resolved|completed|closed)\b/i,
    tone: "success",
  },
  {
    icon: "calendar-outline",
    match: /\b(scheduled|assigned|booked|arriving)\b/i,
    tone: "brand",
  },
  {
    icon: "mail-open-outline",
    match: /\b(invited|invitation|invite)\b/i,
    tone: "brand",
  },
];

/**
 * The picture for one row.
 *
 * Takes a shape rather than an `AppNotification`, so the table stays usable
 * anywhere a category is known — a push payload, a preferences screen listing
 * what can be muted — and so the test can call it with two strings.
 */
export function notificationVisual(notification: {
  body?: string | null;
  category?: string | null;
  title?: string | null;
}): NotificationVisual {
  const category = notification.category?.trim().toUpperCase() ?? "";
  const mapped = CATEGORY_VISUALS[category];
  const base: NotificationVisual = mapped ?? {
    ...FALLBACK_VISUAL,
    /*
     * An unmapped category still names itself. `category` is free text on the
     * server — `notification.validation.ts` takes any string of 2–60 characters
     * — so a category shipped after this build exists is normal, and
     * "Store Promo" is a better chip than "Update".
     */
    label: category ? humanizeEnum(category) : FALLBACK_VISUAL.label,
  };

  /*
   * SOS never refines. "Resolved" appears in the body of a settled alert and
   * would turn that row green — and it is the one row on the screen that has to
   * still read as an alarm in a scan of the day.
   */
  if (category === "SOS") {
    return base;
  }

  const text = `${notification.title ?? ""} ${notification.body ?? ""}`;

  for (const variant of EVENT_VARIANTS) {
    if (variant.categories && !variant.categories.includes(category)) {
      continue;
    }

    if (variant.match.test(text)) {
      // The label stays the category's: the chip answers "which part of the
      // product is this from", which the wording has not changed.
      return { icon: variant.icon, label: base.label, tone: variant.tone };
    }
  }

  return base;
}

/** Every category with a picture of its own — for tests and for a mute list. */
export const NOTIFICATION_CATEGORIES = Object.keys(CATEGORY_VISUALS).sort();
