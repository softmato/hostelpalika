"use client";

import Link from "next/link";

import { PublicShell } from "@/app/_components/shared";
import { ContentHeader, ContentIntro, ContentNote, ContentSections } from "@/components/content-sections";
import type { BookingGuide } from "@/lib/bookings/booking.types";

/**
 * How booking works — docs/BOOKINGS.md item 33.
 *
 * Same arrangement as the refund policy, and deliberately beside it rather than
 * inside it: this page is the sequence and the deadlines, that one is the money.
 * Both are built from the live booking settings, so neither can describe terms
 * nobody is selling under.
 */
export function PublicBookingGuidePage({ guide }: { guide: BookingGuide }) {
  return (
    <PublicShell active="how-booking-works">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <ContentHeader
          icon="bed"
          subtitle="Booking a bed, from the fee to the day you move in"
          title="How Booking Works"
        />

        <ContentIntro paragraphs={guide.intro} />

        {guide.enabled ? null : (
          <div className="mb-14 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300">
            Room booking is not open right now. Everything below is how it works when it is.
          </div>
        )}

        <ContentSections sections={guide.sections} />

        <ContentNote title="The money side">
          <p className="mt-1">
            What comes back if a booking ends early, step by step, is on the{" "}
            <Link className="font-medium text-primary hover:underline" href="/refund-policy">
              refund policy
            </Link>
            .
          </p>
        </ContentNote>
      </div>
    </PublicShell>
  );
}
