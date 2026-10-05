import { Ionicons } from "@expo/vector-icons";
import { planRank } from "@hostel/plans/catalog";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { PlanMark } from "@/components/plan-mark";
import { PaintedAmount } from "@/components/portal-shared";
import { FreeMonthCard } from "@/components/subscription-due";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { type PortalDates, useDates } from "@/hooks/use-dates";
import { useHostelDayTurn } from "@/hooks/use-hostel-day-turn";
import { useMinuteTick } from "@/hooks/use-minute-tick";
import { useResource } from "@/hooks/use-resource";
import { useSiteConfig } from "@/hooks/use-site-config";
import type {
  PlanBilling,
  PlanBillingInvoice,
  PlanBillingPayment,
  PlanBillingPlan,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { downloadToDevice } from "@/lib/documents";
import { formatMoney } from "@/lib/format";
import type { SitePlans } from "@/lib/site-config-api";
import type { BadgeTone } from "@/lib/status";
import { toastError } from "@/lib/toast";

/**
 * Billing — what this hostel pays the platform, and how long it has left.
 *
 * ## Not the Money tab, and not `manage/finance`
 *
 * Both of those are the hostel billing its **residents**: rent, rate cards,
 * proofs, reconciliation, with the hostel as merchant of record. This is the
 * hostel being billed by **us** for the software. The direction of the money is
 * opposite and the counterparty is different, so the two never share a screen —
 * an owner reading "outstanding" here must never have to work out which of the
 * two debts it is.
 *
 * ## Three things, top to bottom
 *
 * 1. **Which plan** — the plan's own mark from `/plans-pricing`, its name, the
 *    cycle and price, and one status pill, on a card straddling the header
 *    (NOTES §1). It lives in the header rather than the scroll body because
 *    Android clips a `ScrollView`'s children to its bounds, and a card pulled up
 *    by a negative margin inside one loses its top — `statement.tsx` learnt this.
 * 2. **Pay by** — only while a balance is owed against a deadline: the day, on
 *    red, with what is left to pay and what has been paid so far. Red is the
 *    one colour this screen reserves for money genuinely owed; a plan merely
 *    coming up for renewal never gets it.
 * 3. **Days left** — the plan's own days, as a bar that opens full and empties
 *    towards the renewal day. Always the plan, never the window to pay: a team
 *    hostel's plan runs from the day it is filed, and the deadline already has
 *    the red block above with its date on it.
 *
 * Then the paperwork. No fact rows restating the pill, no "nothing paid for
 * yet" — which read as a lie to an owner who had just handed an agent Rs 1,400.
 *
 * ## Days are the server's
 *
 * `daysRemaining` and `periodDays` are computed on the **server** and printed,
 * never recomputed here. The website shows the same figures from the same
 * fields, and two clients each flooring their own part-day is how one screen
 * says 3 and the other says 2 on the same afternoon. They are counts of Nepal
 * days, so they change once, at midnight in Kathmandu — and the screen re-asks
 * then (`useHostelDayTurn`), on a pull, and from the refresh in the header.
 *
 * ## One list, switched, rather than two stacked
 *
 * Invoices and receipts are different objects and a phone has one column, so
 * stacking both means the second is below the fold on every visit.
 * `Segmented` is the vocabulary this app already uses for exactly this
 * (`NOTES.md` §7), and the counts on the labels make the empty one visible
 * without opening it.
 *
 * ## Downloads go to the shade, not to a share sheet
 *
 * `downloadToDevice` — the global downloader. The file lands in the user's own
 * folder with progress in the notification shade, which is what every other
 * document in this app does.
 */

type Tab = "invoices" | "receipts";

/** How far the plan card rides up onto the painted bar, in points. */
const STRADDLE = 26;

/** The straddling card's lift. Without a shadow it reads as a hole in the paint. */
const LIFT = {
  elevation: 8,
  shadowColor: "#000000",
  shadowOffset: { height: 6, width: 0 },
  shadowOpacity: 0.13,
  shadowRadius: 16,
} as const;

/** Secondary text on the red block: the same white, stepped back. */
const FADED = { opacity: 0.85 } as const;

/**
 * The pill for each subscription state, in the owner's words. Anything not
 * listed falls back to the enum, lower-cased, rather than to nothing.
 */
const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: "Active", tone: "success" },
  AWAITING_PAYMENT: { label: "Unpaid", tone: "warning" },
  EXPIRED: { label: "Expired", tone: "danger" },
  PAST_DUE: { label: "Payment due", tone: "danger" },
};

