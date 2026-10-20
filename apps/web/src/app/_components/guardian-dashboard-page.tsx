"use client";

import { Lock, MessageSquare, Phone, ReceiptText, WalletCards } from "@/components/icons";
import { usePathname } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { monthLabel } from "@/lib/format-month";
import { type GuardianDashboard, Message } from "./daily-operations-shared";
import { currency } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import {
  AmountCard,
  CardSkeletons,
  FactChip,
  HostelCard,
  MealTile,
  NoticeCard,
  SectionTitle,
  ShareBar,
  titleCase,
} from "./daily-portal-ui";
import {
  EmptyInline,
  InitialsAvatar,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
} from "./portal-dashboard-ui";

/*
 * Four nav rows (Fee Summary, Notices, Food View, Emergency Contact) render
 * this one component off one request. Each route shows its own part of it, so
 * a guardian who opens "Food View" lands on the food rather than on fees.
 */
type Section = "fees" | "notices" | "food" | "contact";

const SECTIONS: Record<Section, { description: string; title: string }> = {
  contact: { description: "Reach the hostel office.", title: "Emergency Contact" },
  fees: { description: "What your ward owes and has paid.", title: "Fee Summary" },
  food: { description: "What the hostel is serving today.", title: "Food View" },
  notices: { description: "Notes the hostel shares with guardians.", title: "Notices" },
};

function sectionOf(pathname: string): Section {
  if (pathname.startsWith("/guardian/notices")) return "notices";
  if (pathname.startsWith("/guardian/food")) return "food";
  if (pathname.startsWith("/guardian/emergency-contact")) return "contact";
  return "fees";
}

/** Said, not blank, when the ward has not shared something. */
function NotShared({ name, what }: { name: string; what: string }) {
  return (
    <section className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Lock className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="font-heading text-[15px] font-semibold text-foreground">{`${titleCase(what)} not shared`}</p>
        <p className="text-[13.5px] text-muted-foreground">{`${name} can share ${what} from their own portal.`}</p>
      </div>
    </section>
  );
}

