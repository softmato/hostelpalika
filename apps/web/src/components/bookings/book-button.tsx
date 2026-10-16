"use client";

import { CalendarCheck } from "@/components/icons";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { bookingButton, type BookingAvailabilityView } from "@/modules/bookings/booking-button";

const SIZE = {
  card: "h-9 rounded-md text-xs",
  primary: "h-12 rounded-lg text-sm",
} as const;

/**
 * The Book button, or the word that stands in for it. Draws nothing when
 * booking is not something this visitor could do here (see `bookingButton`).
 */
export function BookButton({
  availability,
  className,
  hostelSlug,
  roomType,
  variant = "primary",
}: {
  availability: BookingAvailabilityView | null;
  className?: string;
  hostelSlug: string;
  roomType?: string;
  variant?: keyof typeof SIZE;
}) {
  const state = bookingButton(availability, hostelSlug, roomType);

  if (state.kind === "hidden") {
    return null;
  }

  const base = cn("inline-flex w-full items-center justify-center gap-2 font-bold", SIZE[variant], className);

  if (state.kind !== "book") {
    return (
      <span aria-disabled="true" className={cn(base, "border border-border bg-muted text-muted-foreground")}>
        {state.kind === "full" ? "Full" : "Not taking bookings"}
      </span>
    );
  }

  const label = roomType
    ? state.fee
      ? `Book · Rs ${state.fee.toLocaleString("en-IN")} fee`
      : "Book"
    : "Book a room";

  return (
    <Link
      className={cn(base, "bg-brand-teal text-white shadow-sm transition hover:brightness-105")}
      href={state.href}
    >
      <CalendarCheck className="size-4" /> {label}
    </Link>
  );
}
