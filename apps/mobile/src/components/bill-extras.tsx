import { View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Money as Amount } from "@/components/ui/money";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { billRows } from "@/lib/admin-money";
import { formatMoney } from "@/lib/format";

type BillLine = { amount: number; basis: string; description: string };

/**
 * The late fine and khata on a bill, one tinted row each — under the amount on
 * the pay screen and in the Money tab's cash sheet. Rent lines are left out:
 * the amount above already says the rent.
 */
export function BillExtras({ lines }: { lines?: BillLine[] | null }) {
  const { colors } = useAppTheme();
  const extras = (lines ?? []).filter((line) => line.basis === "FINE" || line.basis === "KHATA");

  if (extras.length === 0) {
    return null;
  }

  return (
    <View className="gap-2">
      {extras.map((line) => {
        const fine = line.basis === "FINE";

        return (
          <View
            className="flex-row items-center gap-3 rounded-2xl bg-muted px-3 py-2.5"
            key={line.basis}
          >
            <View
              className={`h-9 w-9 items-center justify-center rounded-xl ${fine ? "bg-warning-soft" : "bg-brand-soft"}`}
            >
              <Glyph
                color={fine ? colors.warning : colors.primary}
                name={fine ? "alarm" : "receipt"}
                size={18}
              />
            </View>
            <View className="flex-1">
              <Text variant="subtitle">{fine ? "Late fine" : "Khata"}</Text>
              <Text numberOfLines={2} variant="caption">
                {line.description.replace(/^(Late fine|Khata) — /, "")}
              </Text>
            </View>
            <Text variant="subtitle">{formatMoney(line.amount)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The whole bill in the Money tab's cash sheet: every line in reading order
 * (`billRows`), then Total, Paid and Left. A discount row appears only when
 * the bill has one.
 */
export function BillBreakdown({
  dueAmount,
  lines,
  paidAmount,
}: {
  dueAmount: number;
  lines?: BillLine[] | null;
  paidAmount: number;
}) {
  const rows = billRows(lines);
  const left = Math.max(0, dueAmount - paidAmount);

  // No box: the rows, a hairline, then one figure — "To collect" until
  // something is paid, then Paid and Left.
  return (
    <View className="gap-2">
      {rows.map((row, index) => (
        <View className="flex-row items-start justify-between gap-3" key={`${row.kind}-${index}`}>
          <View className="flex-1">
            <Text className="text-sm text-foreground">{row.label}</Text>
            {row.detail ? (
              <Text numberOfLines={1} variant="caption">
                {row.detail}
              </Text>
            ) : null}
          </View>
          <Amount tone={row.amount < 0 ? "credit" : "default"} value={row.amount} />
        </View>
      ))}
      <View className="gap-1.5 border-t border-border pt-2">
        {paidAmount > 0 ? (
          <View className="flex-row justify-between">
            <Text variant="muted">{`Paid of ${formatMoney(dueAmount)}`}</Text>
            <Amount tone="credit" value={paidAmount} />
          </View>
        ) : null}
        <View className="flex-row items-center justify-between">
          <Text variant="subtitle">{paidAmount > 0 ? "Left" : "To collect"}</Text>
          <Amount owed size="large" value={left} />
        </View>
      </View>
    </View>
  );
}
