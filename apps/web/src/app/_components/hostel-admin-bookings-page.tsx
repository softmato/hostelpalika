"use client";

import { CalendarCheck, Download, HandCoins, Wallet } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { List, ReasonAction, Row, timeLeft, useAction, useNow } from "@/app/_components/booking-admin-ui";
import { at, rupees } from "@/app/_components/booking-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { HostelPayoutAccountPanel } from "@/app/_components/hostel-payout-account-panel";
import { HostelShortStaysPanel } from "@/app/_components/hostel-short-stays-panel";
import {
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SoftBadge,
  TabBar,
} from "@/app/_components/portal-dashboard-ui";
import { Panel } from "@/app/_components/shared-ui";
import { downloadFile } from "@/lib/downloads/downloader";
import { usePortalResource } from "@/lib/portal-query";
import type { HostelBookingView } from "@/modules/bookings/booking-views";

/**
 * Hostel admin → Bookings: docs/BOOKINGS.md item 18.
 *
 * The one decision a hostel makes about a booking — confirm or decline, before
 * the countdown runs out — first; then the beds it is holding, and how they
 * ended with what the hostel is owed. The fee itself was paid to us, so there
 * is nothing here to collect.
 */

const BASE = "/api/v1/hostel-admin/bookings";
const REFRESH = [`${BASE}*`];

type Tab = "confirmed" | "history" | "requests" | "settings";

type BookingsResponse = {
  bookings: HostelBookingView[];
  counts: { confirmed: number; requests: number };
  owed: { due: number; sent: number };
  pause: { pausedAt: string | null; reason: string | null };
};

