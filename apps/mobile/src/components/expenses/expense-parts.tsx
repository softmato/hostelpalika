import { Ionicons } from "@expo/vector-icons";
import { Pressable, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Meter } from "@/components/ui/meter";
import { Money } from "@/components/ui/money";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import {
  type ExpenseCategoryTotal,
  type ExpenseCategoryValue,
  type ExpenseRow,
  expenseIcon,
  expenseSubtitle,
  expenseTitle,
} from "@/lib/expenses";
import type { ExpenseAudience } from "@/lib/expenses-api";

/**
 * The pieces Money Out's screens share (docs/EXPENSES_PLAN.md §3).
 *
 * Built from the house vocabulary rather than beside it: a row is the tinted
 * glyph square `<CardRow>` uses, money is `<Money>` signed by colour, and the
 * category split is `<Meter>`. What is new here is only what is particular to an
 * expense — which glyph a category gets, and what a cancelled one looks like.
 */

/** Which door the API calls go through. The cook has its own; everyone else shares one. */
export function useExpenseAudience(): ExpenseAudience {
  const role = useAppSelector((state) => state.auth.account?.role);

  return role === ROLE.COOK ? "cook" : "staff";
}

/** The category's glyph on a brand-tinted square. */
export function ExpenseGlyph({
  category,
  muted = false,
  size = 40,
}: {
  category: ExpenseCategoryValue;
  muted?: boolean;
  size?: number;
}) {
  const { colors } = useAppTheme();

  return (
    <View
      className={`items-center justify-center rounded-xl ${muted ? "bg-muted" : "bg-brand-soft"}`}
      style={{ height: size, width: size }}
    >
      <Ionicons
        color={muted ? colors.mutedForeground : colors.primary}
        name={expenseIcon(category)}
        size={Math.round(size * 0.48)}
      />
    </View>
  );
}

/**
 * One expense in a day's card.
 *
 * Money out is red with a down caret — the wallet vocabulary our users already
 * read, and the same `debit` tone `<Money>` documents as "which way it went, not
 * that anything is wrong". A cancelled row stays in the list, struck through
 * and grey, so the owner sees the mistake and its correction together.
 */
export function ExpenseListRow({
  onPress,
  row,
  showWho,
}: {
  onPress: () => void;
  row: ExpenseRow;
  /** The owner's list names who added each row; a warden's is all their own. */
  showWho: boolean;
}) {
  const { colors } = useAppTheme();
  const cancelled = row.status === "VOID";

  return (
    <Pressable
      accessibilityLabel={`${expenseTitle(row)}, ${row.amount} rupees${cancelled ? ", cancelled" : ""}`}
      accessibilityRole="button"
      className="flex-row items-center gap-3 py-3 active:opacity-70"
      onPress={onPress}
    >
      <ExpenseGlyph category={row.category} muted={cancelled} />

      <View className="flex-1 gap-0.5">
        <Text
          className={`font-semibold ${cancelled ? "text-muted-foreground line-through" : "text-foreground"}`}
          numberOfLines={1}
          style={{ fontSize: 15 }}
        >
          {expenseTitle(row)}
        </Text>
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Text numberOfLines={1} variant="caption">
            {cancelled ? "Cancelled" : expenseSubtitle(row, showWho)}
          </Text>
          {row.photoAssetId && !cancelled ? (
            <Ionicons color={colors.mutedForeground} name="image-outline" size={12} />
          ) : null}
        </View>
      </View>

      {cancelled ? (
        <Badge label="Cancelled" />
      ) : (
        <View className="flex-row items-center gap-1">
          <Ionicons color={colors.destructive} name="caret-down" size={12} />
          <Money tone="debit" value={row.amount} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * Where the month's money went, biggest first, as bars of the month's total.
 *
 * Bars, not a pie: a pie of eleven slices cannot be read on a phone, and the
 * question an owner asks — "what did most of it go on?" — is answered by the
 * first line of a sorted list.
 */
export function CategoryBars({ rows, total }: { rows: readonly ExpenseCategoryTotal[]; total: number }) {
  return (
    <View className="gap-4">
      {rows.map((row) => {
        const percent = total > 0 ? Math.round((row.amount / total) * 100) : 0;

        return (
          <View className="gap-2" key={`${row.category}:${row.customCategoryId ?? ""}`}>
            <View className="flex-row items-center gap-3">
              <ExpenseGlyph category={row.category} size={32} />
              <Text className="flex-1" numberOfLines={1} variant="label">
                {row.label}
              </Text>
              <Text className="text-xs text-muted-foreground">{`${percent}%`}</Text>
              <Money value={row.amount} />
            </View>
            <Meter height={6} label={null} percent={percent} reading="share" />
          </View>
        );
      })}
    </View>
  );
}
