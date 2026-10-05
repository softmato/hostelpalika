import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
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
              <Ionicons
                color={fine ? colors.warning : colors.primary}
                name={fine ? "alarm-outline" : "receipt-outline"}
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
