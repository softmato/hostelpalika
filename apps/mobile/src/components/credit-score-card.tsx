import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import type { CreditScore } from "@/lib/credit-score-api";
import { residentQuery } from "@/lib/resident-queries";

/**
 * The resident's credit score (todo C4): the number, receipts shared and
 * approved, the one rule that earns the most, and a tap through to the perks.
 */
export function CreditScoreCard() {
  const { colors } = useAppTheme();
  const query = residentQuery.creditScore();
  const score = useResource<CreditScore>(query.load, { cacheKey: query.key, topics: query.topics });

  if (score.loading) return <Skeleton height={92} radius={16} />;
  if (!score.data) return null;

  const best = score.data.rules[0];

  return (
    <Pressable
      accessibilityHint="Opens your perks"
      accessibilityRole="button"
      className="active:opacity-80"
      onPress={() => router.push("/offer-program/mine")}
    >
      <Card className="flex-row items-center gap-4">
        <View className="h-14 w-14 items-center justify-center rounded-full bg-brand-soft">
          <Text className="font-amount text-xl font-bold text-primary">{score.data.score}</Text>
        </View>
        <View className="flex-1 gap-0.5">
          <Text variant="label">Credit score</Text>
          <Text variant="caption">{`Shared ${score.data.shared} · approved ${score.data.approved}`}</Text>
          {best ? <Text variant="caption">{`Pay in day ${best.days}: ${best.points} points`}</Text> : null}
        </View>
        <Glyph color={colors.mutedForeground} name="chevron-forward" size={20} />
      </Card>
    </Pressable>
  );
}
