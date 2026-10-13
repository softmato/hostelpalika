"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useSiteConfig } from "@/components/site-config-provider";
import { useSessionStore } from "@/stores/session-store";

/**
 * A quick sign-up's frozen pages on the website (docs/QUICK_SIGNUP_KYC_TRIAL.md,
 * decision 2) — the same features the app ices over. The API refuses their
 * writes on its own (`modules/hostels/hostel-kyc-lock.ts`); this keeps the
 * pages from being drawn at all until the KYC is approved.
 */
const FROZEN = [
  "/hostel-admin/attendance",
  "/hostel-admin/bookings",
  "/hostel-admin/branches",
  "/hostel-admin/expenses",
  "/hostel-admin/invite-hostels",
  "/hostel-admin/khata",
  "/hostel-admin/move-in-out",
  "/hostel-admin/night-status",
  "/hostel-admin/notifications",
  "/hostel-admin/payments",
  "/hostel-admin/reconcile",
  "/hostel-admin/referrals",
  "/hostel-admin/reports",
  "/hostel-admin/residents",
  "/hostel-admin/stock",
  "/hostel-admin/transactions",
  "/hostel-admin/wardens",
];

/** `/{slug}/admin/x` and `/hostel-admin/x` are one page. */
function canonicalPath(path: string) {
  return path.replace(/^\/[^/]+\/admin(?=\/|$)/, "/hostel-admin");
}

const under = (path: string, prefixes: string[]) => {
  const canonical = canonicalPath(path);

  return prefixes.some((prefix) => canonical === prefix || canonical.startsWith(`${prefix}/`));
};

export function isKycFrozenPortalPath(path: string) {
  return under(path, FROZEN);
}

/** What stays open once the trial is over without an approved KYC: the KYC and the pages it edits. */
const OPEN_AFTER_TRIAL = [
  "/hostel-admin/billing",
  "/hostel-admin/fee-schedule",
  "/hostel-admin/food",
  "/hostel-admin/kyc",
  "/hostel-admin/payment-gateways",
  "/hostel-admin/payment-setup",
  "/hostel-admin/profile",
  "/hostel-admin/rooms",
  "/hostel-admin/settings",
];

/** Past the trial with the KYC not approved (the API refuses the rest too: `TRIAL_ENDED_KYC`). */
export function useTrialEndedBlock(tone: string, pathname: string) {
  const { kyc, locked } = useKycPortalLock(tone);
  const endsAt = locked && kyc?.trialEndsAt ? Date.parse(kyc.trialEndsAt) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!Number.isFinite(endsAt) || now >= endsAt) return;

    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(endsAt - now + 1000, 2_147_000_000));

    return () => window.clearTimeout(timer);
  }, [endsAt, now]);

  return Number.isFinite(endsAt) && now >= endsAt && !under(pathname, OPEN_AFTER_TRIAL) ? kyc : null;
}

/** The portal, closed behind a frosted card: finish the KYC, or call us. */
export function TrialEndedOverlay({ status }: { status: string }) {
  const { identity } = useSiteConfig();
  const contact = identity.supportPhone
    ? `tel:${identity.supportPhone.replace(/\s/g, "")}`
    : identity.supportEmail
      ? `mailto:${identity.supportEmail}`
      : "/contact";

  return (
    <div
      aria-labelledby="trial-ended-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-md"
      role="dialog"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-xl">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border bg-muted">
          <Lock className="size-5 text-foreground" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-foreground" id="trial-ended-title">
          Your free trial has ended
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {status === "SUBMITTED"
            ? "Your KYC is with our team — we check it within 24 hours. Once it is approved, you can get your plan."
            : "Please complete your KYC first. Once our team approves it, you can get your plan."}{" "}
          You can also contact us to activate your plan.
        </p>
        <div className="mt-5 grid gap-2">
          <Button asChild>
            <Link href="/hostel-admin/kyc">{status === "SUBMITTED" ? "View KYC" : "Complete KYC"}</Link>
          </Button>
          <Button asChild variant="outline">
            <a href={contact}>Contact us</a>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function useKycPortalLock(tone: string) {
  const kyc = useSessionStore((state) => state.user?.hostelKyc ?? null);

  return { kyc, locked: tone === "admin" && Boolean(kyc?.locked) };
}

/** What a frozen page shows instead of itself. */
export function KycFrozenPage() {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-2xl border border-border bg-card p-6 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border bg-muted">
        <Lock className="size-5 text-foreground" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-foreground">Please complete KYC</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This opens once our team has approved your hostel KYC. Finish it and submit — we check it within 24
        hours.
      </p>
      <Button asChild className="mt-5">
        <Link href="/hostel-admin/kyc">Open KYC</Link>
      </Button>
    </div>
  );
}

/** "Congratulations — you got N days", once per hostel per browser. */
export function TrialWelcomeDialog({ tone }: { tone: string }) {
  const { kyc } = useKycPortalLock(tone);
  const [open, setOpen] = useState(false);
  const key = kyc && tone === "admin" ? `hostelpalika.trialWelcome.${kyc.hostelId}` : null;

  useEffect(() => {
    if (!key || !kyc?.trialDays) return;

    let live = true;

    // Read after paint; storage can throw (private mode), and then it simply stays shut.
    void Promise.resolve().then(() => {
      try {
        if (!live || window.localStorage.getItem(key)) return;
        window.localStorage.setItem(key, "1");
        setOpen(true);
      } catch {
        // Not shown rather than shown on every visit.
      }
    });

    return () => {
      live = false;
    };
  }, [key, kyc?.trialDays]);

  if (!kyc?.trialDays) return null;

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Congratulations! You got {kyc.trialDays} days free</AlertDialogTitle>
          <AlertDialogDescription>
            {kyc.hostelName || "Your hostel"} has its own portal now. Enjoy and explore. Complete your KYC to open
            every feature and list your hostel.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Start exploring</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Link href="/hostel-admin/kyc">Complete KYC</Link>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
