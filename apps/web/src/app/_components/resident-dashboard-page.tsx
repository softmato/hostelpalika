"use client";

import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { Bell, MessageSquareWarning, Moon, WalletCards } from "@/components/icons";
import Link from "next/link";
import { memo } from "react";

import { currency, EmptyState } from "@/app/_components/shared-ui";
import { monthLabel } from "@/lib/format-month";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import {
  AmountCard,
  CardSkeletons,
  FactChip,
  HostelCard,
  MealTile,
  NoticeCard,
  SectionTitle,
  TileGrid,
  titleCase,
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
        actions={
          dueAmount > 0 ? (
            <RoleButton asChild className="h-9 px-4" tone="team">
              <Link href="/resident/payments">
                <WalletCards className="size-4" />
                Pay now
              </Link>
            </RoleButton>
          ) : null
        }
        description="Your hostel today."
        title={`Hi, ${firstName}`}
      />
      <Message value={message} />
      {state === "loading" ? <CardSkeletons /> : null}
      {state === "error" ? <EmptyState label="Dashboard could not be loaded." /> : null}

      {dashboard ? (
        <>
          {/* The hostel leads: every other card here is about it. The amount
              owed sits beside it as the one figure a resident checks. */}
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <HostelCard
              address={hostelAddress}
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
              name={dashboard.hostel?.name ?? "Your hostel"}
              photoUrl={dashboard.hostel?.photoUrl}
              slug={dashboard.hostel?.slug}
              verified
            />
            <AmountCard
              amount={dueAmount}
              dueDate={nextDue?.dueDate}
              label={dueAmount > 0 ? "You owe" : "All paid"}
              note={
                dueAmount > 0
                  ? dashboard.feeStatus.unpaidCount > 1
                    ? `${dashboard.feeStatus.unpaidCount} unpaid bills`
                    : monthLabel(nextDue?.month)
                  : latestPayment
                    ? `Last paid: ${monthLabel(latestPayment.month)} · ${currency(latestPayment.paidAmount)}`
                    : null
              }
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard icon={Bell} label="Unread notices" value={String(unreadNotices)} />
            <MetricCard
              icon={Moon}
              label="Tonight"
              note={
                dashboard.nightStatus.checkedAt
                  ? `Checked ${new Date(dashboard.nightStatus.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Not checked yet"
              }
              value={titleCase(dashboard.nightStatus.status)}
            />
            <MetricCard
              icon={MessageSquareWarning}
              label="Open complaints"
              tone={dashboard.complaints.openCount > 0 ? "amber" : "teal"}
              value={String(dashboard.complaints.openCount)}
            />
          </div>

          <TileGrid
            items={[
              { glyph: "card", href: "/resident/payments", label: "Payments" },
              { glyph: "restaurant", href: "/resident/food", label: "Food" },
              { glyph: "megaphone", href: "/resident/notices", label: "Notices" },
              { glyph: "chatbox-alert", href: "/resident/complaints", label: "Complaints" },
              { glyph: "siren", href: "/resident/sos", label: "SOS" },
            ]}
          />

          <div className="space-y-3">
            <SectionTitle action={<ViewAllLink href="/resident/food" label="Full menu" tone="team" />}>
              Today&apos;s meals
            </SectionTitle>
            {dashboard.foodMenu.length === 0 ? (
              <EmptyInline label="No menu posted today." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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

          <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
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
            <div className="space-y-3">
              <ResidentKhataCard />
              <ResidentQuestionCallCard />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
});
