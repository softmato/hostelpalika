import { View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import type { AdminNightStatus } from "@/lib/admin-api";

/**
 * Tonight's roll call, as progress rather than as a metric grid.
 *
 * ## Its own shape, not the group's painted band
 *
 * Today's job is a *shift*: a list of things that have to be done before the
 * night is over. So this leads with how far through that shift the hostel is —
 * `34 of 40 accounted for`, with a bar — rather than with three boxed figures
 * that leave the arithmetic to the reader. It is a card on the page background
 * with a tinted head, not paint bled to the screen edges, because Today is not
 * the front door and should not look like it.
 *
 * ## Accounted for is inside **plus** marked safe
 *
 * The figure a warden is working toward is "nobody unaccounted for", and a
 * resident who has marked themselves safe from their aunt's house is accounted
 * for — they are simply not in the building. Counting only `INSIDE_HOSTEL`
 * would leave the bar permanently short on a hostel where people travel, and
 * would make the number disagree with the unverified list below it, which is
 * what the warden is actually clearing.
 *
 * ## The bar's tone comes from what is left, not from what is done
 *
 * Amber while anybody is unverified, green when nobody is. A percentage-based
 * threshold would turn green at 39 of 40, which is exactly the state somebody
 * still has to do something about.
 */
export function AdminRollCallCard({
  date,
  summary,
}: {
  /** Rendered as-is — the caller owns the calendar. */
  date: string;
  summary: AdminNightStatus["summary"];
}) {
  const { colors } = useAppTheme();

  const accounted = summary.INSIDE_HOSTEL + summary.MARKED_SAFE;
  const total = summary.total;
  const outstanding = summary.NOT_VERIFIED;
  const settled = outstanding === 0;

  /*
   * Guarded against a hostel with no residents: `accounted / 0` is NaN, which
   * React Native renders as a zero-width bar and a `NaN%` caption.
   */
  const percent = total > 0 ? Math.round((accounted / total) * 100) : null;

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card">
      <View className="flex-row items-center gap-2 border-b border-border bg-muted px-4 py-2.5">
        <Glyph
          color={settled ? colors.success : colors.warning}
          name="moon"
          size={15}
        />
        <Text className="flex-1 text-sm font-semibold text-foreground">
          Tonight&apos;s roll call
        </Text>
        <Text variant="caption">{date}</Text>
      </View>

      <View className="gap-4 p-4">
        <View className="flex-row items-end justify-between gap-3">
          <View className="shrink">
            <Text variant="caption">Accounted for</Text>
            <Text
              className="text-2xl font-semibold tracking-tight text-foreground"
              numberOfLines={1}
            >
              {`${accounted} of ${total}`}
            </Text>
          </View>

          <View
            className={`shrink-0 flex-row items-center gap-1 rounded-full px-2.5 py-1 ${
              settled ? "bg-success-soft" : "bg-warning-soft"
            }`}
          >
            <Glyph
              color={settled ? colors.success : colors.warning}
              name={settled ? "checkmark-circle" : "help-circle"}
              size={12}
            />
            <Text
              className={`text-xs font-semibold ${settled ? "text-success" : "text-warning"}`}
            >
              {settled ? "All in" : `${outstanding} to check`}
            </Text>
          </View>
        </View>

        <View className="gap-1.5">
          <View className="h-2 w-full overflow-hidden rounded-full bg-muted">
            {percent === null ? null : (
              <View
                className={`h-full rounded-full ${settled ? "bg-success" : "bg-warning"}`}
                style={{ width: `${Math.max(percent > 0 ? 4 : 0, percent)}%` }}
              />
            )}
          </View>

          <View className="flex-row items-center gap-3">
            {[
              { label: "Inside", value: summary.INSIDE_HOSTEL },
              { label: "Safe elsewhere", value: summary.MARKED_SAFE },
              { label: "Outside", value: summary.OUTSIDE_HOSTEL },
              { label: "Unverified", value: summary.NOT_VERIFIED },
            ].map((fact) => (
              <View className="flex-1" key={fact.label}>
                <Text className="text-sm font-semibold text-foreground">{fact.value}</Text>
                <Text numberOfLines={1} variant="caption">
                  {fact.label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}
