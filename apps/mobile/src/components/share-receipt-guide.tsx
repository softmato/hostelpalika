import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useState } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The four steps, as pictures drawn by `scripts/share-guide` — the bank app in
 * them is generic grey, so no real bank's or wallet's colours appear here.
 */
const STEPS = [
  {
    image: require("../../assets/images/share-guide/step-1.png"),
    title: "Open the payment in your bank or wallet app. Tap Share.",
  },
  {
    image: require("../../assets/images/share-guide/step-2.png"),
    title: "Pick HostelPalika.",
  },
  {
    image: require("../../assets/images/share-guide/step-3.png"),
    title: "Check the amount and month. Tap Send to hostel.",
  },
  {
    image: require("../../assets/images/share-guide/step-4.png"),
    title: "Done. You'll get a notification when it's confirmed.",
  },
] as const;

/** Safari cannot receive a share into a web app, so the steps would not work there. */
const canReceiveShares =
  Platform.OS !== "web" ||
  (typeof navigator !== "undefined" && !/iPad|iPhone|iPod/.test(navigator.userAgent));

/**
 * "See how to share your receipt straight to the app" — one quiet row that
 * opens the steps in a sheet.
 *
 * Sharing from the bank app opens a sheet over it that reads the receipt,
 * matches the month and sends the proof, so the whole lesson is knowing the
 * Share button leads here. One step at a time with Next rather than a swipe
 * pager: a horizontal swipe inside a bottom sheet fights the sheet's own drag.
 */
export function ShareReceiptGuide() {
  const { colors } = useAppTheme();
  const window = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  if (!canReceiveShares) {
    return null;
  }

  const last = step === STEPS.length - 1;
  const height = Math.min(400, Math.round(window.height * 0.46));

  return (
    <>
      <Pressable
        accessibilityRole="button"
        className="flex-row items-center gap-3 rounded-2xl bg-brand-soft px-4 py-3 active:opacity-80"
        onPress={() => {
          setStep(0);
          setOpen(true);
        }}
      >
        <Ionicons color={colors.primary} name="share-social-outline" size={18} />
        <Text className="flex-1 text-primary" variant="label">
          See how to share your receipt straight to the app
        </Text>
        <Ionicons color={colors.primary} name="chevron-forward" size={16} />
      </Pressable>

      <Sheet
        footer={
          <View className="flex-row gap-2.5">
            {step > 0 ? (
              <View className="flex-1">
                <Button label="Back" onPress={() => setStep(step - 1)} variant="outline" />
              </View>
            ) : null}
            <View className="flex-1">
              <Button
                label={last ? "Got it" : "Next"}
                onPress={() => (last ? setOpen(false) : setStep(step + 1))}
              />
            </View>
          </View>
        }
        onClose={() => setOpen(false)}
        open={open}
        title="Share your receipt to the app"
      >
        <View className="items-center gap-4 pb-2">
          <Image
            accessibilityLabel={`Step ${step + 1}: ${STEPS[step].title}`}
            contentFit="contain"
            source={STEPS[step].image}
            style={{ height, width: height / 2 }}
            transition={150}
          />

          <View className="flex-row gap-1.5">
            {STEPS.map((_, index) => (
              <View
                className={`h-1.5 rounded-full ${index === step ? "w-5 bg-primary" : "w-1.5 bg-muted"}`}
                key={index}
              />
            ))}
          </View>

          <Text className="text-center" variant="body">
            {`${step + 1}. ${STEPS[step].title}`}
          </Text>
        </View>
      </Sheet>
    </>
  );
}
