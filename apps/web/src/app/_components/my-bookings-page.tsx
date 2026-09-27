"use client";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { Building2, ChevronRight, Download, QrCode } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  Card,
  Facts,
  Notice,
  PRIMARY,
  SECONDARY,
  Skeleton,
  at,
  errorText,
  rupees,
} from "@/app/_components/booking-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { requestResidentProfileForm, requestResidentQr } from "@/components/resident-identity";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { downloadFile } from "@/lib/downloads/downloader";
import { cn } from "@/lib/utils";
import type { GuestBookingDetail, GuestBookingSummary } from "@/modules/bookings/booking.service";
import { useSessionStore } from "@/stores/session-store";

import { PublicShell } from "./shared";

/**
 * My bookings — docs/BOOKINGS.md item 16. A list, and one booking: where it
 * stands, what happens next and by when, exactly what cancelling now returns,
 * its papers, and the ID card prompt once there is a bed to walk into.
 */

const OPEN = new Set(["AWAITING_PAYMENT", "PAYMENT_IN_REVIEW", "AWAITING_HOSTEL", "CONFIRMED"]);

/**
 * The hostel a booking is for, as its cover photo. Square, and it keeps its
 * footprint when there is no photo, so a list of bookings stays a column
 * rather than jumping in and out at the margin.
 */
function HostelPhoto({ className, name, url }: { className: string; name: string; url: string | null }) {
  if (!url) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground",
          className,
        )}
      >
        <Building2 aria-hidden className="size-5" />
      </span>
    );
  }

  return (
    // Photo hosts are not in next/image's remotePatterns, as on the hostel page.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={name} className={cn("shrink-0 rounded-lg border border-border object-cover", className)} src={url} />
  );
}

function SignedOutGate({ children, next }: { children: ReactNode; next: string }) {
  const user = useSessionStore((state) => state.user);
  const status = useSessionStore((state) => state.status);

  if (status !== "resolved") {
    return <Skeleton className="h-64" />;
  }

  if (!user) {
    return (
      <Card title="Sign in to see your bookings">
        <Link className={PRIMARY} href={`/login?next=${encodeURIComponent(next)}`}>
          Sign in
        </Link>
      </Card>
    );
  }

  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <PublicShell>
      <div className="mx-auto max-w-3xl px-4 py-10 md:px-8">{children}</div>
    </PublicShell>
  );
}

/* ── The list ──────────────────────────────────────────────────────────── */

