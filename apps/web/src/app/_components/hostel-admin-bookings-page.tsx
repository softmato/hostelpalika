"use client";

import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { CalendarCheck, Download, HandCoins, Settings, Wallet } from "@/components/icons";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { List, ReasonAction, Row, timeLeft, useAction, useNow } from "@/app/_components/booking-admin-ui";
import { at, rupees } from "@/app/_components/booking-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Chip } from "@/app/_components/hostel-admin-page-ui";
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
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

type Tab = "confirmed" | "history" | "requests";

type BookingsResponse = {
  bookings: HostelBookingView[];
  counts: { confirmed: number; requests: number };
  owed: { due: number; sent: number };
  pause: { pausedAt: string | null; reason: string | null };
};

export function HostelAdminBookingsPage() {
  const { hostelSlug } = useParams<{ hostelSlug: string }>();
  const [tab, setTab] = useState<Tab>("requests");
  // Payout account and short stays are a dialog over whichever list is open,
  // so the counts, what is owed and any pause stay in view.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const resource = usePortalResource<BookingsResponse>(`${BASE}?tab=${tab}`, {
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
                      description: `Holds one ${roomTypeLabel(booking.roomType)} bed for ${booking.guest.name}. Admit them by scanning their ID card when they arrive.`,
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
          <p className="text-[13.5px] font-semibold text-foreground">
            {roomTypeLabel(booking.roomType)} <span className="font-mono text-[12px] font-normal text-muted-foreground">{booking.code}</span>
          </p>
          <p className="text-[12.5px] text-muted-foreground">{guest}</p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Chip glyph="timer" tone={timeLeft(booking.hostelAnswerBy, now) === "overdue" ? "bad" : "warn"}>
              {`Answer by ${at(booking.hostelAnswerBy)}${now ? ` · ${timeLeft(booking.hostelAnswerBy, now)}` : ""}`}
            </Chip>
            <Chip glyph="cash" tone="brand">{`Your share ${rupees(booking.hostelShareIfKept)}`}</Chip>
            {booking.plannedMoveIn ? <Chip glyph="calendar">{`Arrives ${booking.plannedMoveIn}`}</Chip> : null}
          </div>
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
          <p className="text-[13.5px] font-semibold text-foreground">
            {roomTypeLabel(booking.roomType)} <span className="font-mono text-[12px] font-normal text-muted-foreground">{booking.code}</span>
          </p>
          <p className="text-[12.5px] text-muted-foreground">{guest}</p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Chip glyph="bed" tone={timeLeft(booking.holdEndsAt, now) === "overdue" ? "bad" : "brand"}>
              {`Held until ${at(booking.holdEndsAt)}${now ? ` · ${timeLeft(booking.holdEndsAt, now)}` : ""}`}
            </Chip>
          </div>
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
        <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-foreground">
          {booking.statusLabel}
          <span className="font-mono text-[12px] font-normal text-muted-foreground">{booking.code}</span>
          {booking.strike ? <SoftBadge tone="rose">missed booking</SoftBadge> : null}
        </p>
        <p className="text-[12.5px] text-muted-foreground">
          {guest} · {roomTypeLabel(booking.roomType)} · {at(booking.endedAt)}
        </p>
        {booking.endReason ? <p className="text-[12.5px] text-muted-foreground">Reason: {booking.endReason}</p> : null}
        {booking.payout ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Chip glyph="cash" tone={booking.payout.status === "SENT" ? "brand" : "neutral"}>
              {`Your share ${rupees(booking.payout.amount)} · ${
                booking.payout.status === "SENT"
                  ? `sent ${at(booking.payout.sentAt)}, transaction ${booking.payout.transactionId ?? ""}`
                  : "to be sent"
              }`}
            </Chip>
          </div>
        ) : null}
      </Row>
    );
  }

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        actions={
          <Button className="h-9 gap-2 rounded-xl" onClick={() => setSettingsOpen(true)} type="button" variant="outline">
            <Settings className="size-4" />
            Settings
          </Button>
        }
        description="Answer each bed booking before its countdown ends."
        title="Bookings"
      />

      {data?.pause.pausedAt ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-[13.5px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Bookings are paused{data.pause.reason ? `: ${data.pause.reason}` : ""}. Contact us to turn them back on.
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
        ]}
        tone="admin"
        value={tab}
      />

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

      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Booking settings</DialogTitle>
            <DialogDescription>
              Where your share is paid, and short stays.{" "}
              <Link className="font-semibold text-role-team hover:underline" href="/how-booking-works" target="_blank">
                How booking works
              </Link>
            </DialogDescription>
          </DialogHeader>
          <HostelPayoutAccountPanel />
          <HostelShortStaysPanel />
        </DialogContent>
      </Dialog>
    </div>
  );
}
