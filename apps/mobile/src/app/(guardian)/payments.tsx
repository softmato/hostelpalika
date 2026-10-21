import { View } from "react-native";

import { GuardianNotShared } from "@/components/guardian-not-shared";
import { ResidentDuesCard } from "@/components/resident-payments";
import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { formatDueLabel, formatMoney } from "@/lib/format";
import {
  canSee,
  guardianLatestPaid,
  guardianNextDue,
  guardianOutstanding,
  guardianPaidAmount,
  receiptsByMonth,
} from "@/lib/guardian";
import type { GuardianDashboard } from "@/lib/guardian-api";
import { guardianQuery } from "@/lib/guardian-queries";

/**
 * The ward's dues, read-only — which is the server's shape, not a limitation
 * of this screen.
 *
 * `/guardian/payments` is a GET and there is no guardian-side payment or claim
 * route anywhere in `apps/web`. The web dashboard drew a "Make a Payment"
 * button anyway, with no handler behind it, so a parent tapping it to settle
 * their child's rent got silence. This screen says what to do instead.
 *
 * Receipts arrive as their own list keyed by billing month, so they join the
 * dues rows without a second request — and are gated by their *own* flag, which
 * is why a row can legitimately show dues with no receipt number beside it.
 *
 * ## It leads with the resident tab's card, without its lower register
 *
 * `<ResidentDuesCard>` is the painted statement object the resident's Payments
 * tab leads with: the balance on the paint, an overdue-or-settled pill, and a
 * two-up of `Next due` / `Last paid`. Everything on it is a *reading*, which is
 * exactly what a guardian is entitled to — so it is reused whole, and the
 * `footer` is simply not passed.
 *
 * That absence is the design. The register carries the reference code and the
 * `Pay now` / `I've paid` buttons, and a guardian has neither: the code is the
 * resident's to quote and there is no route behind either button. A card that
 * silently loses its action half between two roles is a much better statement of
 * "you can watch this, you cannot act on it" than a disabled button would be —
 * and the sentence under the card says it in words as well, because a parent
 * should not have to infer a permission from a missing control.
 *
 * The bordered `Total outstanding` box it replaced said the same figure in the
 * plainest possible way while the resident's own screen, one account away, said
 * it on paint. Two people looking at one debt should be looking at one object.
 */
