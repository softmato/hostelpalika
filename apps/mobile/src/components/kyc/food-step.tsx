import { View } from "react-native";
import { FoodWeekEditor } from "@/components/manage/food-week-editor";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { useFoodWeek } from "@/components/manage/food-week";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState, PermissionCard } from "@/components/ui/states";
import { Text } from "@/components/ui/text";

export function FoodStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const week = useFoodWeek({ onSaved: () => void onSaved() });
  const { cells, dirty, filled, food, save, saving } = week;
  useKycDraft({ dirty, busy: saving, save });

  if (food.loading) {
    return <SkeletonCard rows={3} />;
  }

  if (food.error) {
    return <ErrorState message={food.error} onRetry={food.reload} />;
  }

  if (food.data?.routine === null) {
    return <PermissionCard capability="food" feature="The weekly menu" />;
  }

  return (
    <View className="gap-4">
      <FoodWeekEditor week={week} />
      <Text variant="caption">{filled} of {cells} meals filled{dirty ? " · not saved yet" : ""}</Text>
    </View>
  );
}
