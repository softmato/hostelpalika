import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lottie } from "@/components/ui/lottie";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { readApiError } from "@/lib/api-contract";
import { adoptRoleChange } from "@/lib/auth-session";
import { quickRegisterHostel } from "@/lib/registration-api";
import { toastError } from "@/lib/toast";

/**
 * Register your hostel — one screen, three fields (docs/QUICK_SIGNUP_KYC_TRIAL.md).
 *
 * Owner name, phone and hostel name are what it takes to open a hostel portal
 * on this account, so that is all this asks. Everything the old five-step form
 * collected — address, rooms and rent, photos, documents — is the hostel's KYC
 * now, done from inside the portal, where the owner can explore while our team
 * checks it.
 *
 * On success the account is a hostel admin: `adoptRoleChange` rotates the
 * token and puts the phone on the admin home, where the congratulations sheet
 * is waiting.
 */
export default function RegisterHostelScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const params = useLocalSearchParams<{ ref?: string }>();
  const [ownerName, setOwnerName] = useState(account?.name ?? "");
  const [phone, setPhone] = useState(account?.phone ?? "");
  const [hostelName, setHostelName] = useState("");
  const [referralCode, setReferralCode] = useState((params.ref ?? "").toUpperCase());
  const [withCode, setWithCode] = useState(Boolean(params.ref));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const next: Record<string, string> = {};

    if (ownerName.trim().length < 2) next.ownerName = "Enter the owner's name.";
    if (phone.replace(/\D/g, "").length < 7) next.phone = "Enter a phone number.";
    if (hostelName.trim().length < 2) next.hostelName = "Enter your hostel's name.";

    setErrors(next);

    if (Object.keys(next).length > 0) return;

    setSaving(true);

    try {
      await quickRegisterHostel({
        hostelName: hostelName.trim(),
        ownerName: ownerName.trim(),
        phone: phone.trim(),
        ...(withCode && referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
      });

      if (!(await adoptRoleChange())) {
        router.replace("/(admin)");
      }
    } catch (error) {
      toastError("Not registered", readApiError(error));
    } finally {
      setSaving(false);
    }
  };

  if (!account) {
    return (
      <Screen header={<AppBar showBack title="Register your hostel" />}>
        <View className="flex-1 items-center justify-center gap-4 py-10">
          <Text className="text-center" variant="title">
            Sign in first
          </Text>
          <Text className="text-center" variant="muted">
            Your hostel portal opens on the account you sign in with.
          </Text>
          <Button
            label="Sign in"
            onPress={() =>
              router.push({ params: { next: "/register-hostel" }, pathname: "/(auth)/login" })
            }
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={<Button label="Open my hostel portal" loading={saving} onPress={() => void submit()} />}
      header={<AppBar showBack title="Register your hostel" />}
      scroll
    >
      <View className="gap-5 pb-6">
        <View className="items-center gap-2">
          <Lottie loop={false} size={120} source={require("../../../assets/lottie/hostel-register.lottie")} />
          <Text className="text-center" variant="title">
            Open your hostel portal
          </Text>
          <Text className="text-center" variant="muted">
            Three details now. Photos, rooms and documents go in KYC, any time after.
          </Text>
        </View>

        <Input
          autoCapitalize="words"
          error={errors.ownerName}
          label="Owner's name"
          onChangeText={setOwnerName}
          textContentType="name"
          value={ownerName}
        />
        <Input
          error={errors.phone}
          keyboardType="phone-pad"
          label="Phone number"
          onChangeText={setPhone}
          textContentType="telephoneNumber"
          value={phone}
        />
        <Input
          autoCapitalize="words"
          error={errors.hostelName}
          label="Hostel name"
          onChangeText={setHostelName}
          value={hostelName}
        />

        {withCode ? (
          <Input
            autoCapitalize="characters"
            autoCorrect={false}
            hint="From another hostel or one of our partners. Adds free time once your hostel is live."
            label="Referral code (optional)"
            onChangeText={(value) => setReferralCode(value.toUpperCase())}
            value={referralCode}
          />
        ) : (
          <Button label="I have a referral code" onPress={() => setWithCode(true)} variant="ghost" />
        )}
      </View>
    </Screen>
  );
}
