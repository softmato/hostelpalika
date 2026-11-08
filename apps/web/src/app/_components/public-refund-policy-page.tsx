"use client";

import { PublicShell } from "@/app/_components/shared";
import { ContentHeader, ContentIntro, ContentSections } from "@/components/content-sections";
import { LegalBody } from "@/components/legal-body";
import type { RefundPolicy } from "@/lib/bookings/booking.types";

/**
 * Refund policy for room bookings. Same arrangement as Terms and Privacy, with
 * one difference: the shipped text is built from the live booking settings, so
 * every percentage and hour on it is the one a booking made today is sold under.
 */
export function PublicRefundPolicyPage({ policy }: { policy: RefundPolicy }) {
  return (
    <PublicShell active="refund-policy">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <ContentHeader
          icon="credit-card"
          subtitle={policy.updatedAt ? `Last updated: ${policy.updatedAt}` : undefined}
          title="Refund Policy"
        />

        <ContentIntro paragraphs={policy.intro} />

        {policy.customBody ? (
          <LegalBody body={policy.customBody} />
        ) : (
          <ContentSections sections={policy.sections} />
        )}
      </div>
    </PublicShell>
  );
}
