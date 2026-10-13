import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Lottie } from "@/components/ui/lottie";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useKycLock } from "@/lib/kyc-lock";

const SUCCESS_ANIMATION = require("../../assets/lottie/success.lottie");

/**
 * "Congratulations — you got N days" the first time a quick sign-up's portal
 * opens on this phone, and never again (docs/QUICK_SIGNUP_KYC_TRIAL.md). The
 * same news also arrived as a push; this is the version on screen.
 *
 * Marked seen the moment it shows, so a crash or a back-swipe does not bring
 * it back on the next open.
 */
export function TrialWelcome() {
  const { kyc } = useKycLock();
  const [open, setOpen] = useState(false);
  const key = kyc ? `hostelpalika.trialWelcome.${kyc.hostelId}` : null;

  useEffect(() => {
    if (!key || !kyc?.trialDays) return;

    let live = true;

    void AsyncStorage.getItem(key)
      .then((seen) => {
        if (!live || seen) return;
        setOpen(true);
        return AsyncStorage.setItem(key, "1");
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [key, kyc?.trialDays]);

  if (!kyc?.trialDays) return null;

  return (
    <Sheet
      footer={
        <View className="gap-2">
          <Button
            label="Complete KYC"
            onPress={() => {
              setOpen(false);
              router.push("/manage/kyc");
            }}
          />
          <Button label="Start exploring" onPress={() => setOpen(false)} variant="ghost" />
        </View>
      }
      onClose={() => setOpen(false)}
      open={open}
      title="Congratulations!"
    >
      <View className="items-center gap-3 pb-2">
        <Lottie loop={false} size={130} source={SUCCESS_ANIMATION} />
        <Text className="text-center" variant="title">
          You got {kyc.trialDays} days free
        </Text>
        <Text className="text-center" variant="muted">
          {kyc.hostelName || "Your hostel"} has its own portal now. Enjoy and explore. Complete your KYC
          to open every feature and list your hostel.
        </Text>
      </View>
    </Sheet>
  );
}
