import { router } from "expo-router";

import { useAppSelector } from "@/hooks/redux";
import { openConfirm } from "@/lib/confirm";

/**
 * A quick sign-up's frozen features (docs/QUICK_SIGNUP_KYC_TRIAL.md, decision
 * 2). The server refuses their writes on its own (423 `KYC_REQUIRED`, mirrored
 * in `apps/web/src/modules/hostels/hostel-kyc-lock.ts`); this is the same list
 * as the phone draws it.
 */
const FROZEN = [
  "/(admin)/money",
  "/expenses",
  "/khata",
  "/khata-asks",
  "/manage/announcements",
  "/manage/attendance",
  "/manage/bookings",
  "/manage/branches",
  "/manage/cook",
  "/manage/existing-residents",
  "/manage/finance",
  "/manage/invite-hostels",
  "/manage/join-link",
  "/manage/join-requests",
  "/manage/move-history",
  "/manage/overall",
  "/manage/push-notices",
  "/manage/referrals",
  "/manage/reports",
  "/manage/resident/new",
  "/manage/roll-call",
  "/manage/scan",
  "/manage/statements",
  "/manage/wardens",
  "/stock",
];

/** Inside a frozen prefix, but part of the KYC itself. */
const KYC_OWN = ["/manage/finance/rates", "/manage/finance/room-rates", "/manage/finance/payment-setup", "/manage/finance/money-rules"];

const under = (href: string, prefix: string) => href === prefix || href.startsWith(`${prefix}/`) || href.startsWith(`${prefix}?`);

export function isKycFrozenHref(href: string) {
  return !KYC_OWN.some((prefix) => under(href, prefix)) && FROZEN.some((prefix) => under(href, prefix));
}

/** The account's quick-sign-up state from `/auth/me`; `locked` is false for every older hostel. */
export function useKycLock() {
  const kyc = useAppSelector((state) => state.auth.account?.hostelKyc ?? null);

  return { kyc, locked: Boolean(kyc?.locked) };
}

/** "Please complete KYC" — what tapping anything frozen says. */
export function promptKyc() {
  openConfirm({
    cancelLabel: "Not now",
    confirmLabel: "Open KYC",
    message:
      "This opens once our team has approved your hostel KYC. Finish it and submit — we check it within 24 hours.",
    onConfirm: () => router.push("/manage/kyc"),
    title: "Please complete KYC",
  });
}