export default function GuardianPaymentsScreen() {
  const dates = useDates();
  // The portal's one key — see `lib/guardian-queries.ts`.
  const query = guardianQuery.dashboard();
  const guardian = useResource<GuardianDashboard>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar actions={<NotificationBell />} large title="Payments" />;

  if (guardian.loading) {
    return (
      <Screen header={header} insideTabs padded={false} scroll>
        <View className="px-5">
          <Skeleton height={190} radius={26} />
        </View>

        <View className="gap-4 px-5 pt-5">
          <Skeleton height={18} width="38%" />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (guardian.error || !guardian.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={guardian.error ?? "Your ward's dues could not be loaded."}
          onRetry={guardian.reload}
        />
      </Screen>
    );
  }

  const dashboard = guardian.data;

  if (!canSee(dashboard, "canViewPayments")) {
    return (
      <Screen
        header={header}
        insideTabs
        onRefresh={guardian.refresh}
        refreshing={guardian.refreshing}
        scroll
      >
        {/*
          One card, and nothing else. The ward card that used to sit above this
          is the hero on Home, and repeating an identity block over a "not
          shared" notice makes the refusal look like a section of a screen rather
          than the whole of it.
        */}
        <GuardianNotShared
          subject="fees and dues"
          wardName={dashboard.resident.fullName}
        />
      </Screen>
    );
  }

  const receipts = receiptsByMonth(dashboard.receipts);
  const paid = guardianPaidAmount(dashboard);
  const nextDue = guardianNextDue(dashboard.payments);
  const lastPaid = guardianLatestPaid(dashboard.payments);
  const unpaid = dashboard.summary?.unpaidCount ?? 0;
  const overdue = dashboard.payments.filter(
    (payment) => payment.status === "OVERDUE",
  ).length;

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={guardian.refresh}
      padded={false}
      refreshing={guardian.refreshing}
      scroll
    >
      <ResidentDuesCard
        /*
          Zero, not the guardian's claim count. A guardian cannot file a payment
          claim — there is no route — so the "N to verify" state of the pill is
          unreachable from this account and must not be faked from some other
          number that happens to be to hand.
        */
        claimsPending={0}
        /*
          Two lines, where the resident gets one.

          A guardian has no button to press on this screen and no reference code
          to quote — `GuardianPayment` carries none, because the guardian
          dashboard never selects it — so the slot the resident spends on "the
          charge I am about to settle" is better spent telling somebody checking
          up on a household both halves: what is coming, and what last landed.

          Both name their amount. The balance above them is every open month
          added up, and a line that gave only a month was how the resident's card
          came to headline one number beside a button that charged another —
          `DuesLine` has that story.
        */
        lines={[
          ...(nextDue
            ? [
                {
                  // `guardianOutstanding`, not the subtraction: it floors at
                  // zero and answers zero for a settled status, which is the one
                  // definition of "still owed" this portal has.
                  amount: guardianOutstanding(nextDue),
                  heading: "Due next",
                  label: dates.period(nextDue.month),
                  note: nextDue.dueDate ? `Due ${dates.date(nextDue.dueDate)}` : undefined,
                },
              ]
            : []),
          {
            amount: lastPaid ? lastPaid.paidAmount : null,
            heading: "Last paid",
            label: lastPaid ? dates.period(lastPaid.month) : "No payments yet",
          },
        ]}
        overdueCount={overdue}
        total={dashboard.summary?.dueAmount ?? 0}
      />

      <View className="gap-5 px-5 pt-5">
        <Card className="gap-2">
          {/*
            The paid side, which the web shows as a metric. An outstanding figure
            on its own reads as a debt; beside what has been settled it reads as
            a rhythm with one month left in it. It is here rather than on the
            card because the card's second line already carries `Last paid`, and a
            total and its latest instalment in adjacent slots invites them to be
            read as the same kind of number.
          */}
          {paid !== null ? (
            <View className="flex-row items-center gap-2">
              <Badge label="Paid" tone="success" />
              <Text className="flex-1" variant="muted">
                {`${formatMoney(paid)} across the invoices shared with you.`}
              </Text>
            </View>
          ) : null}

          <Text variant="muted">
            Guardians can follow dues here but cannot settle them. Payment is made from
            the resident&apos;s own portal, or directly with the hostel office.
          </Text>
        </Card>

        <View>
          <SectionHeader
            subtitle={
              unpaid > 0
                ? `${unpaid} of ${dashboard.payments.length} still open`
                : undefined
            }
            title="Monthly dues"
          />
          {dashboard.payments.length === 0 ? (
            <Card>
              <EmptyState icon="receipt"
                description="The hostel has not billed this resident yet."
                title="No invoices"
              />
            </Card>
          ) : (
            <Card padding="px-4 py-1">
              {dashboard.payments.map((payment, index) => {
                const owed = guardianOutstanding(payment);
                // A one-off belongs to no month, so there is no month-keyed
                // receipt to join it to — the lookup is skipped rather than
                // reaching for a key that does not exist.
                const receipt = payment.month ? receipts.get(payment.month) : undefined;

                return (
                  <View key={payment.id}>
                    {index > 0 ? <RowDivider /> : null}
                    <ListRow
                      right={
                        <View className="items-end gap-1">
                          <Money
                            owed={owed > 0}
                            value={owed > 0 ? owed : payment.dueAmount}
                          />
                          <StatusPill status={payment.status} />
                        </View>
                      }
                      subtitle={
                        [
                          // The receipt *number*, not a download: there is no
                          // guardian receipt-PDF route, and an icon that
                          // downloads nothing is the dead control again.
                          receipt ? `Receipt ${receipt.receiptNumber}` : null,
                          owed > 0 ? formatDueLabel(payment.dueDate) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || undefined
                      }
                      title={dates.period(payment.month)}
                    />
                  </View>
                );
              })}
            </Card>
          )}
        </View>

        {/*
          Receipts have their own permission flag, so this section can be absent
          while dues above are visible — and an empty receipts list under a
          granted flag genuinely means none have been issued.
        */}
        {canSee(dashboard, "canViewReceipts") ? (
          <View>
            <SectionHeader subtitle="Issued by the hostel" title="Receipts" />
            <Card padding="px-4 py-1">
              {dashboard.receipts.length === 0 ? (
                <View className="py-3">
                  <Text variant="muted">
                    Receipts appear here as the hostel issues them.
                  </Text>
                </View>
              ) : (
                dashboard.receipts.map((receipt, index) => (
                  <View key={receipt.id}>
                    {index > 0 ? <RowDivider /> : null}
                    <ListRow
                      right={<Badge label={formatMoney(receipt.amount)} tone="success" />}
                      subtitle={`${dates.period(receipt.month)} · ${receipt.issuedOn}`}
                      title={receipt.receiptNumber}
                    />
                  </View>
                ))
              )}
            </Card>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
