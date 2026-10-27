import { router } from "expo-router";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { FLOAT_SHADOW } from "@/components/portal-shared";
import { categoryLabel, monthLabel, NoStockAccess, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { DataCard } from "@/components/ui/data-card";
import { Glyph } from "@/components/ui/glyph";
import { Stagger } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { downloadToDevice } from "@/lib/documents";
import { formatMoney } from "@/lib/format";
import { formatQty, type ReportRange, reportFileUrl, reportQuery, type StockReportItem } from "@/lib/stock-api";
import { toastError } from "@/lib/toast";

/**
 * Stock report (docs/FIELD_REVIEW_2026_10_27.md D2) — numbers, not sentences.
 *
 * Over this month, three months or a year: per item **bought · used · left**,
 * and what next month should cost at that pace, on the card over the header.
 * PDF and CSV are the same table, through the global downloader.
 *
 * Owner and money staff only; the tile is not shown to anyone else.
 */

const STRADDLE = 34;
const RANGES = [
  { label: "This month", value: "month" },
  { label: "3 months", value: "quarter" },
  { label: "Year", value: "year" },
] as const;

export default function StockReportsScreen() {
  const { colors } = useAppTheme();
  const { denied, here, home } = useStock();
  const [range, setRange] = useState<ReportRange>("month");
  const query = reportQuery(range);
  const resource = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const report = resource.data ?? null;
  const [saving, setSaving] = useState<"csv" | "pdf" | null>(null);

  const groups = useMemo(() => {
    const byCategory = new Map<string, StockReportItem[]>();

    for (const item of report?.items ?? []) byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item]);

    return [...byCategory];
  }, [report]);

  const download = async (format: "csv" | "pdf") => {
    setSaving(format);

    try {
      await downloadToDevice({
        extension: format,
        fileName: `stock-report-${range}`,
        label: "Stock report",
        mimeType: format === "pdf" ? "application/pdf" : "text/csv",
        url: reportFileUrl(range, format),
      });
    } catch (error) {
      toastError("Could not download", readApiError(error, "The report did not download."));
    } finally {
      setSaving(null);
    }
  };

  const header = (
    <View className="bg-background">
      <AppBar accent centerTitle showBack straddle={STRADDLE} subtitle={report?.scope ?? here?.name ?? "All buildings"} title="Stock report" />
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <View className="rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
          {!report?.totals ? (
            <View className="flex-row gap-3">
              <Skeleton height={44} width="48%" />
              <Skeleton height={44} width="48%" />
            </View>
          ) : (
            <View className="flex-row">
              <Figure label={`${monthLabel(report.nextPeriod)} · expected`}>
                <Money value={report.totals.nextValue} />
              </Figure>
              <View className="w-px bg-border" />
              <Figure label="Per student / day">
                {report.costPerResidentDay !== null ? <Money value={report.costPerResidentDay} /> : <Text variant="subtitle">—</Text>}
              </Figure>
            </View>
          )}
        </View>
      </View>
    </View>
  );

  if (denied || (home && !home.money)) {
    return (
      <Screen header={header}>
        {denied ? <NoStockAccess /> : <EmptyCard description="Reports show money. Ask the owner." title="Not for this account" />}
      </Screen>
    );
  }

  if (resource.error && !report) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        report && report.items.length > 0 ? (
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button icon="download" label="PDF" loading={saving === "pdf"} onPress={() => void download("pdf")} size="lg" variant="outline" />
            </View>
            <View className="flex-1">
              <Button icon="download" label="CSV" loading={saving === "csv"} onPress={() => void download("csv")} size="lg" variant="outline" />
            </View>
          </View>
        ) : undefined
      }
      header={header}
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      scroll
    >
      <Stagger className="gap-6 pb-8 pt-5">
        <Segmented onChange={setRange} options={RANGES} value={range} />

        {!report || report.range !== range ? (
          <SkeletonRows rows={6} />
        ) : report.items.length === 0 ? (
          <EmptyCard description={report.label} title="Nothing bought or used" />
        ) : null}

        {report?.range === range && report.totals ? (
          <DataCard
            segments={[
              { label: `Used ${formatMoney(report.totals.usedValue)}`, tone: "brand", value: report.totals.usedValue },
              { label: `Wasted ${formatMoney(report.totals.wastedValue)}`, tone: "danger", value: report.totals.wastedValue },
              { label: `Missing ${formatMoney(report.totals.missingValue)}`, tone: "warning", value: report.totals.missingValue },
            ]}
            stats={[
              { label: "Bought", value: formatMoney(report.totals.boughtValue) },
              { label: "In store now", value: formatMoney(report.totals.stockValue) },
              { label: "Days", value: String(report.days) },
            ]}
            title={`${report.label} · ${formatMoney(report.totals.usedValue + report.totals.wastedValue + report.totals.missingValue)} out`}
            total={Math.max(1, report.totals.usedValue + report.totals.wastedValue + report.totals.missingValue)}
          />
        ) : null}

        {report?.range === range
          ? groups.map(([category, rows]) => (
              <View key={category}>
                <GroupHeading
                  label={categoryLabel(category)}
                  value={`${formatMoney(rows.reduce((sum, row) => sum + (row.nextValue ?? 0), 0))} next month`}
                />
                <Card padding="px-4 py-0">
                  {rows.map((item, index) => (
                    <View key={item.id}>
                      {index > 0 ? <RowDivider inset /> : null}
                      <ItemFigures item={item} />
                    </View>
                  ))}
                </Card>
              </View>
            ))
          : null}

        {report?.range === range && report.bySupplier.length > 0 ? (
          <View>
            <SectionHeader title="Bought from" />
            <Card padding="px-4 py-0">
              {report.bySupplier.map((row, index) => (
                <View key={row.supplierId ?? row.name}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-16 flex-row items-center gap-3 py-3 active:opacity-70"
                    disabled={!row.supplierId}
                    onPress={() => row.supplierId && router.push({ params: { id: row.supplierId }, pathname: "/stock/supplier/[id]" })}
                  >
                    <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-soft">
                      <Glyph color={colors.primary} name="storefront" size={20} />
                    </View>
                    <View className="flex-1">
                      <Text numberOfLines={1} variant="label">
                        {row.name}
                      </Text>
                      <Text variant="caption">
                        {row.bills} bill{row.bills === 1 ? "" : "s"} · {formatMoney(row.paid)} paid
                      </Text>
                    </View>
                    <Text variant="label">{formatMoney(row.billed)}</Text>
                  </Pressable>
                </View>
              ))}
            </Card>
          </View>
        ) : null}
      </Stagger>
    </Screen>
  );
}

