import { ReceiptShareSettings } from "@/components/receipt-share-settings";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";

import {
  CashBoxTile,
  CategoryBars,
  ExpenseGlyph,
  ExpenseListRow,
  PendingCashCard,
  useExpenseAudience,
} from "@/components/expenses/expense-parts";
import { FLOAT_SHADOW } from "@/components/portal-shared";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import {
  CASH_STATUS_LABELS,
  EXPENSE_PAID_BY_LABELS,
  type ExpenseHome,
  type ExpenseRow,
  bsDayLong,
  expenseTitle,
  groupExpensesByDay,
  monthChange,
} from "@/lib/expenses";
import { cancelExpense, expenseQuery, type ExpenseLoad, walletQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { adminQuery } from "@/lib/admin-queries";
import { invalidateQuery } from "@/lib/query-cache";
import { toastError, toastSuccess } from "@/lib/toast";
import { privateAssetSource } from "@/lib/uploads";
import { addBsMonths, bsMonthName, periodParts } from "@hostel/calendar/bs";

/**
 * Expenses — Money Out (docs/EXPENSES_PLAN.md §3.1, §3.2).
 *
 * One screen for three people, and the server decides which one is holding the
 * phone. The **owner** gets the month: *In · Out · Left* on a card straddling
 * the header, where the money went, and every row anyone added. A **warden**
 * and the **cook** get the same shell with only their own rows and what they
 * spent — never the hostel's totals, which the API does not send them.
 *
 * The add button floats, because it is the reason most people open this screen:
 * somebody is standing in a shop with a bill in their hand.
 */

/** Room the bar paints under itself for the card that rides up onto it. */
const STRADDLE = 34;

/** `Asoj 2083` from `2083-06`. */
function periodLabel(period: string) {
  const parts = periodParts(period);

  return parts ? `${bsMonthName(parts.month)} ${parts.year}` : period;
}

export default function ExpensesScreen() {
  const { colors } = useAppTheme();
  const audience = useExpenseAudience();
  const token = useAppSelector((state) => state.auth.accessToken);

  /** `null` is this month — the entry the add screen shares. */
  const [period, setPeriod] = useState<string | null>(null);
  const query = expenseQuery(audience, period);
  const resource = useResource<ExpenseLoad>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const home: ExpenseHome | null = resource.data?.kind === "ok" ? resource.data.home : null;
  const denied = resource.data?.kind === "denied" ? resource.data : null;
  const days = useMemo(() => groupExpensesByDay(home?.expenses ?? []), [home]);

  const [open, setOpen] = useState<ExpenseRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const isOwner = home?.canSeeTotals === true;
  const shownPeriod = home?.period ?? null;
  const atCurrent = !home || home.period === home.currentPeriod;

  const step = useCallback(
    (delta: number) => {
      if (!home) return;

      const next = addBsMonths(home.period, delta);

      setPeriod(next === home.currentPeriod ? null : next);
    },
    [home],
  );

  /** A "Got it" moves the box, the list and the owner's statement. */
  const answered = useCallback(() => {
    invalidateQuery(expenseQuery(audience, null).key);
    invalidateQuery(walletQuery(null).key);
    resource.refresh();
  }, [audience, resource]);

  const closeSheet = useCallback(() => {
    setOpen(null);
    setCancelling(false);
    setReason("");
  }, []);

  const confirmCancel = useCallback(async () => {
    if (!open) return;

    if (reason.trim().length < 3) {
      toastError("Say why", "A few words, like “wrong amount”.");
      return;
    }

    setBusy(true);

    try {
      await cancelExpense(audience, open.id, reason.trim());
      toastSuccess("Expense cancelled", `${formatMoney(open.amount)} · ${expenseTitle(open)}`);
      closeSheet();
      invalidateQuery(expenseQuery(audience, null).key);
      // The owner's statement lists expenses as debits.
      invalidateQuery(adminQuery.ledger().key);
      resource.refresh();
    } catch (error) {
      toastError("Could not cancel", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [audience, closeSheet, open, reason, resource]);

  const addButton = (
    <FloatingButton
      icon="add"
      label="Add expense"
      onPress={() => router.push("/expenses/new")}
    />
  );

  /* ---------------------------------------------------------------- header */

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        centerTitle
        showBack
        straddle={home || resource.loading ? STRADDLE : 0}
        subtitle={isOwner ? "Money In and Money Out" : "What you spent"}
        title="Expenses"
      />

      {home || resource.loading ? (
        <View className="px-5" style={{ marginTop: -STRADDLE }}>
          <View className="gap-3 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
            {/* The month, with arrows: an owner looks back; nobody looks ahead. */}
            <View className="flex-row items-center justify-between">
              <Pressable
                accessibilityLabel="Previous month"
                accessibilityRole="button"
                className="h-9 w-9 items-center justify-center rounded-full active:opacity-60"
                disabled={!home}
                hitSlop={6}
                onPress={() => step(-1)}
              >
                <Ionicons color={colors.foreground} name="chevron-back" size={18} />
              </Pressable>
              <Text variant="label">
                {shownPeriod ? (atCurrent ? `This month · ${periodLabel(shownPeriod)}` : periodLabel(shownPeriod)) : " "}
              </Text>
              <Pressable
                accessibilityLabel="Next month"
                accessibilityRole="button"
                className={`h-9 w-9 items-center justify-center rounded-full active:opacity-60 ${
                  atCurrent ? "opacity-30" : ""
                }`}
                disabled={atCurrent}
                hitSlop={6}
                onPress={() => step(1)}
              >
                <Ionicons color={colors.foreground} name="chevron-forward" size={18} />
              </Pressable>
            </View>

            {!home ? (
              <View className="flex-row gap-3">
                <Skeleton height={36} width="30%" />
                <Skeleton height={36} width="30%" />
                <Skeleton height={36} width="30%" />
              </View>
            ) : home.totals ? (
              <View className="flex-row">
                <Figure label="Money In">
                  <Money tone="credit" value={home.totals.in} />
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Money Out">
                  <Money tone="debit" value={home.totals.out} />
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Left">
                  <Money owed={home.totals.left < 0} value={home.totals.left} />
                </Figure>
              </View>
            ) : home.wallet ? (
              // A warden's month opens on their cash box: what is left to spend.
              <Pressable
                accessibilityRole="button"
                className="flex-row items-center active:opacity-70"
                onPress={() => router.push("/expenses/wallet")}
              >
                <Figure label={home.wallet.left < 0 ? "Hostel owes you" : "Cash left"}>
                  <Money owed={home.wallet.left < 0} size="large" value={Math.abs(home.wallet.left)} />
                </Figure>
                <View className="w-px self-stretch bg-border" />
                <Figure label="You spent">
                  <Money tone="debit" value={home.mine.out} />
                </Figure>
                <Ionicons color={colors.mutedForeground} name="chevron-forward" size={16} />
              </Pressable>
            ) : (
              <View className="items-center gap-0.5">
                <Text variant="caption">You spent</Text>
                <Money size="large" tone="debit" value={home.mine.out} />
                <Text variant="caption">
                  {home.mine.count === 1 ? "1 expense" : `${home.mine.count} expenses`}
                </Text>
              </View>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );

  /* ------------------------------------------------------------------ body */

  if (resource.error && !resource.data) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  if (denied) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Expenses" />}>
        <Card className="gap-1">
          <Text variant="label">You cannot add expenses yet</Text>
          <Text variant="muted">
            {denied.code === "EXPENSES_OFF_FOR_COOK"
              ? "The owner has not turned this on for the kitchen. Ask them to turn on “Cook can add expenses”."
              : "Your account does not have “Add expenses”. Ask the hostel owner to turn it on for you."}
          </Text>
        </Card>
      </Screen>
    );
  }

  const change = home?.totals ? monthChange(home.totals.out, home.totals.lastMonthOut) : null;

  return (
    <>
      <Screen
        floating={home ? addButton : undefined}
        header={header}
        onRefresh={resource.refresh}
        padded={false}
        refreshing={resource.refreshing}
        scroll
      >
        <View className="gap-6 px-5 pt-5">
          {resource.loading ? <SkeletonRows rows={5} /> : null}

          {home && !isOwner && home.pendingCash.length > 0 ? (
            <View className="gap-3">
              {home.pendingCash.map((row) => (
                <PendingCashCard key={row.id} onAnswered={answered} row={row} />
              ))}
            </View>
          ) : null}

          {home?.wallets && home.wallets.length > 0 ? (
            <View>
              <SectionHeader title="Staff cash" />
              <ScrollView
                contentContainerClassName="gap-3 pr-5"
                horizontal
                showsHorizontalScrollIndicator={false}
              >
                {home.wallets.map((wallet) => (
                  <CashBoxTile
                    key={wallet.userId}
                    onPress={() => router.push({ params: { userId: wallet.userId }, pathname: "/expenses/wallet" })}
                    wallet={wallet}
                  />
                ))}
                <Pressable
                  accessibilityRole="button"
                  className="w-28 items-center justify-center gap-2 rounded-2xl border border-dashed border-border active:bg-muted"
                  onPress={() => router.push({ params: { category: "STAFF_CASH" }, pathname: "/expenses/new" })}
                >
                  <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-soft">
                    <Ionicons color={colors.primary} name="add" size={22} />
                  </View>
                  <Text className="text-primary" variant="label">
                    Give cash
                  </Text>
                </Pressable>
              </ScrollView>
            </View>
          ) : null}

          {home?.totals && home.totals.byCategory.length > 0 ? (
            <View>
              <SectionHeader
                subtitle={
                  change
                    ? `${formatMoney(change.amount)} ${change.more ? "more" : "less"} than last month`
                    : undefined
                }
                title="Spent on"
              />
              <Card>
                <CategoryBars rows={home.totals.byCategory} total={home.totals.out} />
              </Card>
            </View>
          ) : null}

          {home && home.expenses.length === 0 ? (
            <EmptyCard
              action={
                atCurrent ? (
                  <Button label="Add expense" onPress={() => router.push("/expenses/new")} size="sm" />
                ) : undefined
              }
              description={
                atCurrent
                  ? "Bought something for the hostel? Add it here. It takes a few seconds."
                  : "Nothing was added in this month."
              }
              title="No expenses yet"
            />
          ) : null}

          {days.map((day) => (
            <View className="gap-2" key={day.key}>
              {/* Heading on the page, outside the card (NOTES §5), with the day's total. */}
              <View className="flex-row items-end justify-between gap-3">
                <Text
                  className="shrink font-semibold uppercase tracking-wider text-muted-foreground"
                  numberOfLines={1}
                  style={{ fontSize: 11 }}
                >
                  {day.label}
                </Text>
                <Text className="text-xs font-semibold text-muted-foreground">
                  {formatMoney(day.total)}
                </Text>
              </View>

              <Card padding="px-4 py-1">
                {day.rows.map((row, index) => (
                  <View key={row.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ExpenseListRow onPress={() => setOpen(row)} row={row} showWho={isOwner} />
                  </View>
                ))}
              </Card>
            </View>
          ))}
        </View>
        {Platform.OS === "web" ? <View className="mx-5 my-2"><Button label="Import payment receipt" variant="outline" onPress={() => window.location.assign("/app/receipt-sheet.html")} /></View> : null}
        <ReceiptShareSettings />
      </Screen>

      {/* --------------------------------------------------------- one row */}
      <Sheet
        footer={
          open && open.status === "RECORDED" && (isOwner || open.mine) ? (
            cancelling ? (
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Button label="Back" onPress={() => setCancelling(false)} variant="outline" />
                </View>
                <View className="flex-1">
                  <Button
                    label="Cancel expense"
                    loading={busy}
                    onPress={() => void confirmCancel()}
                    variant="danger"
                  />
                </View>
              </View>
            ) : (
              <Button label="Cancel this expense" onPress={() => setCancelling(true)} variant="outline" />
            )
          ) : undefined
        }
        onClose={closeSheet}
        open={open !== null}
        title={open ? expenseTitle(open) : ""}
      >
        {open ? (
          <View className="gap-4 pb-2">
            <View className="flex-row items-center gap-3">
              <ExpenseGlyph category={open.category} muted={open.status === "VOID"} size={48} />
              <View className="flex-1 gap-1">
                <Money
                  size="large"
                  tone={open.status === "VOID" || open.cashTo ? "default" : "debit"}
                  value={open.amount}
                />
                {open.status === "VOID" ? <Badge label="Cancelled" /> : null}
              </View>
            </View>

            <View className="gap-2">
              {open.cashTo ? (
                <>
                  <FactRow label="Given to" value={open.cashTo.name} />
                  {open.cashStatus ? (
                    <FactRow label="Warden says" value={CASH_STATUS_LABELS[open.cashStatus]} />
                  ) : null}
                  {open.cashNote ? <FactRow label="Their note" value={open.cashNote} /> : null}
                </>
              ) : (
                <FactRow label="Spent on" value={open.categoryLabel} />
              )}
              {open.salaryFor ? <FactRow label="Salary for" value={open.salaryFor.name} /> : null}
              <FactRow label="Date" value={bsDayLong(open.spentOn)} />
              <FactRow label="Paid by" value={EXPENSE_PAID_BY_LABELS[open.paidBy]} />
              <FactRow label="Added by" value={open.mine ? "You" : open.recordedBy.name || "Staff"} />
              {open.status === "VOID" && open.voidReason ? (
                <FactRow label="Why cancelled" value={open.voidReason} />
              ) : null}
            </View>

            {open.photoAssetId ? (
              <Pressable
                accessibilityLabel="Open the bill photo"
                accessibilityRole="imagebutton"
                className="active:opacity-80"
                onPress={() =>
                  openAssetViewer([
                    { assetId: open.photoAssetId ?? undefined, caption: expenseTitle(open), title: "Bill" },
                  ])
                }
              >
                <Image
                  contentFit="cover"
                  source={privateAssetSource(open.photoAssetId, token, "MEDIUM")}
                  style={{ backgroundColor: colors.muted, borderRadius: 14, height: 180, width: "100%" }}
                />
              </Pressable>
            ) : null}

            {cancelling ? (
              <Input
                autoFocus
                hint="The owner sees this reason."
                label="Why cancel it?"
                onChangeText={setReason}
                placeholder="e.g. Wrong amount"
                value={reason}
              />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </>
  );
}

function Figure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View className="flex-1 items-center gap-1 px-1">
      <Text variant="caption">{label}</Text>
      {children}
    </View>
  );
}