function BookingList() {
  const [bookings, setBookings] = useState<GuestBookingSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    browserApi<{ bookings: GuestBookingSummary[] }>("/api/v1/bookings")
      .then((data) => setBookings(data.bookings))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, []);

  if (error) {
    return <Notice tone="danger">{error}</Notice>;
  }

  if (!bookings) {
    return <Skeleton className="h-64" />;
  }

  if (bookings.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">You have not booked a room yet.</p>
        <Link className={cn(PRIMARY, "mt-5")} href="/hostels">
          Find a hostel
        </Link>
      </Card>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      {bookings.map((booking) => (
        <li key={booking.id}>
          <Link
            className="flex items-center justify-between gap-4 p-4 transition hover:bg-muted"
            href={`/bookings/${encodeURIComponent(booking.id)}`}
          >
            <div className="flex min-w-0 items-center gap-4">
              <HostelPhoto className="size-14" name={booking.hostelName} url={booking.coverPhotoUrl} />
              <div className="min-w-0">
                <p className="truncate font-bold text-foreground">{booking.hostelName}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {booking.roomType} · {booking.code} · {at(booking.createdAt)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-bold",
                  OPEN.has(booking.status) ? "bg-brand-teal/10 text-brand-teal" : "bg-muted text-muted-foreground",
                )}
              >
                {booking.statusLabel}
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function MyBookingsPage() {
  return (
    <Shell>
      <h1 className="mb-2 text-2xl font-extrabold text-foreground">My bookings</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        <Link className="font-semibold text-primary hover:underline" href="/how-booking-works">
          How booking works
        </Link>{" "}
        explains every step and deadline, and the{" "}
        <Link className="font-semibold text-primary hover:underline" href="/refund-policy">
          refund policy
        </Link>{" "}
        what comes back if a booking ends early.
      </p>
      <SignedOutGate next="/bookings">
        <BookingList />
      </SignedOutGate>
    </Shell>
  );
}

/* ── One booking ───────────────────────────────────────────────────────── */

function whatNext(booking: GuestBookingDetail) {
  switch (booking.status) {
    case "AWAITING_PAYMENT":
      return `Pay ${rupees(booking.total ?? booking.fee)} and send the screenshot by ${at(booking.paymentDueBy)}.`;
    case "PAYMENT_IN_REVIEW":
      return "We are checking your payment screenshot. We email you as soon as it is checked.";
    case "AWAITING_HOSTEL":
      return `${booking.hostel.name} confirms by ${at(booking.hostelAnswerBy)}. If it declines or does not answer, the full fee comes back.`;
    case "CONFIRMED":
      return `Your bed is held until ${at(booking.holdEndsAt)}. Show your ${PLATFORM_NAME} ID card at the hostel to move in.`;
    case "CHECKED_IN":
      return "You have moved in. The booking is complete.";
    default:
      if (!booking.settlement) {
        return "This booking has ended. Nothing was paid.";
      }

      return booking.settlement.refund > 0
        ? `${rupees(booking.settlement.refund)} of the booking fee comes back to ${booking.refundAccount.methodLabel} ${booking.refundAccount.maskedNumber}.`
        : "No refund is due under the refund policy.";
  }
}

function timeline(booking: GuestBookingDetail): Array<[string, string]> {
  return [
    ["Booked", at(booking.createdAt)],
    ["Screenshot sent", at(booking.paymentSubmittedAt)],
    ["Payment checked", at(booking.paymentVerifiedAt)],
    ["Confirmed by the hostel", at(booking.confirmedAt)],
    ["Moved in", at(booking.checkedInAt)],
    [booking.checkedInAt ? "" : booking.statusLabel, booking.checkedInAt ? "" : at(booking.endedAt)],
    ["Refund sent", booking.refund?.status === "SENT" ? at(booking.refund.sentAt) : ""],
  ];
}

function BookingDetail({ bookingId }: { bookingId: string }) {
  const user = useSessionStore((state) => state.user);
  const { confirm, confirmDialog } = useConfirm();
  const [booking, setBooking] = useState<GuestBookingDetail | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(() => {
    browserApi<{ booking: GuestBookingDetail }>(`/api/v1/bookings/${encodeURIComponent(bookingId)}`)
      .then((data) => setBooking(data.booking))
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  // The refund on the Cancel button moves with the clock; so does everything waiting on somebody.
  useEffect(() => {
    if (!booking || !OPEN.has(booking.status)) {
      return;
    }

    const timer = window.setInterval(load, 60_000);

    return () => window.clearInterval(timer);
  }, [booking, load]);

  if (error && !booking) {
    return <Notice tone="danger">{error}</Notice>;
  }

  if (!booking) {
    return <Skeleton className="h-96" />;
  }

  const current = booking;

  async function cancel() {
    const { refund, refundPercent } = current.cancel;
    const ok = await confirm({
      actionLabel: "Cancel booking",
      cancelLabel: "Keep booking",
      description:
        refund > 0
          ? `You get ${rupees(refund)} back (${refundPercent}%) to ${current.refundAccount.methodLabel} ${current.refundAccount.maskedNumber}.`
          : current.paymentVerifiedAt
            ? "Nothing is refunded if you cancel now."
            : "Nothing has been paid, so nothing is owed.",
      title: "Cancel this booking?",
      tone: "destructive",
    });

    if (!ok) {
      return;
    }

    setCancelling(true);
    setError("");

    try {
      const data = await browserApi<{ booking: GuestBookingDetail }>(
        `/api/v1/bookings/${encodeURIComponent(current.id)}/cancel`,
        { body: JSON.stringify({ expectedRefund: refund }), method: "POST" },
      );

      setBooking(data.booking);
    } catch (caught) {
      setError(errorText(caught));

      // The figure moved, or the hold ended: show what is true now.
      if (caught instanceof ApiRequestError && (caught.errorCode === "REFUND_CHANGED" || caught.errorCode === "HOLD_ENDED")) {
        load();
      }
    } finally {
      setCancelling(false);
    }
  }

  const papers = [
    { kind: "invoice", label: "Invoice", number: current.invoiceNumber },
    { kind: "receipt", label: "Receipt", number: current.receiptNumber },
    { kind: "refund", label: "Refund note", number: current.refund?.documentNumber ?? null },
  ].filter((paper): paper is { kind: string; label: string; number: string } => Boolean(paper.number));

  return (
    <div className="space-y-6">
      {confirmDialog}

      <Card>
        <div className="flex items-start gap-4">
          <HostelPhoto className="size-20" name={current.hostel.name} url={current.coverPhotoUrl} />
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Booking {current.code}</p>
            <h1 className="mt-1 text-2xl font-extrabold text-foreground">{current.statusLabel}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {current.roomType} at{" "}
              <Link
                className="font-bold text-brand-teal hover:underline"
                href={`/hostels/${encodeURIComponent(current.hostel.slug)}`}
              >
                {current.hostel.name}
              </Link>
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-foreground">{whatNext(current)}</p>
        {current.paymentRejection?.reason && current.status === "AWAITING_PAYMENT" ? (
          <div className="mt-4">
            <Notice tone="danger">We could not confirm your last screenshot: {current.paymentRejection.reason}</Notice>
          </div>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {current.status === "AWAITING_PAYMENT" ? (
            <Link
              className={PRIMARY}
              href={`/book/${encodeURIComponent(current.hostel.slug)}?room=${encodeURIComponent(current.roomType)}&booking=${encodeURIComponent(current.id)}`}
            >
              Pay booking fee
            </Link>
          ) : null}
          {current.status === "CONFIRMED" ? (
            <button
              className={PRIMARY}
              onClick={() => (user?.userResidentId ? requestResidentQr() : requestResidentProfileForm("MANUAL"))}
              type="button"
            >
              <QrCode className="size-4" />
              {user?.userResidentId ? "Show my ID card" : "Create my ID card"}
            </button>
          ) : null}
          {current.cancel.allowed ? (
            <button className={SECONDARY} disabled={cancelling} onClick={() => void cancel()} type="button">
              {cancelling
                ? "Cancelling…"
                : current.cancel.refund > 0
                  ? `Cancel · ${rupees(current.cancel.refund)} back`
                  : "Cancel booking"}
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="mt-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
      </Card>

      {current.schedule && current.status === "CONFIRMED" ? (
        <Card title="If you cancel">
          <Facts
            rows={[
              ...current.schedule.steps.map((step): [string, string] => [
                `Before ${at(step.until)}`,
                `${rupees(step.refund)} (${step.refundPercent}%)`,
              ]),
              [`Not moved in by ${at(current.schedule.noShow.after)}`, rupees(current.schedule.noShow.refund)],
            ]}
          />
        </Card>
      ) : null}

      <Card title="Details">
        <Facts
          rows={[
            ["Monthly rent", rupees(current.monthlyRent)],
            ["Booking fee", rupees(current.fee)],
            ...(current.stay
              ? ([
                  ["Stay", `${current.stay.nights} nights · ${current.stay.dates}`],
                  ["Nights", rupees(current.stay.amount)],
                  ["Total paid", rupees(current.total)],
                ] as [string, string][])
              : []),
            ["Planned move-in", current.plannedMoveIn ?? ""],
            ["Refund account", `${current.refundAccount.methodLabel} ${current.refundAccount.maskedNumber}`],
            ["Hostel phone", current.hostel.phone],
            ["Address", current.hostel.address],
            ["Refund transaction ID", current.refund?.transactionId ?? ""],
          ]}
        />
      </Card>

      <Card title="Timeline">
        <Facts rows={timeline(current)} />
      </Card>

      {papers.length > 0 ? (
        <Card title="Documents">
          <div className="grid gap-3 sm:grid-cols-3">
            {papers.map((paper) => (
              <button
                className={SECONDARY}
                key={paper.kind}
                onClick={() =>
                  void downloadFile({
                    fileName: `${paper.number.replace(/\//g, "-")}.pdf`,
                    label: `${paper.label} ${paper.number}`,
                    url: `/api/v1/bookings/documents/${paper.kind}/${encodeURIComponent(paper.number)}`,
                  })
                }
                type="button"
              >
                <Download className="size-4" /> {paper.label}
              </button>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export function MyBookingDetailPage({ bookingId }: { bookingId: string }) {
  return (
    <Shell>
      <Link className="mb-6 inline-block text-sm font-semibold text-brand-teal hover:underline" href="/bookings">
        ← My bookings
      </Link>
      <SignedOutGate next={`/bookings/${bookingId}`}>
        <BookingDetail bookingId={bookingId} />
      </SignedOutGate>
    </Shell>
  );
}