function Figure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View className="flex-1 items-center gap-0.5 px-1">
      <Text numberOfLines={1} variant="caption">
        {label}
      </Text>
      {children}
    </View>
  );
}

/** A group's name outside its card, small capitals, with its total on the right. */
function GroupHeading({ label, value }: { label: string; value: string }) {
  return (
    <View className="mb-2 flex-row items-center justify-between px-1">
      <Text className="font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: 11 }}>
        {label}
      </Text>
      <Text className="text-muted-foreground" style={{ fontSize: 12 }}>
        {value}
      </Text>
    </View>
  );
}

/** One item: name and next month's cost, then bought · used · left · next month. */
function ItemFigures({ item }: { item: StockReportItem }) {
  return (
    <View className="gap-1.5 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1" numberOfLines={1} variant="label">
          {item.name}
        </Text>
        <Text variant="label">{item.nextValue !== null ? formatMoney(item.nextValue) : "—"}</Text>
      </View>
      <View className="flex-row">
        <Cell label="Bought">{formatQty(item.bought, item.unit)}</Cell>
        <Cell label="Used">{formatQty(item.used, item.unit)}</Cell>
        <Cell label="Left">{item.left !== null ? formatQty(item.left, item.unit) : "—"}</Cell>
        <Cell label="Next month" strong>
          {formatQty(item.nextQty, item.unit)}
        </Cell>
      </View>
    </View>
  );
}

function Cell({ children, label, strong = false }: { children: ReactNode; label: string; strong?: boolean }) {
  return (
    <View className="flex-1 gap-0.5">
      <Text style={{ fontSize: 10 }} variant="caption">
        {label}
      </Text>
      <Text className={strong ? "font-semibold" : undefined} numberOfLines={1} style={{ fontSize: 13 }}>
        {children}
      </Text>
    </View>
  );
}
