import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Lottie } from "@/components/ui/lottie";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useKycLock } from "@/lib/kyc-lock";
import { useSiteConfig } from "@/hooks/use-site-config";
import { formatHostelDate } from "@hostel/calendar/bs";
import { trialTerms } from "@hostel/plans/catalog";

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
  const { config } = useSiteConfig();
  const { colors } = useAppTheme();
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

  const endsOn = formatHostelDate(kyc.trialEndsAt);

  return (
    // Buttons in the body, not `footer`: content sizing does not count a footer, so the sheet came up short.
    <Sheet fitContent onClose={() => setOpen(false)} open={open}>
      <View className="items-center">
        <Lottie loop={false} size={72} source={SUCCESS_ANIMATION} />
        <Text className="mt-2 text-sm font-semibold text-primary" variant={null}>
          Congratulations!
        </Text>
        <Text className="mt-1 text-center" variant="title">
          {kyc.trialDays}-day free trial
        </Text>
        <Text className="mt-1 text-center" variant="muted">
          Free until {endsOn} · No payment needed now
        </Text>
      </View>

      <View className="mt-4 gap-3 rounded-2xl bg-muted p-4">
        {trialTerms(config.plans, endsOn).map((line, i) => (
          <View className="flex-row items-center gap-3" key={line}>
            <View className="h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <Glyph color={colors.primary} name={TERM_GLYPHS[i] ?? "checkmark-circle"} size={18} />
            </View>
            <Text className="flex-1 text-sm leading-5 text-foreground" variant={null}>
              {line}
            </Text>
          </View>
        ))}
      </View>

      <View className="mt-5 gap-1">
        <Button
          label="Complete KYC"
          onPress={() => {
            setOpen(false);
            router.push("/manage/kyc");
          }}
        />
        <Button label="Start exploring" onPress={() => setOpen(false)} variant="ghost" />
      </View>
    </Sheet>
  );
}

/** One per `trialTerms` line, in its order: what you get, what happens after, KYC. */
const TERM_GLYPHS: GlyphName[] = ["sparkles", "calendar-clock", "shield-checkmark"];
