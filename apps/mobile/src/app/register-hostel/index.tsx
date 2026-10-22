import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { BackHandler, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeInRight, ReduceMotion } from "react-native-reanimated";

import { IntroHero, IntroSteps } from "@/components/intro-hero";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Glyph } from "@/components/ui/glyph";
import { Meter } from "@/components/ui/meter";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { adminQuery, prefetchAdminPortal } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { revalidateSession } from "@/lib/auth-session";
import { fetchQuery } from "@/lib/query-cache";
import { quickRegisterHostel } from "@/lib/registration-api";
import { toastError } from "@/lib/toast";

/**
 * Register your hostel — three fields (docs/QUICK_SIGNUP_KYC_TRIAL.md), asked
 * the way WhatsApp asks on first launch: one question per screen, a green
 * title, one short line, a centred underlined field and Next riding on the
 * keyboard. A first glimpse (icon, three pictured steps) comes before it.
 *
 * Owner name, phone and hostel name are what it takes to open a hostel portal
 * on this account. Address, rooms, photos and documents are the hostel's KYC,
 * done from inside the portal.
 *
 * On success the account is a hostel admin. Instead of dropping the owner on a
 * portal of skeletons, "Setting up your portal" walks the real work — create,
 * rotate the token to the admin role, warm Home's reads (and the rest of the
 * portal behind them) — so Home paints from cache, where the congratulations
 * sheet is waiting.
 */

type Field = "ownerName" | "phone" | "hostelName";

const QUESTIONS: {
  field: Field;
  line: string;
  title: string;
}[] = [
  { field: "ownerName", line: "The hostel owner's name.", title: "Your name" },
  { field: "phone", line: "So our team can reach you.", title: "Your phone number" },
  { field: "hostelName", line: "As residents know it.", title: "Hostel name" },
];

const SETUP = ["Creating your hostel", "Making you the owner", "Loading your portal", "Opening your portal"];

const ENTER = FadeInRight.duration(260).reduceMotion(ReduceMotion.System);

