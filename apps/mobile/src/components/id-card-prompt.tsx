import { router } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

import { IconPoint } from "@/components/step-flow";
import { Button } from "@/components/ui/button";
import { Lottie } from "@/components/ui/lottie";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { idCardNoun } from "@/lib/id-card";
import type { IdCardType } from "@/lib/identity-api";

/** The header card button's invitation to make an ID: one animation, one line, one action. */
export function IdCardPrompt({
  cardType,
  onClose,
  open,
}: {
  cardType: IdCardType;
  onClose: () => void;
  open: boolean;
}) {
  const start = useCallback(() => {
    onClose();
    router.push("/id-card/edit");
  }, [onClose]);

  return (
    <Sheet onClose={onClose} open={open}>
      <View className="gap-5 pb-2 pt-1">
        <View className="items-center gap-3">
          <Lottie loop={false} size={150} source={require("../../assets/lottie/id-card-creation-shett.lottie")} />
          <Text className="text-center" variant="title">
            Let&apos;s make your {idCardNoun(cardType)} card
          </Text>
          <Text className="text-center" variant="muted">
            Fill it in once. Any hostel registers you from its QR code.
          </Text>
        </View>

        <View className="gap-3">
          <IconPoint
            delay={250}
            icon="shield-checkmark"
            text="Stored encrypted against your account. A hostel only sees it when you show them the code."
          />
          <IconPoint
            delay={400}
            icon="qr-code"
            text="Your card is ready the moment you save — QR code, ID number and all."
          />
        </View>

        <View className="gap-2">
          <Button label="Create my card" onPress={start} />
          <Button label="Not now" onPress={onClose} variant="ghost" />
        </View>
      </View>
    </Sheet>
  );
}
