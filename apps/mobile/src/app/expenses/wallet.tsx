import { router, useLocalSearchParams } from "expo-router";
import { HandCoins, Plus } from "lucide-react-native";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";

import { ExpenseListRow } from "@/components/expenses/expense-parts";
import { FLOAT_SHADOW } from "@/components/portal-shared";
import { AppBar } from "@/components/ui/app-bar";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import { openAssetViewer } from "@/lib/asset-viewer";
import { expenseTitle, groupExpensesByDay, walletPercent } from "@/lib/expenses";
import { walletQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";

/**
 * One warden's cash box (docs/EXPENSES_PLAN.md §3.4): what is left, a gauge of
 * it, and every rupee behind it — handed over (+) and spent (−), by day, each
 * with its bill. The owner reaches it from a tile on Expenses with `userId`; a
 * warden opens their own from the header card, and the server ignores any
 * `userId` they pass.
 */

const STRADDLE = 34;

export default function CashBoxScreen() {
  const { userId } = useLocalSearchParams<{ userId?: string }>();
  const isOwner = useAppSelector((state) => state.auth.account?.role) === ROLE.HOSTEL_ADMIN;
  const query = walletQuery(isOwner && userId ? userId : null);
  const resource = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const detail = resource.data ?? null;
  const wallet = detail?.wallet ?? null;
  const days = useMemo(() => groupExpensesByDay(detail?.rows ?? []), [detail]);
  const owes = (wallet?.left ?? 0) < 0;

  const header = (
    <View className="bg-background">
      <AppBar accent centerTitle showBack straddle={STRADDLE} title={isOwner ? "Cash box" : "My cash"} />
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <View className="gap-3 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
          {wallet ? (
            <>
              <View className="flex-row items-center gap-3">
                <Avatar name={wallet.name || "Warden"} size="md" />
                <View className="flex-1 gap-0.5">
                  <Text variant="caption">{owes ? "Hostel owes" : "Cash left"}</Text>
                  <Money owed={owes} size="large" value={Math.abs(wallet.left)} />
                </View>
              </View>
              <Meter label={null} percent={walletPercent(wallet)} reading="remaining" />
              <View className="flex-row">
                <Figure label="Given">
                  <Money tone="credit" value={wallet.given} />
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Spent">
                  <Money tone="debit" value={wallet.spent} />
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Waiting">
                  <Money value={wallet.pending} />
                </Figure>
              </View>
            </>
          ) : (
            <View className="gap-3">
              <Skeleton height={44} width="60%" />
              <Skeleton height={8} width="100%" />
            </View>
          )}
        </View>
      </View>
    </View>
  );

  if (resource.error && !detail) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        wallet ? (
          isOwner ? (
            <Button
              icon={HandCoins}
              label="Give cash"
              onPress={() =>
                router.push({ params: { category: "STAFF_CASH", to: wallet.userId }, pathname: "/expenses/new" })
              }
              size="lg"
            />
          ) : (
            <Button icon={Plus} label="Add expense" onPress={() => router.push("/expenses/new")} size="lg" />
          )
        ) : undefined
      }
      header={header}
      onRefresh={resource.refresh}
      padded={false}
      refreshing={resource.refreshing}
      scroll
    >
      <View className="gap-6 px-5 pt-5">
        {resource.loading && !detail ? <SkeletonRows rows={5} /> : null}

        {detail && detail.rows.length === 0 ? (
          <EmptyCard description="Cash given and spent shows here." title="Nothing yet" />
        ) : null}

        {days.map((day) => (
          <View className="gap-2" key={day.key}>
            <View className="flex-row items-end justify-between gap-3">
              <Text
                className="shrink font-semibold uppercase tracking-wider text-muted-foreground"
                numberOfLines={1}
                style={{ fontSize: 11 }}
              >
                {day.label}
              </Text>
              {day.total > 0 ? (
                <Text className="text-xs font-semibold text-muted-foreground">{`−${formatMoney(day.total)}`}</Text>
              ) : null}
            </View>
            <Card padding="px-4 py-1">
              {day.rows.map((row, index) => (
                <View key={row.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  {/* In a cash box a handover is money in, so rows read from the box's side. */}
                  <ExpenseListRow
                    onPress={() =>
                      row.photoAssetId
                        ? openAssetViewer([{ assetId: row.photoAssetId, caption: expenseTitle(row), title: "Bill" }])
                        : undefined
                    }
                    row={row}
                    showWho={false}
                  />
                </View>
              ))}
            </Card>
          </View>
        ))}
      </View>
    </Screen>
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