function statusOf(status: string) {
  return (
    STATUS[status] ?? {
      label: status.replaceAll("_", " ").toLowerCase(),
      tone: "neutral" as const,
    }
  );
}

/**
 * The document route, rebuilt against this build's API host.
 *
 * The server hands back an absolute URL built from `siteUrl()`, which is the
 * *website's* origin. On a device pointed at a dev machine, or any deployment
 * where the app talks to a different host from the one the public site is
 * served on, that URL resolves to somewhere this build cannot authenticate
 * against. The path is stable and the host is the app's own business, so the
 * host is the app's to supply.
 */
function documentUrl(kind: "invoice" | "receipt", number: string) {
  return `${API_BASE_URL}/api/v1/hostel-admin/billing/documents/${kind}/${encodeURIComponent(number)}`;
}

export default function ManageBillingScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  const [tab, setTab] = useState<Tab>("invoices");
  const [busy, setBusy] = useState<string | null>(null);

  const query = adminQuery.planBilling();
  const billing = useResource<PlanBilling>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const data = billing.data;
  const plan = data?.plan ?? null;
  const invoices = useMemo(() => data?.invoices ?? [], [data]);
  const payments = useMemo(() => data?.payments ?? [], [data]);

  /*
   * `busy` is keyed by the row rather than a screen-wide boolean: an owner may
   * tap two documents in a row, and a single flag would lock the second behind
   * the first. It stops a double tap on one row and nothing else — the progress
   * itself is the toaster's job.
   */
  const grab = useCallback(
    async (kind: "invoice" | "receipt", number: string, key: string) => {
      setBusy(key);

      try {
        await downloadToDevice({
          extension: "pdf",
          fileName: number.replace(/\//g, "-"),
          label: kind === "invoice" ? "Invoice" : "Receipt",
          mimeType: "application/pdf",
          url: documentUrl(kind, number),
        });
      } catch (error) {
        toastError(
          "Could not save it",
          error instanceof Error ? error.message : "Please try again.",
        );
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /*
   * The bar reserves room for the plan card only once there is a plan to put
   * there. While loading, or for a hostel with no plan, it is the plain accent
   * bar — reserved paint with nothing on it reads as a rendering fault.
   */
  // Every count on this screen is a Nepal day; when the day turns, re-ask.
  useHostelDayTurn(billing.refresh);

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        actions={
          <IconButton
            label="Refresh"
            name="refresh"
            onPress={billing.refresh}
            tone="onAccent"
          />
        }
        centerTitle
        showBack
        straddle={plan ? STRADDLE : 0}
        title="Billing"
      />
      {plan ? <PlanHead plan={plan} /> : null}
    </View>
  );

  if (billing.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (billing.error) {
    return (
      <Screen header={header}>
        <ErrorState
          message={billing.error}
          onRetry={billing.reload}
          title="Billing unavailable"
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      onRefresh={billing.refresh}
      refreshing={billing.refreshing}
      scroll
    >
      <View className="gap-5 pt-2">
        <FreeMonthCard
          placement="billing"
          state={data?.subscriptionState ?? null}
        />
        {plan ? (
          <Standing dates={dates} plan={plan} />
        ) : (
          <EmptyCard
            description="This hostel is not on a plan yet, so there is nothing to bill."
            title="No plan"
          />
        )}

        <View>
          <SectionHeader title="Paperwork" />

          <Segmented
            onChange={setTab}
            options={[
              { label: `Invoices (${invoices.length})`, value: "invoices" },
              { label: `Receipts (${payments.length})`, value: "receipts" },
            ]}
            value={tab}
          />

          <View className="mt-3 gap-3">
            {tab === "invoices" ? (
              invoices.length === 0 ? (
                <EmptyCard
                  description="Nothing has been billed for this hostel's plan yet."
                  title="No invoices"
                />
              ) : (
                invoices.map((invoice) => (
                  <InvoiceCard
                    busy={busy === invoice.invoiceNumber}
                    dateLong={dates.dateLong}
                    invoice={invoice}
                    key={invoice.invoiceNumber}
                    onDownload={() =>
                      void grab(
                        "invoice",
                        invoice.invoiceNumber,
                        invoice.invoiceNumber,
                      )
                    }
                  />
                ))
              )
            ) : payments.length === 0 ? (
              <EmptyCard
                description="No payment has been received against a plan invoice yet."
                title="No receipts"
              />
            ) : (
              payments.map((payment, index) => {
                const key =
                  payment.printedNumber ??
                  payment.receiptNumber ??
                  String(index);

                return (
                  <ReceiptCard
                    busy={busy === key}
                    dateLong={dates.dateLong}
                    iconColor={colors.mutedForeground}
                    key={key}
                    onDownload={() => void grab("receipt", key, key)}
                    payment={payment}
                  />
                );
              })
            )}
          </View>
        </View>
      </View>
    </Screen>
  );
}

/**
 * Where this plan sits in the catalogue — the fill depth of its mark.
 *
 * Ranked on the phone against the live catalogue with `planRank`, exactly as
 * the Pricing screen and `/plans-pricing` rank their cards, so Pro is drawn as
 * Pro everywhere. By id first; by the name snapshotted on the subscription for
 * a server that predates `planId` on this payload.
 *
 * `null` when neither matches — the catalogue is still loading, or the plan is
 * no longer sold. The first cut defaulted that to rank 0 and drew a Pro hostel
 * with Go's mark; no mark beats the wrong plan's.
 */
function rankOf(catalog: SitePlans, plan: PlanBillingPlan): number | null {
  const byId = plan.planId ? planRank(catalog, plan.planId) : -1;

  if (byId >= 0) return byId;

  const name = plan.planName?.trim().toLowerCase();
  const byName = name
    ? catalog.plans.findIndex((tier) => tier.name.trim().toLowerCase() === name)
    : -1;

  return byName >= 0 ? byName : null;
}

/**
 * Which plan this is — the card on the header's edge.
 *
 * The mark is the one `/plans-pricing` draws on the same plan's card, so an
 * owner recognises what they bought by its shape before reading its name.
 */
function PlanHead({ plan }: { plan: PlanBillingPlan }) {
  const { colors } = useAppTheme();
  const { config } = useSiteConfig();
  const rank = rankOf(config.plans, plan);
  const status = statusOf(plan.status);
  const detail = [plan.cycleLabel, plan.price ? formatMoney(plan.price) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <View className="px-5" style={{ marginTop: -STRADDLE }}>
      <View
        className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3"
        style={LIFT}
      >
        <View className="h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft">
          {rank === null ? (
            <Ionicons
              color={colors.primary}
              name="pricetag-outline"
              size={22}
            />
          ) : (
            <PlanMark color={colors.primary} rank={rank} size={30} />
          )}
        </View>

        <View className="flex-1">
          <Text numberOfLines={1} variant="subtitle">
            {plan.planName ?? "No plan chosen"}
          </Text>
          {detail ? (
            <Text numberOfLines={1} variant="caption">
              {detail}
            </Text>
          ) : null}
        </View>

        {/* Wrapped: the pill is `self-start`, which in this row would pin it to
            the top edge instead of the centre line the name sits on. */}
        <View>
          <Badge label={status.label} tone={status.tone} />
        </View>
      </View>
    </View>
  );
}

/**
 * Where the plan stands: the deadline while money is owed, then the plan's days.
 *
 * The bar is always the **plan**. It used to follow "whichever window mattered",
 * which while a balance was owed meant the window to pay — on the grounds that a
 * team hostel's plan had not started. It had: the hostel is live from the day
 * it is filed. What the owner got was an empty track reading "0% used" beside a
 * due, answering a question the red block above had already answered with a
 * date. Now the plan starts when the hostel goes live, the bar opens full, and
 * the deadline keeps to its own block.
 */
function Standing({
  dates,
  plan,
}: {
  dates: PortalDates;
  plan: PlanBillingPlan;
}) {
  // A clock held in state rather than read in render, so "Pay by" turns into
  // "Overdue since" on its own the moment the deadline passes.
  const now = useMinuteTick();
  const owing = Boolean(plan.dueBy) && (plan.amountDue ?? 0) > 0;
  const running = Boolean(plan.currentPeriodEnd);

  if (!owing && !running) {
    return null;
  }

  return (
    <View className="gap-3">
      {owing ? (
        <PayBy
          dates={dates}
          overdue={Date.parse(plan.dueBy as string) < now.getTime()}
          plan={plan}
        />
      ) : null}
      {running ? <PlanDays dates={dates} plan={plan} /> : null}
    </View>
  );
}

/**
 * The deadline, on red.
 *
 * The date is the subject — it is what goes in a diary — with the weekday under
 * it and the balance opposite. What has been paid rides along the bottom, so an
 * owner who paid part of it sees that it counted.
 *
 * White on `destructive` in both schemes: the ground is red either way, so
 * there is no scheme in which the ink should flip.
 */
function PayBy({
  dates,
  overdue,
  plan,
}: {
  dates: PortalDates;
  overdue: boolean;
  plan: PlanBillingPlan;
}) {
  const { colors } = useAppTheme();
  const [day, weekday] = dates.dateLong(plan.dueBy).split(" · ");
  const total = plan.amountPaid + plan.amountDue;

  return (
    <View
      className="gap-3 rounded-2xl p-4"
      style={{ backgroundColor: colors.destructive }}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text
            className="text-xs font-bold uppercase tracking-wider text-white"
            style={FADED}
            variant={null}
          >
            {overdue ? "Overdue since" : "Pay by"}
          </Text>
          <Text
            className="text-2xl font-semibold tracking-tight text-white"
            variant={null}
          >
            {day}
          </Text>
          {weekday ? (
            <Text className="text-sm text-white" style={FADED} variant={null}>
              {weekday}
            </Text>
          ) : null}
        </View>

        <View className="items-end gap-0.5">
          <Text
            className="text-xs font-bold uppercase tracking-wider text-white"
            style={FADED}
            variant={null}
          >
            Left to pay
          </Text>
          <PaintedAmount size={22} value={formatMoney(plan.amountDue)} />
        </View>
      </View>

      {plan.amountPaid > 0 ? (
        <>
          <View
            className="h-px"
            style={{ backgroundColor: "#ffffff", opacity: 0.3 }}
          />
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-sm text-white" style={FADED} variant={null}>
              Paid so far
            </Text>
            <Text className="text-sm font-semibold text-white" variant={null}>
              {`${formatMoney(plan.amountPaid)} of ${formatMoney(total)}`}
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

/**
 * Days left on the plan, as a bar that empties.
 *
 * Full on the day the plan starts and drawn down a day at a time — a fuel
 * gauge, which is what "how long have I got" looks like. The count is the
 * headline and nothing else competes with it: no percentage beside it, because
 * "31 days left" already is the number and a second one only asks the reader to
 * reconcile the two.
 *
 * Both the count and the bar come from the server's Nepal-day figures
 * (`daysRemaining` of `periodDays`), so they move together, once, at midnight.
 * The ends are labelled so the bar has a scale, in the reader's own calendar and
 * without the year: the day it started and the last day it covers.
 */
function PlanDays({
  dates,
  plan,
}: {
  dates: PortalDates;
  plan: PlanBillingPlan;
}) {
  const days = plan.daysRemaining ?? 0;
  const span = plan.periodDays ?? null;
  const percent = span ? Math.round((days / span) * 100) : null;

  return (
    <Card className="gap-3">
      <Text variant="title">
        {days === 0
          ? "This plan has run out"
          : `${days} ${days === 1 ? "day" : "days"} left`}
      </Text>

      <Meter animated label={null} percent={percent} reading="remaining" />

      <View className="flex-row justify-between gap-3">
        <Text variant="caption">{dates.dayMonth(plan.activatedAt)}</Text>
        <Text variant="caption">{dates.dayMonth(plan.currentPeriodEnd)}</Text>
      </View>
    </Card>
  );
}

/**
 * One invoice.
 *
 * The number shown is the one **printed on the document** — Softmato's when they
 * raised it, ours when we did. That is what an owner is reading off the copy in
 * their hand when they ring us, and it is the number the download is addressed
 * by from the reader's point of view. Our own reference sits under it in the
 * caption because it is what every other screen indexes by.
 */
function InvoiceCard({
  busy,
  dateLong,
  invoice,
  onDownload,
}: {
  busy: boolean;
  dateLong: (value: string | null | undefined) => string;
  invoice: PlanBillingInvoice;
  onDownload: () => void;
}) {
  const settled = invoice.outstanding === 0;

  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text variant="subtitle">{invoice.planName}</Text>
          <Text variant="caption">
            {invoice.printedNumber}
            {invoice.printedNumber === invoice.invoiceNumber
              ? ""
              : ` · ${invoice.invoiceNumber}`}
          </Text>
        </View>

        <View className="items-end">
          <Money size="large" value={invoice.amount} />
          {/* Labelled: a second, smaller amount under the first read as a
              typo rather than as what is still owed on it. */}
          {/* `variant={null}`: the default `body` variant's `text-base
              text-foreground` otherwise wins the generation-order race, and
              this rendered black at 16pt on the device. */}
          {settled ? null : (
            <Text
              className="text-xs font-semibold text-destructive"
              variant={null}
            >
              {`${formatMoney(invoice.outstanding)} due`}
            </Text>
          )}
        </View>
      </View>

      <View className="flex-row items-center gap-2">
        <Badge
          label={invoice.status.toLowerCase()}
          tone={
            invoice.status === "PAID"
              ? "success"
              : invoice.status === "VOID"
                ? "neutral"
                : "warning"
          }
        />
        <Text className="flex-1" variant="caption">
          {invoice.cycleLabel} · issued {dateLong(invoice.issuedAt)}
        </Text>
      </View>

      <RowDivider />

      {/*
        Always offered. Every invoice has a document now — theirs when Softmato
        raised it, ours when they could not be reached — so there is no state
        left where this row would produce nothing.
      */}
      <ListRow
        busy={busy}
        icon="download-outline"
        onPress={onDownload}
        subtitle="PDF"
        title="Download invoice"
      />
    </Card>
  );
}

/**
 * One payment, and the receipt for it.
 *
 * A payment that has not settled carries no download, and the row says why
 * rather than disappearing. A receipt asserts that a sum was received; offering
 * one for money still in flight would put a document into the world stating
 * something that may never become true.
 */
function ReceiptCard({
  busy,
  dateLong,
  iconColor,
  onDownload,
  payment,
}: {
  busy: boolean;
  dateLong: (value: string | null | undefined) => string;
  iconColor: string;
  onDownload: () => void;
  payment: PlanBillingPayment;
}) {
  const settled = payment.status === "SETTLED";
  const reviewing = payment.status === "IN_REVIEW";

  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text variant="subtitle">
            {payment.method === "CASH"
              ? "Cash, collected in person"
              : payment.method === "MANUAL"
                ? "Paid by QR, sent to us for checking"
                : (payment.provider ?? "Online payment")}
          </Text>
          <Text variant="caption">
            {payment.printedNumber ?? payment.receiptNumber ?? "—"}
          </Text>
        </View>

        <Money size="large" tone="credit" value={payment.amount} />
      </View>

      <View className="flex-row items-center gap-2">
        {/*
          `IN_REVIEW` is the one status whose enum cannot be lower-cased into
          English — "in_review" reads as a bug. It is also the status that most
          needs saying, because it is the only one where the owner is waiting on
          us rather than the other way round.
        */}
        <Badge
          label={reviewing ? "in review" : payment.status.toLowerCase()}
          tone={
            settled
              ? "success"
              : payment.status === "FAILED"
                ? "danger"
                : reviewing
                  ? "warning"
                  : "neutral"
          }
        />
        <Text variant="caption">{dateLong(payment.paidAt)}</Text>
      </View>

      <RowDivider />

      {settled ? (
        <ListRow
          busy={busy}
          icon="receipt-outline"
          onPress={onDownload}
          subtitle={payment.providerRef ? `Ref ${payment.providerRef}` : "PDF"}
          title="Download receipt"
        />
      ) : (
        <View className="flex-row items-center gap-2 py-2">
          <Ionicons color={iconColor} name="time-outline" size={16} />
          <Text className="flex-1" variant="caption">
            {reviewing
              ? "We are checking your proof. The receipt is issued once it is confirmed."
              : "The receipt is issued once this payment settles."}
          </Text>
        </View>
      )}
    </Card>
  );
}