export function HostelAdminBookingsPage() {
  const { hostelSlug } = useParams<{ hostelSlug: string }>();
  const [tab, setTab] = useState<Tab>("requests");
  // Settings is not a list: it still reads the requests tab, because the
  // counts, what is owed and any pause sit above every tab including this one.
  const listTab = tab === "settings" ? "requests" : tab;
  const resource = usePortalResource<BookingsResponse>(`${BASE}?tab=${listTab}`, {
    errorMessage: "Could not load bookings.",
  });
  const { busy, run } = useAction(REFRESH);
  const { confirm, confirmDialog } = useConfirm();
  const now = useNow();
  const data = resource.data;

  function render(booking: HostelBookingView) {
    const guest = `${booking.guest.name}${booking.guest.phone ? ` · ${booking.guest.phone}` : ""}`;

    if (booking.status === "AWAITING_HOSTEL") {
      return (
        <Row
          actions={
            <>
              <RoleButton
                disabled={busy === booking.id}
                onClick={async () => {
                  if (
                    await confirm({
                      actionLabel: "Confirm booking",
                      description: `Holds one ${booking.roomType} bed for ${booking.guest.name}. Admit them by scanning their ID card when they arrive.`,
                      title: "Confirm this booking?",
                    })
                  ) {
                    await run(booking.id, `${BASE}/${booking.id}/confirm`, {}, "Confirmed. The bed is held.");
                  }
                }}
                tone="admin"
              >
                Confirm
              </RoleButton>
              <ReasonAction
                busy={busy === booking.id}
                label="Decline"
                onSubmit={(reason) => void run(booking.id, `${BASE}/${booking.id}/decline`, { reason }, "Declined. The guest is refunded.")}
                placeholder="Reason (optional — the guest reads it)"
                required={false}
                tone="admin"
              />
            </>
          }
          key={booking.id}
        >
          <p className="font-bold text-foreground">
            {booking.roomType} · {booking.code}
          </p>
          <p className="text-muted-foreground">{guest}</p>
          <p className="text-muted-foreground">
            Answer by {at(booking.hostelAnswerBy)}{" "}
            <SoftBadge tone={timeLeft(booking.hostelAnswerBy, now) === "overdue" ? "rose" : "amber"}>
              {timeLeft(booking.hostelAnswerBy, now)}
            </SoftBadge>
          </p>
          <p className="text-muted-foreground">
            Your share after they move in: {rupees(booking.hostelShareIfKept)}
            {booking.plannedMoveIn ? ` · plans to arrive ${booking.plannedMoveIn}` : ""}
          </p>
        </Row>
      );
    }

    if (booking.status === "CONFIRMED") {
      return (
        <Row
          actions={
            <>
              <Link
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-semibold"
                href={`/${hostelSlug}/admin/residents`}
              >
                Admit by ID card
              </Link>
              <ReasonAction
                busy={busy === booking.id}
                label="Cancel booking"
                onSubmit={(reason) => void run(booking.id, `${BASE}/${booking.id}/cancel`, { reason }, "Cancelled. The guest is refunded.")}
                placeholder="Why — this counts as a missed booking"
                tone="admin"
              />
            </>
          }
          key={booking.id}
        >
          <p className="font-bold text-foreground">
            {booking.roomType} · {booking.code}
          </p>
          <p className="text-muted-foreground">{guest}</p>
          <p className="text-muted-foreground">
            Bed held until {at(booking.holdEndsAt)}{" "}
            <SoftBadge tone={timeLeft(booking.holdEndsAt, now) === "overdue" ? "rose" : "green"}>
              {timeLeft(booking.holdEndsAt, now)}
            </SoftBadge>
          </p>
        </Row>
      );
    }

    return (
      <Row
        actions={
          booking.payout?.status === "SENT" && booking.payout.documentNumber ? (
            <RoleButton
              onClick={() => {
                const number = booking.payout?.documentNumber as string;

                void downloadFile({
                  fileName: `${number.replace(/\//g, "-")}.pdf`,
                  label: `Payout advice ${number}`,
                  url: `${BASE}/documents/${encodeURIComponent(number)}`,
                });
              }}
              tone="admin"
              variant="outline"
            >
              <Download className="size-3.5" /> Payout advice
            </RoleButton>
          ) : null
        }
        key={booking.id}
      >
        <p className="font-bold text-foreground">
          {booking.statusLabel} · {booking.code} {booking.strike ? <SoftBadge tone="rose">missed booking</SoftBadge> : null}
        </p>
        <p className="text-muted-foreground">
          {guest} · {booking.roomType} · {at(booking.endedAt)}
        </p>
        {booking.endReason ? <p className="text-muted-foreground">Reason: {booking.endReason}</p> : null}
        {booking.payout ? (
          <p className="text-muted-foreground">
            Your share {rupees(booking.payout.amount)} ·{" "}
            {booking.payout.status === "SENT"
              ? `sent ${at(booking.payout.sentAt)}, transaction ${booking.payout.transactionId ?? ""}`
              : "to be sent"}
          </p>
        ) : null}
      </Row>
    );
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      <PortalPageHeader
        description="People who booked a bed and paid the booking fee to us. Answer each request before its countdown ends."
        title="Bookings"
      />

      {data?.pause.pausedAt ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          People cannot book your hostel right now{data.pause.reason ? `: ${data.pause.reason}` : ""}. Contact us to turn
          bookings back on.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={CalendarCheck} label="Waiting for your answer" tone="amber" value={data?.counts.requests ?? "—"} />
        <MetricCard icon={Wallet} label="Owed to you" tone="teal" value={data ? rupees(data.owed.due) : "—"} />
        <MetricCard icon={HandCoins} label="Paid to you" tone="green" value={data ? rupees(data.owed.sent) : "—"} />
      </div>

      <TabBar
        onChange={(key) => setTab(key as Tab)}
        tabs={[
          { count: data?.counts.requests, key: "requests", label: "Requests" },
          { count: data?.counts.confirmed, key: "confirmed", label: "Confirmed" },
          { key: "history", label: "History" },
          { key: "settings", label: "Settings" },
        ]}
        tone="admin"
        value={tab}
      />

      {tab === "settings" ? (
        <div className="space-y-3">
          <HostelPayoutAccountPanel />
          <HostelShortStaysPanel />
          <p className="px-1 text-xs text-muted-foreground">
            <Link className="font-semibold text-primary hover:underline" href="/how-booking-works" target="_blank">
              How booking works
            </Link>{" "}
            explains the answer window, the hold, your share and what counts as a missed booking.
          </p>
        </div>
      ) : (
        <Panel>
          <List
            empty={
              tab === "requests"
                ? "No booking is waiting for your answer."
                : tab === "confirmed"
                  ? "No bed is held right now."
                  : "No finished bookings yet."
            }
            items={data?.bookings}
            render={render}
            state={resource.state}
          />
        </Panel>
      )}
    </div>
  );
}
