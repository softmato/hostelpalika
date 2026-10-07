import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { formatMoney } from "@/lib/format";
import { khataQuery } from "@/lib/khata-api";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1 rounded-xl bg-muted px-3 py-2.5">
      <Text variant="subtitle">{value}</Text>
      <Text variant="caption">{label}</Text>
    </View>
  );
}

/**
 * The resident's khata on Home: three numbers and one button.
 *
 * Hidden only when there is nothing to show at all — the hostel has listed no
 * items and the resident never asked. Everything else opens `/khata`.
 */
export function KhataHomeCard() {
  const { colors } = useAppTheme();
  const query = khataQuery.resident();
  const khata = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const data = khata.data;

  if (!data || (data.status === "NONE" && data.items.length === 0)) {
    return null;
  }

  const open = () => router.push("/khata");
  const waiting = data.entries.filter((row) => row.status === "REQUESTED").length;

  return (
    <Pressable
      accessibilityRole="button"
      className="gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
      onPress={open}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
          <Ionicons color={colors.primary} name="receipt-outline" size={22} />
        </View>
        <View className="flex-1">
          <Text variant="subtitle">Khata</Text>
          <Text variant="caption">Egg, meals, laundry — on next month&apos;s bill</Text>
        </View>
        <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
      </View>

      {data.status === "ACTIVE" ? (
        <>
          <View className="flex-row gap-2">
            <Stat label="On next bill" value={formatMoney(data.unbilled)} />
            <Stat label="Waiting" value={String(waiting)} />
            <Stat label="Bills" value={String(data.bills?.length ?? 0)} />
          </View>
          <Button label="Ask for something" onPress={open} size="sm" />
        </>
      ) : (
        <Button
          disabled={data.status === "REQUESTED"}
          label={data.status === "REQUESTED" ? "Waiting for the warden" : "Open my khata"}
          onPress={open}
          size="sm"
          variant={data.status === "REQUESTED" ? "secondary" : "primary"}
        />
      )}
    </Pressable>
  );
}

/**
 * The staff side of the same card, on the owner's and warden's Home: how many
 * khatas are open, how many residents are waiting on an answer, and what goes
 * on the next bills. A request used to reach staff only as a bell row with
 * nowhere to approve it; this is the door, and Approve is one tap behind it.
 *
 * Hidden when the account cannot read khata (a warden without `viewPayments`
 * gets a 403) and while it loads, like the resident card.
 */
export function KhataStaffCard() {
  const { colors } = useAppTheme();
  const query = khataQuery.admin();
  const khata = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const data = khata.data;

  if (!data || khata.error) {
    return null;
  }

  const open = () => router.push("/manage/finance/khata");
  const pending = data.requests.length + data.waiting.length;
  const toBill = data.accounts.reduce((sum, account) => sum + account.unbilled, 0);

  return (
    <Pressable
      accessibilityRole="button"
      className="gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
      onPress={open}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
          <Ionicons color={colors.primary} name="receipt-outline" size={22} />
        </View>
        <Text className="flex-1" variant="subtitle">
          Khata
        </Text>
        <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
      </View>

      <View className="flex-row gap-2">
        <Stat label="Open" value={String(data.accounts.length)} />
        <Stat label="Pending" value={String(pending)} />
        <Stat label="To bill" value={formatMoney(toBill)} />
      </View>

      {data.requests.length > 0 ? (
        <Button label={`Approve ${data.requests.length}`} onPress={open} size="sm" />
      ) : null}
    </Pressable>
  );
}
