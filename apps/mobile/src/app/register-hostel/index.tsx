import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { BackHandler, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeInRight, ReduceMotion } from "react-native-reanimated";

import { IntroHero, IntroSteps } from "@/components/intro-hero";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { readApiError } from "@/lib/api-contract";
import { adoptRoleChange } from "@/lib/auth-session";
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
 * On success the account is a hostel admin: `adoptRoleChange` rotates the
 * token and puts the phone on the admin home, where the congratulations sheet
 * is waiting.
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

    try {
      await quickRegisterHostel({
        hostelName: values.hostelName.trim(),
        ownerName: values.ownerName.trim(),
        phone: values.phone.trim(),
        ...(withCode && referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
      });

      if (!(await adoptRoleChange())) {
        router.replace("/(admin)");
      }
    } catch (failure) {
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
