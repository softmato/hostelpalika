"use client";

import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { Moon, WalletCards } from "@/components/icons";
import Link from "next/link";
import { memo } from "react";

import { currency, EmptyState } from "@/app/_components/shared-ui";
import { monthLabel } from "@/lib/format-month";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import {
  CardSkeletons,
  FactChip,
  HostelBillCard,
  MealTile,
  NoticeCard,
  SectionTitle,
  TileGrid,
} from "./daily-portal-ui";
import { ResidentKhataCard } from "./khata-pages";
import { ResidentQuestionCallCard } from "./resident-questioncall-card";
import { type ResidentDashboard, Message } from "./resident-shared";
import {
  EmptyInline,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  ViewAllLink,
} from "./portal-dashboard-ui";

/*
 * What tonight's answer says, in words a resident would use. This used to print
 * `titleCase(status)`, which turned SOS_TRIGGERED into a neutral "Sos triggered"
 * and NOT_VERIFIED into "Not verified" — the one state that is an emergency
 * looked exactly like the quiet ones.
 */
const NIGHT_STATUS: Record<string, { label: string; tone: "amber" | "rose" | "teal" }> = {
  INSIDE_HOSTEL: { label: "In the hostel", tone: "teal" },
  MARKED_SAFE: { label: "Marked safe", tone: "teal" },
  NOT_VERIFIED: { label: "Not checked in", tone: "amber" },
  OUTSIDE_HOSTEL: { label: "Out tonight", tone: "amber" },
  SOS_TRIGGERED: { label: "SOS sent", tone: "rose" },
};

export const ResidentDashboardPageContent = memo(function ResidentDashboardPageContent() {
  const dashboardResource = usePortalResource<{ dashboard: ResidentDashboard }>(
    residentEndpoints.dashboard,
    { errorMessage: "Could not load dashboard." },
  );

  const dashboard = dashboardResource.data?.dashboard ?? null;
  const state = dashboardResource.state;
  const message = dashboardResource.message;

  const firstName = dashboard?.resident.firstName ?? "Resident";
  const unreadNotices = dashboard?.notices.filter((notice) => !notice.isRead).length ?? 0;
  const bedTypeLabel = roomTypeLabel(dashboard?.accommodation.roomType) || "—";
  const latestPayment = dashboard?.feeStatus.latestPayment;
  /*
   * The invoice the amount card is actually about.
   *
   * That card pairs `feeStatus.dueAmount` — the total across every unpaid
   * invoice — with a month and a due date, and both of those used to come from
   * `latestPayment`, which is the invoice due *furthest in the future*, settled
   * ones included. A resident two months behind was shown their whole debt under
   * next month's due date. `nextDue` is the earliest unsettled one; it falls
   * back only when there is nothing unsettled to point at.
   */
  const night = NIGHT_STATUS[dashboard?.nightStatus.status ?? ""] ?? NIGHT_STATUS.NOT_VERIFIED!;
  const nextDue = dashboard?.feeStatus.nextDue ?? latestPayment;
  const dueAmount = dashboard?.feeStatus.dueAmount ?? 0;
  const hostelAddress =
    [
      dashboard?.hostel?.location?.address,
      dashboard?.hostel?.location?.area,
      dashboard?.hostel?.location?.city,
    ]
      .filter(Boolean)
      .join(", ") || "Location not set";

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        description="Your hostel today."
        title={`Hi, ${firstName}`}
      />
      <Message value={message} />
      {state === "loading" ? <CardSkeletons /> : null}
      {state === "error" ? <EmptyState label="Dashboard could not be loaded." /> : null}

      {dashboard ? (
        <>
          {/* What a resident opens this page to learn, in order: what they owe,
              whether tonight's check-in is answered, and who to call. The hostel
              is context here, so it is a strip, not a photo hero. */}
          <div className="grid items-start gap-4 xl:grid-cols-[1.7fr_1fr]">
            <HostelBillCard
              action={
                <RoleButton asChild className="h-10 shrink-0 px-5" tone="team">
                  <Link href="/resident/payments">
                    <WalletCards className="size-4" />
                    Pay now
                  </Link>
                </RoleButton>
              }
              address={hostelAddress}
              amount={dueAmount}
              chips={
                <>
                  <FactChip glyph="bed">{bedTypeLabel}</FactChip>
                  {dashboard.hostel?.contact?.phone ? (
                    <FactChip glyph="call" href={`tel:${dashboard.hostel.contact.phone}`}>
                      {dashboard.hostel.contact.phone}
                    </FactChip>
                  ) : null}
                  {dashboard.hostel?.contact?.email ? (
                    <FactChip glyph="mail" href={`mailto:${dashboard.hostel.contact.email}`}>
                      {dashboard.hostel.contact.email}
                    </FactChip>
                  ) : null}
                </>
              }
              dueDate={nextDue?.dueDate}
              name={dashboard.hostel?.name ?? "Your hostel"}
              note={
                dueAmount > 0
                  ? [
                      dashboard.feeStatus.unpaidCount > 1
                        ? `${dashboard.feeStatus.unpaidCount} unpaid bills`
                        : monthLabel(nextDue?.month),
                      dashboard.feeStatus.pendingProofs > 0
                        ? `${dashboard.feeStatus.pendingProofs} payment awaiting confirmation`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : latestPayment
                    ? `Last paid: ${monthLabel(latestPayment.month)} · ${currency(latestPayment.paidAmount)}`
                    : null
              }
              photoUrl={dashboard.hostel?.photoUrl}
            />
            <div className="grid gap-3">
              <MetricCard
                icon={Moon}
                label="Tonight"
                note={
                  dashboard.nightStatus.checkedAt
                    ? `Checked ${new Date(dashboard.nightStatus.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : "Answer the check-in when it arrives"
                }
                tone={night.tone}
                value={night.label}
              />
              <ResidentKhataCard />
              <ResidentQuestionCallCard />
            </div>
          </div>

          {/* Counts that need a reply ride on the tile that answers them, so the
              page no longer spends a row of cards saying "0". */}
          <TileGrid
            items={[
              { glyph: "card", href: "/resident/payments", label: "Payments" },
              { glyph: "restaurant", href: "/resident/food", label: "Food" },
              { badge: unreadNotices, glyph: "megaphone", href: "/resident/notices", label: "Notices" },
              {
                badge: dashboard.complaints.openCount,
                glyph: "chatbox-alert",
                href: "/resident/complaints",
                label: "Complaints",
              },
              { glyph: "siren", href: "/resident/sos", label: "SOS" },
            ]}
          />

          <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
            <div className="space-y-3">
              <SectionTitle action={<ViewAllLink href="/resident/food" label="Full menu" tone="team" />}>
                Today&apos;s meals
              </SectionTitle>
              {dashboard.foodMenu.length === 0 ? (
                <EmptyInline label="No menu posted today." />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {dashboard.foodMenu.map((menu) => (
                    <MealTile
                      items={menu.items}
                      key={menu.mealType}
                      mealType={menu.mealType}
                      timing={menu.timing}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <SectionTitle action={<ViewAllLink href="/resident/notices" tone="team" />}>
                Notices
              </SectionTitle>
              {dashboard.notices.length === 0 ? (
                <EmptyInline label="No notices." />
              ) : (
                <div className="grid gap-3">
                  {dashboard.notices.slice(0, 3).map((notice) => (
                    <NoticeCard
                      content={notice.content}
                      date={notice.publishedAt}
                      isNew={!notice.isRead}
                      isUrgent={notice.isUrgent}
                      key={notice.id}
                      title={notice.title}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
});
