import { router, usePathname } from "expo-router";
import { useEffect, useState } from "react";
import { Linking } from "react-native";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useSiteConfig } from "@/hooks/use-site-config";
import { useKycLock } from "@/lib/kyc-lock";

/**
 * The free trial is over and the KYC is still not approved: the portal is
 * closed behind our alert card (its backdrop is the blur), and the only ways on
 * are finishing the KYC or calling us (docs/QUICK_SIGNUP_KYC_TRIAL.md). The API
 * refuses everything else on its own (`TRIAL_ENDED_KYC`).
 *
 * The KYC screen and the two editors it opens — room types, rent — stay
 * usable, so the card steps aside on them and comes back everywhere else.
 *
 * No plan link here: the plan is business software and Google Play does not
 * let the app point at another way to buy it. Once the KYC is approved, the
 * owner's email carries the link.
 */
const OPEN_WHILE_BLOCKED = ["/manage/kyc", "/manage/rooms", "/manage/finance/rates", "/manage/finance/room-rates"];

export function TrialEndedHost() {
  const { kyc } = useKycLock();
  const pathname = usePathname();
  const { config } = useSiteConfig();
  const endsAt = kyc?.locked && kyc.trialEndsAt ? Date.parse(kyc.trialEndsAt) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());

  // One timer to the deadline, so an app left open over it closes on time.
  useEffect(() => {
    if (!Number.isFinite(endsAt) || now >= endsAt) return;

    const timer = setTimeout(() => setNow(Date.now()), Math.min(endsAt - now + 1000, 2_147_000_000));

    return () => clearTimeout(timer);
  }, [endsAt, now]);

  if (!kyc || !Number.isFinite(endsAt) || now < endsAt) return null;
  if (OPEN_WHILE_BLOCKED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return null;

  const { supportEmail, supportPhone } = config.identity;
  const inReview = kyc.status === "SUBMITTED";

  return (
    <ConfirmDialog
      cancelLabel={supportPhone || supportEmail ? "Contact us" : null}
      confirmLabel={inReview ? "View KYC" : "Complete KYC"}
      message={
        inReview
          ? "Your KYC is with our team — we check it within 24 hours. Once it is approved, you can get your plan. You can also contact us to activate your plan."
          : "Please complete your KYC first. Once our team approves it, you can get your plan. You can also contact us to activate your plan."
      }
      onCancel={() =>
        void Linking.openURL(
          supportPhone ? `tel:${supportPhone.replace(/\s/g, "")}` : `mailto:${supportEmail}`,
        )
      }
      // Not dismissable: the backdrop and the back button change nothing.
      onClose={() => undefined}
      onConfirm={() => router.push("/manage/kyc")}
      open
      title="Your free trial has ended"
    />
  );
}
