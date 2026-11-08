"use client";

import { usePortalResource } from "@/lib/portal-query";
import type { PayoutAccountForReview } from "@/lib/bookings/booking.types";

const STATUS_LABEL: Record<PayoutAccountForReview["status"], string> = {
  PENDING_REVIEW: "Waiting for a check",
  REJECTED: "Sent back",
  VERIFIED: "Verified",
};

/**
 * A hostel's payout account on the verification screen, masked. Checking it
 * happens on Platform → Bookings → Payout accounts; this only says whether
 * there is one and where it stands. Superadmin only, like the account itself.
 */
export function ReviewPayoutAccount({ hostelId }: { hostelId: string }) {
  const resource = usePortalResource<{ accounts: PayoutAccountForReview[] }>(
    `/api/v1/platform/bookings/payout-accounts?hostelId=${encodeURIComponent(hostelId)}`,
  );

  if (resource.state === "error") {
    return <p className="text-sm text-muted-foreground">Only a superadmin can see the payout account.</p>;
  }

  if (resource.state !== "ready") {
    return <div className="h-10 animate-pulse rounded-md bg-muted" />;
  }

  const account = resource.data?.accounts[0];

  if (!account) {
    return <p className="text-sm text-muted-foreground">No payout account yet. Bookings stay off until one is verified.</p>;
  }

  return (
    <div className="space-y-1 text-sm">
      <p className="font-semibold text-foreground">
        {account.methodLabel} {account.bankName} {account.maskedNumber}
      </p>
      <p className="text-muted-foreground">
        {account.holderName} · {STATUS_LABEL[account.status]}
      </p>
      {account.sharedWith.length > 0 ? (
        <p className="text-rose-600 dark:text-rose-400">Same number as {account.sharedWith.join(", ")}</p>
      ) : null}
    </div>
  );
}
