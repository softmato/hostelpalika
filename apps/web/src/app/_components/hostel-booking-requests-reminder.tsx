"use client";

import Link from "next/link";

import { at } from "@/app/_components/booking-ui";
import { usePortalResource } from "@/lib/portal-query";
import type { HostelBookingView } from "@/lib/bookings/booking.types";

/**
 * Bookings waiting for this hostel's answer, above every workspace screen.
 *
 * Stands in for a nav badge: the nav is built on the server and does not move,
 * while this reads the same list the Bookings screen does and refreshes with
 * it (realtime topic `bookings`). Owners only — a warden's request is refused
 * and this draws nothing.
 */
export function HostelBookingRequestsReminder({ bookingsHref }: { bookingsHref: string }) {
  const resource = usePortalResource<{ bookings: HostelBookingView[]; counts: { requests: number } }>(
    "/api/v1/hostel-admin/bookings?tab=requests",
  );
  const requests = resource.data?.counts.requests ?? 0;

  if (requests === 0) {
    return null;
  }

  const first = resource.data?.bookings[0];

  return (
    <Link
      className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 transition hover:bg-amber-500/15 dark:text-amber-300"
      href={bookingsHref}
    >
      <span>
        <strong>
          {requests} booking{requests === 1 ? "" : "s"}
        </strong>{" "}
        waiting for your answer{first?.hostelAnswerBy ? ` — the first by ${at(first.hostelAnswerBy)}` : ""}.
      </span>
      <span className="shrink-0 font-semibold">Answer</span>
    </Link>
  );
}
