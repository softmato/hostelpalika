"use client";

import { Bell, BellOff, BellRing, Loader2 } from "@/components/icons";
import { useEffect, useState } from "react";

import {
  disableBrowserPush,
  enableBrowserPush,
  readPushSupport,
  resyncBrowserPush,
} from "@/lib/web-push-client";
import { toast } from "@/stores/toast-store";

/**
 * Browser notifications for a signed-in account that is not in a portal.
 *
 * ## The gap this closes
 *
 * The only place the product ever offered to turn browser push on was the bell
 * in `portal-shell` — which renders for staff, residents and guardians, and for
 * nobody else. A PUBLIC account browsing hostels therefore had no subscription
 * on file, and `sendPushToUsers` had no endpoint to deliver to.
 *
 * That is exactly the account that most needs one. The first push a person ever
 * receives from this product is "you are registered": a hostel takes them on,
 * `promoteAccountToResident` raises their account to RESIDENT, invoices are
 * raised with reference codes and `notifyResidentRegistered` fans the news out
 * to their devices. On a phone the app has already registered a token at the
 * root layout, so it lands. On a laptop it landed nowhere, because the only
 * screen that could have asked for permission was the resident portal they did
 * not have yet.
 *
 * ## Asked, never assumed
 *
 * `Notification.requestPermission()` is ignored by Chrome and refused outright
 * by Safari unless it comes from a user gesture, and a permission prompt thrown
 * at somebody reading a hostel listing is how a site gets permanently denied. So
 * this is a button in the account menu and nothing more.
 *
 * The one thing it does unprompted is {@link resyncBrowserPush} when permission
 * is *already* granted — that costs one request and repairs the cases where the
 * browser still believes it is subscribed and the server no longer has the row:
 * a pruned endpoint, a rotated VAPID key, or another account having signed in on
 * this machine. Without it, somebody who enabled push as a resident last month
 * and signed in again today is silently unreachable.
 */
export function PublicPushOptIn({ onDone }: { onDone?: () => void }) {
  const [support, setSupport] = useState(() => ({
    permission: "default" as NotificationPermission,
    supported: false,
  }));
  const [busy, setBusy] = useState(false);

  /*
   * Read once on mount, and repair a grant that the server has lost track of.
   *
   * Deliberately not re-run on focus: this is a repair, not a poll — the same
   * shape the portal bell settled on for the same reason.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const current = readPushSupport();

      if (current.supported && current.permission === "granted") {
        await resyncBrowserPush();
      }

      if (!cancelled) {
        setSupport(current);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to offer, and no row to explain: a browser that cannot do this at
  // all should not carry a dead control in its account menu.
  if (!support.supported) {
    return null;
  }

  async function enable() {
    setBusy(true);

    try {
      const result = await enableBrowserPush();

      if (result.ok) {
        setSupport(readPushSupport());
        toast.success(
          "Notifications on. You will hear about your registration, invoices and notices even with this tab closed.",
        );
      } else if (result.reason === "denied") {
        setSupport(readPushSupport());
        toast.error(
          "Your browser is blocking notifications for this site. Allow them in its site settings to turn this on.",
        );
      } else {
        toast.error("Notifications could not be turned on. Try again in a moment.");
      }
    } finally {
      setBusy(false);
      onDone?.();
    }
  }

  async function disable() {
    setBusy(true);

    try {
      await disableBrowserPush();
      setSupport(readPushSupport());
      toast.success("Notifications off for this browser.");
    } finally {
      setBusy(false);
      onDone?.();
    }
  }

  if (support.permission === "denied") {
    return (
      <span className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground">
        <BellOff className="size-4" />
        Notifications blocked
      </span>
    );
  }

  const on = support.permission === "granted";

  return (
    <button
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-muted disabled:opacity-60"
      disabled={busy}
      onClick={() => void (on ? disable() : enable())}
      type="button"
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : on ? (
        <BellRing className="size-4" />
      ) : (
        <Bell className="size-4" />
      )}
      {on ? "Notifications on" : "Turn on notifications"}
    </button>
  );
}