export const GuardianDashboardPageContent = memo(function GuardianDashboardPageContent() {
  const section = sectionOf(usePathname() ?? "");
  const [dashboard, setDashboard] = useState<GuardianDashboard | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await browserApi<{ dashboard: GuardianDashboard }>(
        "/api/v1/guardian/dashboard",
      );
      setDashboard(data.dashboard);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load guardian dashboard.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const totals = useMemo(() => {
    if (!dashboard) {
      return { charges: 0, due: 0, paid: 0 };
    }
    const paid = dashboard.payments.reduce((sum, payment) => sum + payment.paidAmount, 0);
    const charges = dashboard.payments.reduce(
      (sum, payment) => sum + payment.dueAmount,
      0,
    );
    return {
      charges,
      // Null whenever the resident has not shared payments — the whole finance
      // half of this page is hidden in that case, so zero is only ever read by
      // a branch that is not rendered.
      due: dashboard.summary?.dueAmount ?? 0,
      paid,
    };
  }, [dashboard]);

  /** The oldest month still owing: its due date is the one the bar counts to. */
  const oldestOpen = useMemo(
    () =>
      (dashboard?.payments ?? [])
        .filter((payment) => payment.paidAmount < payment.dueAmount && payment.dueDate)
        .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))[0],
    [dashboard],
  );

  /**
   * Receipts arrive as their own list, keyed by the billing month they settle —
   * which is the same `month` the dues are already grouped by, so the two join
   * without another request. Gated by `canViewReceipts` on the server, so this
   * map is simply empty when the resident did not share them.
   */
  const receiptByMonth = useMemo(
    () =>
      new Map(
        (dashboard?.receipts ?? []).map((receipt) => [
          receipt.month,
          receipt.receiptNumber,
        ]),
      ),
    [dashboard],
  );

  const residentName = dashboard?.resident.fullName || "Resident";
  const canViewPayments = dashboard?.permissions.canViewPayments ?? false;
  const hostelPhone = dashboard?.hostel?.contact.phone ?? "";
  const hostelAddress =
    [
      dashboard?.hostel?.location?.address,
      dashboard?.hostel?.location?.area,
      dashboard?.hostel?.location?.city,
    ]
      .filter(Boolean)
      .join(", ") || "Location not set";
  const wardRoomType = dashboard?.resident.roomType?.replaceAll("_", " ") || "—";
  const head = SECTIONS[section];

  const hostelCard = dashboard?.hostel ? (
    <HostelCard
      address={hostelAddress}
      chips={
        <>
          <FactChip glyph="bed">{wardRoomType}</FactChip>
          {hostelPhone ? (
            <FactChip glyph="call" href={`tel:${hostelPhone}`}>
              {hostelPhone}
            </FactChip>
          ) : null}
          {dashboard.hostel.contact.email ? (
            <FactChip glyph="mail" href={`mailto:${dashboard.hostel.contact.email}`}>
              {dashboard.hostel.contact.email}
            </FactChip>
          ) : null}
        </>
      }
      name={dashboard.hostel.name}
      photoUrl={dashboard.hostel.photoUrl}
      slug={dashboard.hostel.slug}
      verified={dashboard.hostel.isVerified}
    />
  ) : null;

  return (
    <div className="mx-auto max-w-[1200px] space-y-5">
      <PortalPageHeader
        actions={
          hostelPhone ? (
            <RoleButton asChild className="h-9 px-4" tone="team">
              <a href={`tel:${hostelPhone}`}>
                <Phone className="size-4" />
                Call hostel
              </a>
            </RoleButton>
          ) : null
        }
        description={head.description}
        title={head.title}
      />
      <Message value={message} />
      {loading ? <CardSkeletons /> : null}

      {dashboard ? (
        <>
          {/* The ward: who this whole portal is about. */}
          <section className="flex items-center gap-4 rounded-2xl border border-border/70 bg-card p-4">
            <InitialsAvatar image={dashboard.resident.image} name={residentName} size="lg" tone="team" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-heading text-[17px] font-bold tracking-tight text-foreground">
                {residentName}
              </p>
              <p className="truncate text-[13px] text-muted-foreground">
                {dashboard.hostel?.name ?? "Hostel"} · you are their {dashboard.guardian.relation.toLowerCase()}
              </p>
            </div>
            {dashboard.safety ? (
              <SoftBadge tone={statusToneFromLabel(dashboard.safety.status)}>
                {titleCase(dashboard.safety.status)}
              </SoftBadge>
            ) : null}
          </section>

          {section === "fees" ? (
            canViewPayments ? (
              <>
                <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
                  {/* Guardians see dues but cannot pay them here: payment is
                      made from the resident's own portal or at the office. */}
                  <AmountCard
                    amount={totals.due}
                    dueDate={oldestOpen?.dueDate}
                    label={totals.due > 0 ? "Your ward owes" : "All paid"}
                    note={
                      (dashboard.summary?.unpaidCount ?? 0) > 0
                        ? `${dashboard.summary?.unpaidCount} unpaid · paid by your ward or at the office`
                        : "Nothing outstanding."
                    }
                  />
                  <div className="grid content-start gap-3 sm:grid-cols-2">
                    <MetricCard icon={WalletCards} label="Paid so far" value={currency(totals.paid)} />
                    <MetricCard icon={ReceiptText} label="Billed so far" value={currency(totals.charges)} />
                    <div className="sm:col-span-2">
                      <ShareBar
                        label={`${currency(totals.paid)} of ${currency(totals.charges)} paid`}
                        total={totals.charges}
                        value={totals.paid}
                      />
                    </div>
                  </div>
                </div>

                <section className="space-y-3">
                  <SectionTitle>Months</SectionTitle>
                  <SectionCard>
                    {dashboard.payments.length === 0 ? (
                      <EmptyInline label="No bills yet." />
                    ) : (
                      <div className="divide-y divide-border/60">
                        {dashboard.payments.map((payment) => (
                          <div
                            className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 md:flex-row md:items-center md:gap-5"
                            key={payment.id}
                          >
                            <div className="flex min-w-0 items-center gap-3 md:w-52 md:shrink-0">
                              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                                <ReceiptText className="size-[18px]" />
                              </span>
                              <div className="min-w-0">
                                <p className="truncate text-[13.5px] font-semibold text-foreground">
                                  {monthLabel(payment.month)}
                                </p>
                                {/* The receipt *number*: there is no guardian
                                    receipt PDF, and it is what they would quote
                                    to the office anyway. */}
                                <p className="truncate text-[12px] text-muted-foreground">
                                  {receiptByMonth.get(payment.month)
                                    ? `Receipt ${receiptByMonth.get(payment.month)}`
                                    : "No receipt"}
                                </p>
                              </div>
                            </div>
                            <ShareBar
                              className="min-w-0 flex-1"
                              label={`${currency(payment.paidAmount)} of ${currency(payment.dueAmount)}`}
                              total={payment.dueAmount}
                              tone={payment.status === "OVERDUE" ? "wrong" : "brand"}
                              value={payment.paidAmount}
                            />
                            <SoftBadge className="w-fit" tone={statusToneFromLabel(payment.status)}>
                              {titleCase(payment.status)}
                            </SoftBadge>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>
                </section>
                {hostelCard}
              </>
            ) : (
              <>
                <NotShared name={residentName} what="fees" />
                {hostelCard}
              </>
            )
          ) : null}

          {section === "notices" ? (
            dashboard.permissions.canViewNotices ? (
              dashboard.notices.length === 0 ? (
                <SectionCard>
                  <EmptyInline label="No notices shared with guardians." />
                </SectionCard>
              ) : (
                <div className="grid gap-3">
                  {dashboard.notices.map((notice) => (
                    <NoticeCard
                      category={notice.category}
                      content={notice.content}
                      isUrgent={notice.isUrgent}
                      key={notice.id}
                      title={notice.title}
                    />
                  ))}
                </div>
              )
            ) : (
              <NotShared name={residentName} what="notices" />
            )
          ) : null}

          {section === "food" ? (
            dashboard.permissions.canViewFood ? (
              dashboard.food.length === 0 ? (
                <SectionCard>
                  <EmptyInline label="No menu posted today." />
                </SectionCard>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {dashboard.food.map((menu) => (
                    <MealTile items={menu.items} key={menu.id} mealType={menu.mealType} timing={menu.timing} />
                  ))}
                </div>
              )
            ) : (
              <NotShared name={residentName} what="the food menu" />
            )
          ) : null}

          {section === "contact" ? (
            <>
              <section className="flex flex-col items-center gap-3 rounded-2xl border border-border/70 bg-card px-5 py-8 text-center">
                <span className="flex size-14 items-center justify-center rounded-2xl bg-role-team-soft text-role-team">
                  <Phone className="size-7" />
                </span>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {dashboard.hostel?.name ?? "Hostel"} office
                </p>
                <p className="font-heading text-[30px] font-bold tracking-tight text-foreground tabular-nums">
                  {hostelPhone || "No number on file"}
                </p>
                {hostelPhone ? (
                  <div className="flex gap-2">
                    <RoleButton asChild className="h-10 px-5" tone="team">
                      <a href={`tel:${hostelPhone}`}>
                        <Phone className="size-4" />
                        Call
                      </a>
                    </RoleButton>
                    <Button asChild className="h-10 rounded-xl" variant="outline">
                      <a href={`sms:${hostelPhone}`}>
                        <MessageSquare className="size-4" />
                        Message
                      </a>
                    </Button>
                  </div>
                ) : null}
              </section>
              {hostelCard}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
});
