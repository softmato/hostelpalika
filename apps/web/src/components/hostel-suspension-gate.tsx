"use client";

import { Clock, Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { disableBrowserPush } from "@/lib/web-push-client";
import { type HostelSuspension, useSessionStore } from "@/stores/session-store";
import { signOutRequest } from "@/lib/sign-out";

/**
 * A hostel's plan suspension, as every portal tied to that hostel shows it.
 *
 * - **Pre-suspension**: the owner and wardens get a banner with a live
 *   countdown to the moment access stops. Residents and guardians see nothing
 *   yet, because nothing has changed for them.
 * - **Suspended**: the portal is replaced by one card nobody can get past. The
 *   owner is shown how to pay, because on the web we can; a warden is told to
 *   ask the owner; residents and guardians are told to ask the hostel.
 *
 * The state arrives with `/auth/me` (`PortalAccount` writes it to the session
 * store), and the flip from one stage to the next happens on the clock here, so
 * a portal left open over the deadline blocks on time without a reload. The API
 * refuses the hostel from the same instant on its own (`lib/api-auth.ts`) —
 * this is what that refusal looks like, not the refusal itself.
 *
 * The card is the web twin of the app's alert (`confirm-dialog.tsx` in
 * apps/mobile): centred, 14px corners, a hairline-divided action row, over a
 * blurred screen.
 */

/** Loaded only when an owner is actually looking at a suspended portal. */
const PayPlanPanel = dynamic(() =>
  import("@/app/_components/hostel-admin-pay-plan").then((mod) => mod.PayPlanPanel),
);

/** `setTimeout` keeps its delay in 32 bits; anything longer fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export type ActiveSuspension = HostelSuspension & { endsAt: number };

/** The hostel's own portals. The platform and team desks are ours to run. */
function isHostelPortal(tone: string) {
  return tone === "admin" || tone === "resident" || tone === "guardian";
}

export function useHostelSuspension(tone: string): ActiveSuspension | null {
  const suspension = useSessionStore((state) => state.user?.hostelSuspension ?? null);
  const endsAt = suspension ? Date.parse(suspension.graceEndsAt) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());

  // One timer to the deadline rather than a ticking clock: the shell re-renders
  // once, when the block lands.
  useEffect(() => {
    if (!Number.isFinite(endsAt) || now >= endsAt) {
      return;
    }

    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(0, endsAt - Date.now()) + 250, MAX_TIMEOUT_MS),
    );

    return () => window.clearTimeout(timer);
  }, [endsAt, now]);

  if (!suspension || !Number.isFinite(endsAt) || !isHostelPortal(tone)) {
    return null;
  }

  return {
    ...suspension,
    endsAt,
    stage: suspension.stage === "SUSPENDED" || now >= endsAt ? "SUSPENDED" : "PRE_SUSPENSION",
  };
}

function remainingLabel(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${Math.floor(total / 86_400)}d ${pad(Math.floor((total % 86_400) / 3600))}h ${pad(
    Math.floor((total % 3600) / 60),
  )}m ${pad(total % 60)}s`;
}

/** Pre-suspension, for the owner and wardens: what stops, and when, to the second. */
export function HostelSuspensionNotice({ suspension }: { suspension: ActiveSuspension }) {
  const role = useSessionStore((state) => state.user?.role);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Clock className="size-4 shrink-0 text-warning" />

        <p className="min-w-0 flex-1 text-sm text-foreground">
          <strong className="font-semibold">
            {suspension.reason === "TRIAL_ENDED"
              ? `${suspension.hostelName || "Your hostel"}'s free trial is ending.`
              : `${suspension.hostelName || "Your hostel"} has not paid its plan.`}
          </strong>{" "}
          {suspension.reason === "TRIAL_ENDED"
            ? "Choose a monthly or lifetime plan. Otherwise, access to your hostel portal stops in "
            : "Please check your email about your plan. Otherwise, access to your hostel portal stops in "}
          <span className="font-semibold tabular-nums">
            {remainingLabel(suspension.endsAt - now)}
          </span>
          .
        </p>

        {role === Role.HOSTEL_ADMIN ? (
          <Link
            className="inline-flex shrink-0 items-center rounded-lg bg-warning px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110"
            href="/hostel-admin/billing"
          >
            Pay now
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Suspended: the whole portal, replaced.
 *
 * Drawn over a shell that `PortalShell` has made `inert`, so neither a click nor
 * the Tab key reaches the navigation underneath. The only ways on are paying,
 * checking again after someone has, and signing out.
 */
export function HostelSuspendedScreen({
  suspension,
  tone,
}: {
  suspension: ActiveSuspension;
  tone: string;
}) {
  const role = useSessionStore((state) => state.user?.role);
  const [signingOut, setSigningOut] = useState(false);

  const hostel = suspension.hostelName || "Your hostel";
  const staff = tone === "admin";
  const owner = staff && role === Role.HOSTEL_ADMIN;

  const trial = suspension.reason === "TRIAL_ENDED";
  const title = staff ? (trial ? "Your free trial has ended" : "Hostel portal suspended") : "Service paused";
  const message = trial && owner
    ? `${hostel}'s free trial is over. Choose a monthly or lifetime plan to keep using the portal — it opens again as soon as the payment is confirmed.`
    : owner
    ? `${hostel} has not paid its plan, so the portal is suspended. Please pay now. It opens again as soon as the payment is confirmed.`
    : staff
      ? `${hostel} has not paid its plan, so the portal is suspended. Please ask the hostel owner to pay it. It opens again as soon as the payment is confirmed.`
      : `${hostel} has not paid its plan price. Please contact your hostel to pay it and continue the service.`;

  async function signOut() {
    setSigningOut(true);

    try {
      // Same order as `PortalAccount`: the push subscription goes before the session.
      await disableBrowserPush().catch(() => false);
      await signOutRequest();
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex overflow-y-auto bg-black/20 p-4 backdrop-blur-md dark:bg-black/45">
      <div
        aria-describedby="hostel-suspended-message"
        aria-labelledby="hostel-suspended-title"
        aria-modal="true"
        className={cn(
          "m-auto w-full overflow-hidden rounded-[14px] border border-border bg-card/95 shadow-2xl backdrop-blur-xl",
          owner ? "max-w-md" : "max-w-[18rem]",
        )}
        role="alertdialog"
      >
        <div className="px-4 pb-4 pt-5 text-center">
          <h2
            className="text-[17px] font-semibold leading-[22px] text-foreground"
            id="hostel-suspended-title"
          >
            {title}
          </h2>
          <p
            className="mt-1 text-[13px] leading-[18px] text-foreground"
            id="hostel-suspended-message"
          >
            {message}
          </p>
        </div>

        {owner ? (
          <div className="border-t border-border p-4 text-left">
            <PayPlanPanel />
          </div>
        ) : null}

        <div className="flex h-11 border-t border-border">
          <button
            className="flex-1 text-[17px] text-primary transition hover:bg-muted/60 disabled:text-muted-foreground"
            disabled={signingOut}
            onClick={() => window.location.reload()}
            type="button"
          >
            Check again
          </button>
          <div className="w-px bg-border" />
          <button
            className="flex flex-1 items-center justify-center text-[17px] font-semibold text-primary transition hover:bg-muted/60"
            disabled={signingOut}
            onClick={() => void signOut()}
            type="button"
          >
            {signingOut ? <Loader2 className="size-4 animate-spin" /> : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
