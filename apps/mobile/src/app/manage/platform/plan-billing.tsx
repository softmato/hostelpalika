import { router } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { formatMoney } from "@/lib/format";
import { getPlanLedger, statusLabel } from "@/lib/platform-admin-api";

/**
 * Plan billing — the web's Plan Billing ledger: every plan invoice (with what is
 * still owed) and every payment that arrived. A row opens its hostel.
 */

type View_ = "unpaid" | "invoices" | "payments";

const invoiceTone = (status: string) =>
  status === "PAID" ? "success" : status === "VOID" || status === "CANCELLED" ? "neutral" : status === "OVERDUE" ? "danger" : "warning";

export default function PlanBillingScreen() {
  const dates = useDates();
  const ledger = useResource(getPlanLedger, { cacheKey: "platform:plan-ledger" });
  const [view, setView] = useState<View_>("unpaid");
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const hit = (...values: (string | null)[]) => !needle || values.some((value) => value?.toLowerCase().includes(needle));

  const invoices = useMemo(
    () =>
      (ledger.data?.invoices ?? []).filter(
        (row) => (view !== "unpaid" || row.outstanding > 0) && hit(row.hostelName, row.invoiceNumber, row.printedNumber, row.planName),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger.data, view, needle],
  );
  const payments = useMemo(
    () => (ledger.data?.payments ?? []).filter((row) => hit(row.hostelName, row.invoiceNumber, row.receiptNumber, row.method)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger.data, needle],
  );
  const unpaidCount = (ledger.data?.invoices ?? []).filter((row) => row.outstanding > 0).length;

  return (
    <Screen
      header={<AppBar showBack title="Plan billing" />}
      onRefresh={ledger.refresh}
      refreshing={ledger.refreshing}
      scroll
    >
      <View className="gap-4">
        <Segmented
          onChange={setView}
          options={[
            { count: unpaidCount, label: "Unpaid", value: "unpaid" },
            { label: "Invoices", value: "invoices" },
            { label: "Payments", value: "payments" },
          ]}
          value={view}
        />

        <Input onChangeText={setSearch} placeholder="Search hostel, invoice, receipt" value={search} />

        {ledger.loading ? (
          <SkeletonRows rows={6} />
        ) : ledger.error ? (
          <ErrorState message={ledger.error} onRetry={ledger.reload} />
        ) : view === "payments" ? (
          payments.length === 0 ? (
            <EmptyCard description="Payments show here as they arrive." title="No payments" />
          ) : (
            <Card padding="px-4 py-1">
              {payments.map((row, index) => (
                <View key={`${row.invoiceNumber}-${row.receiptNumber ?? index}`}>
                  {index > 0 ? <RowDivider /> : null}
                  <ListRow
                    icon="cash"
                    onPress={() => router.push(`/manage/platform/hostel/${row.hostelId}`)}
                    right={<Badge label={statusLabel(row.status)} tone={row.status === "SETTLED" ? "success" : row.status === "FAILED" ? "danger" : "warning"} />}
                    subtitle={[statusLabel(row.provider ?? row.method), row.paidAt ? dates.date(row.paidAt) : null].filter(Boolean).join(" · ")}
                    title={`${row.hostelName} · ${formatMoney(row.amount)}`}
                  />
                </View>
              ))}
            </Card>
          )
        ) : invoices.length === 0 ? (
          <EmptyCard description={view === "unpaid" ? "Every invoice is paid." : "No invoice yet."} title="Nothing here" />
        ) : (
          <Card padding="px-4 py-1">
            {invoices.map((row, index) => (
              <View key={row.invoiceNumber}>
                {index > 0 ? <RowDivider /> : null}
                <ListRow
                  icon="receipt"
                  onPress={() => router.push(`/manage/platform/hostel/${row.hostelId}`)}
                  right={<Badge label={row.outstanding > 0 ? `${formatMoney(row.outstanding)} due` : statusLabel(row.status)} tone={invoiceTone(row.status)} />}
                  subtitle={[row.planName, row.printedNumber || row.invoiceNumber, row.dueAt ? `due ${dates.date(row.dueAt)}` : null].filter(Boolean).join(" · ")}
                  title={`${row.hostelName} · ${formatMoney(row.amount)}`}
                />
              </View>
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}
