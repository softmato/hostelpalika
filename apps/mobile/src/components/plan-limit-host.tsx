import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { promptPlanLimit, subscribePlanLimit, type PlanLimitPrompt } from "@/lib/plan-limit";

/** A plan cap or the read-only lock, answered with the way out: compare plans. */
export function PlanLimitHost() {
  const [prompt, setPrompt] = useState<PlanLimitPrompt | null>(null);

  useEffect(() => subscribePlanLimit(setPrompt), []);

  const close = () => promptPlanLimit(null);

  return (
    <Sheet
      fitContent
      footer={
        <View className="gap-2">
          <Button
            label="Compare plans"
            onPress={() => {
              close();
              router.push("/manage/billing");
            }}
          />
          <Button label="Not now" onPress={close} variant="outline" />
        </View>
      }
      onClose={close}
      open={prompt !== null}
      title={prompt?.code === "PLAN_OVER_LIMIT" ? "Your portal is read-only" : "You've reached your plan's limit"}
    >
      <Text className="text-sm text-foreground" variant={null}>
        {prompt?.message}
      </Text>
    </Sheet>
  );
}
