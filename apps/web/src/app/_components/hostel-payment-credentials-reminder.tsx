"use client";

import { ShieldAlert, Wallet, X } from "@/components/icons";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { browserApi } from "@/lib/browser-api";

const DISMISS_KEY = "hostel-payment-credentials-reminder-dismissed";

type ProfileSummary = {
  payeeVerifiable?: boolean;
  staticQrAssetId?: string | null;
  usable?: boolean;
};

type Gap = "NO_CREDENTIAL" | "NO_METHOD" | "QR_UNREAD";

/**
 * The three ways a payment profile can leave us unable to check a receipt.
 *
 * `NO_METHOD` is the obvious failure: nothing is set, so the resident pay screen
 * has nothing to render and residents cannot pay at all. It is loud and it is
 * not dismissible — dismissing it would hide the reason the hostel is collecting
 * no money.
 *
 * `QR_UNREAD` is the interesting one, and it is narrow on purpose. A QR poster
 * prints the account name and number beside the code, so uploading one normally
 * *is* setting a credential — `readQrPayee` lifts it at upload and the hostel is
 * verifiable without typing anything. This fires only when that read came back
 * empty: a dark photo of a standee, an unusual layout, a recogniser that could
 * not run. The hostel is collecting money perfectly well; we just cannot yet
 * recognise it on the receipts coming back, and two fields fix it.
 *
 * `NO_CREDENTIAL` is the same gap reached without a QR at all — a hostel with a
 * gateway and no account details.
 */
const COPY: Record<Gap, { body: string; cta: string; title: string }> = {
  NO_CREDENTIAL: {
    body:
      "Add at least one payment credential — bank account number, eSewa or Khalti ID, or upload your payment QR. Residents can already pay you, but without one we cannot check that a payment receipt was actually paid to you, so every proof has to be verified by hand.",
    cta: "Add credentials",
    title: "We cannot verify payment receipts yet",
  },
  QR_UNREAD: {
    body:
      "We could not read the account name and number printed on your QR, so we cannot check that a payment receipt was actually paid to you. Please type them in once — they are on the poster itself, beside the code.",
    cta: "Fill in QR details",
    title: "Tell us what your QR says",
  },
  NO_METHOD: {
    body:
      "Please set at least one payment credential — bank account, eSewa, Khalti or a QR — so your residents can pay you and we can check their payment receipts for you.",
    cta: "Set up payments",
    title: "No payment method set up",
  },
};

/**
 * Rides above every hostel-admin screen until the profile can identify the
 * hostel on a receipt, mirroring `HostelPhotoReminder`.
 */
export function HostelPaymentCredentialsReminder({
  paymentProfileHref,
}: {
  paymentProfileHref: string;
}) {
  const [gap, setGap] = useState<Gap | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Never let the reminder delay the screen the admin actually opened.
    const timer = window.setTimeout(() => {
      void browserApi<{ profile: ProfileSummary }>(
        "/api/v1/hostel-admin/finance/payment-profile",
      )
        .then(({ profile }) => {
          if (cancelled) return;

          if (!profile.usable) {
            setGap("NO_METHOD");
          } else if (!profile.payeeVerifiable) {
            const gap = profile.staticQrAssetId ? "QR_UNREAD" : "NO_CREDENTIAL";

            // Session-dismissible, and only this one: the hostel is collecting
            // money fine, so a permanent bar would be nagging rather than
            // informing. The read happens before the state is set so a stale
            // dismissal from a since-fixed profile cannot hide the louder gap.
            setGap(sessionStorage.getItem(DISMISS_KEY) === "1" ? null : gap);
          }
        })
        .catch(() => {
          // A warden without `viewPayments` gets a 403 here, and a reminder is
          // not worth surfacing an error for either way.
        });
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const dismiss = useCallback(() => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setGap(null);
  }, []);

  if (!gap) {
    return null;
  }

  const copy = COPY[gap];
  const blocking = gap === "NO_METHOD";
  const Icon = blocking ? Wallet : ShieldAlert;

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm ${
        blocking
          ? "border-destructive/25 bg-destructive/10 text-destructive"
          : "border-role-admin/20 bg-role-admin-soft text-role-admin"
      }`}
      role="status"
    >
      <Icon className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{copy.title}.</span> {copy.body}
      </p>
      <Link
        className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold text-white transition ${
          blocking
            ? "bg-destructive hover:bg-destructive/85"
            : "bg-role-admin hover:bg-role-admin/85"
        }`}
        href={paymentProfileHref}
      >
        {copy.cta}
      </Link>
      {blocking ? null : (
        <button
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 transition hover:bg-role-admin/10"
          onClick={dismiss}
          type="button"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