export default function RegisterHostelScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const params = useLocalSearchParams<{ ref?: string }>();
  // 0 is the first glimpse; 1–3 are the questions.
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<Field, string>>({
    hostelName: "",
    ownerName: account?.name ?? "",
    phone: account?.phone ?? "",
  });
  const [referralCode, setReferralCode] = useState((params.ref ?? "").toUpperCase());
  const [withCode, setWithCode] = useState(Boolean(params.ref));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Index into `SETUP` while the portal is being set up; null on the form. */
  const [setup, setSetup] = useState<number | null>(null);

  const question = step > 0 ? QUESTIONS[step - 1] : null;

  const back = useCallback(() => {
    if (step === 0) return false;
    setError(null);
    setStep(step - 1);
    return true;
  }, [step]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", back);
    return () => subscription.remove();
  }, [back]);

  const submit = async () => {
    setSaving(true);
    setSetup(0);

    try {
      await quickRegisterHostel({
        hostelName: values.hostelName.trim(),
        ownerName: values.ownerName.trim(),
        phone: values.phone.trim(),
        ...(withCode && referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
      });

      setSetup(1);
      // Rotates the token onto the admin role before any portal read.
      await revalidateSession();

      setSetup(2);
      prefetchAdminPortal();
      // Home's own reads; prefetchAdminPortal above already started them, so these join it.
      await Promise.allSettled(
        [adminQuery.overview(), adminQuery.subscription(), adminQuery.alerts()].map((query) =>
          fetchQuery(query.key, query.load as () => Promise<unknown>, query.topics),
        ),
      );

      setSetup(3);
      // Let the bar finish its fill before the screen changes.
      await new Promise((resolve) => setTimeout(resolve, 450));
      router.replace("/(admin)");
    } catch (failure) {
      setSetup(null);
      toastError("Not registered", readApiError(failure));
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (!question) {
      setStep(1);
      return;
    }

    const value = values[question.field].trim();
    const problem =
      question.field === "phone"
        ? value.replace(/\D/g, "").length < 7
          ? "Enter a phone number."
          : null
        : value.length < 2
          ? question.field === "ownerName"
            ? "Enter the owner's name."
            : "Enter your hostel's name."
          : null;

    setError(problem);
    if (problem) return;

    if (step < QUESTIONS.length) {
      setStep(step + 1);
    } else {
      void submit();
    }
  };

  if (!account) {
    return (
      <Screen
        footer={
          <Button
            label="Sign in to start"
            onPress={() => router.push({ params: { next: "/register-hostel" }, pathname: "/(auth)/login" })}
          />
        }
        header={<AppBar showBack title="" />}
        scroll
      >
        <View className="pt-4">
          <IntroHero
            icon="business"
            line="Your portal opens on the account you sign in with."
            orbit={["bed", "wifi", "people"]}
            title="Open your hostel portal"
          />
        </View>
      </Screen>
    );
  }

  if (setup !== null) {
    return <PortalSetup active={setup} hostelName={values.hostelName.trim()} />;
  }

  const last = step === QUESTIONS.length;

  return (
    <Screen
      footer={
        <Button
          label={step === 0 ? "Get started" : last ? "Open my portal" : "Next"}
          loading={saving}
          onPress={next}
        />
      }
      header={<AppBar onBack={step > 0 ? () => back() : undefined} showBack title="" />}
      scroll
    >
      {question ? (
        <View className="gap-8 pb-6 pt-2">
          <Progress step={step} />

          <Animated.View className="gap-8" entering={ENTER} key={question.field}>
            <View className="items-center gap-2 px-4">
              <Text className="text-center text-primary" variant="title">
                {question.title}
              </Text>
              <Text className="text-center" variant="muted">
                {question.line}
              </Text>
            </View>

            <View className="px-6">
              <Input
                autoCapitalize={question.field === "phone" ? "none" : "words"}
                autoFocus
                error={error}
                keyboardType={question.field === "phone" ? "phone-pad" : "default"}
                onChangeText={(text) => {
                  setValues((current) => ({ ...current, [question.field]: text }));
                  if (error) setError(null);
                }}
                onSubmitEditing={next}
                returnKeyType={last ? "done" : "next"}
                style={{ fontSize: 20, textAlign: "center" }}
                textContentType={
                  question.field === "ownerName"
                    ? "name"
                    : question.field === "phone"
                      ? "telephoneNumber"
                      : "organizationName"
                }
                value={values[question.field]}
                variant="line"
              />
            </View>

            {last ? (
              withCode ? (
                <Animated.View className="px-6" entering={FadeIn.duration(200)}>
                  <Input
                    autoCapitalize="characters"
                    autoCorrect={false}
                    hint="Adds free time once your hostel is live."
                    label="Referral code"
                    onChangeText={(text) => setReferralCode(text.toUpperCase())}
                    style={{ textAlign: "center" }}
                    value={referralCode}
                    variant="line"
                  />
                </Animated.View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  className="self-center active:opacity-60"
                  hitSlop={8}
                  onPress={() => setWithCode(true)}
                >
                  <Text className="text-primary" variant="label">
                    I have a referral code
                  </Text>
                </Pressable>
              )
            ) : null}
          </Animated.View>
        </View>
      ) : (
        <View className="gap-10 pb-6 pt-4">
          <IntroHero
            icon="business"
            line="Three details. Under a minute."
            orbit={["bed", "wifi", "people"]}
            title="Open your hostel portal"
          />
          <IntroSteps
            steps={QUESTIONS.map((item, index) => ({
              icon: (["person", "call", "home"] as const)[index],
              label: item.title.replace("Your ", "").replace(/^./, (c) => c.toUpperCase()),
            }))}
          />
        </View>
      )}
    </Screen>
  );
}

/** Three short bars, the current one and those before it in green. */
function Progress({ step }: { step: number }) {
  return (
    <View className="flex-row justify-center gap-1.5">
      {QUESTIONS.map((item, index) => (
        <View
          className={`h-1 rounded-full ${index < step ? "bg-primary" : "bg-muted"}`}
          key={item.field}
          style={{ width: index === step - 1 ? 28 : 14 }}
        />
      ))}
    </View>
  );
}

/** "Setting up your portal": one bar and the four real steps behind it. */
function PortalSetup({ active, hostelName }: { active: number; hostelName: string }) {
  const { colors } = useAppTheme();

  return (
    <Screen>
      <Animated.View className="flex-1 justify-center gap-8 px-6" entering={FadeIn.duration(200)}>
        <View className="items-center gap-2">
          <Text className="text-center text-primary" variant="title">
            Setting up your portal
          </Text>
          <Text className="text-center" variant="muted">
            {hostelName}
          </Text>
        </View>

        <Meter animated label={null} percent={Math.round(((active + 1) / SETUP.length) * 100)} reading="share" />

        <View className="gap-4">
          {SETUP.map((label, index) => (
            <View className="flex-row items-center gap-3" key={label}>
              {index < active ? (
                <Glyph color={colors.success} name="checkmark-circle" size={22} />
              ) : (
                <View
                  className={`h-[22px] w-[22px] items-center justify-center rounded-full border-2 ${
                    index === active ? "border-primary" : "border-muted"
                  }`}
                >
                  {index === active ? <View className="h-2 w-2 rounded-full bg-primary" /> : null}
                </View>
              )}
              <Text variant={index === active ? "label" : "muted"}>{label}</Text>
            </View>
          ))}
        </View>
      </Animated.View>
    </Screen>
  );
}
