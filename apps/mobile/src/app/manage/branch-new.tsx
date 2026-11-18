import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion, ZoomIn } from "react-native-reanimated";

import { openInBranch } from "@/components/hostel-switcher";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { requestBranch } from "@/lib/admin-api";
import { rotateAccessToken } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { invalidateQuery } from "@/lib/query-cache";
import { toastError } from "@/lib/toast";

/**
 * A new branch is two answers, like the quick sign-up: its name and the label
 * that tells it apart. Location, rooms, documents and payout are the branch's
 * own KYC, done from inside the branch — which is where "Complete KYC" lands.
 */
export default function NewBranchScreen() {
  const { colors } = useAppTheme();
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [errors, setErrors] = useState<{ label?: string; name?: string }>({});
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ id: string; label: string } | null>(null);

  async function submit() {
    const next = {
      label: label.trim() ? undefined : "Add a short label, like Block B.",
      name: name.trim().length >= 2 ? undefined : "Enter the branch's name.",
    };
    setErrors(next);
    if (next.label || next.name || saving) return;

    setSaving(true);
    try {
      const { branch } = await requestBranch({ branchLabel: label.trim(), name: name.trim() });
      invalidateQuery("admin:branch-list");
      invalidateQuery("account:admin:branches");
      setCreated({ id: branch.id, label: label.trim() });
    } catch (error) {
      toastError("Could not add the branch", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function openKyc() {
    if (!created) return;
    setSaving(true);
    // The branch joined this account's hostels just now; the token learns it here.
    await rotateAccessToken().catch(() => null);
    setSaving(false);
    router.back();
    openInBranch({ id: created.id, isBranch: true }, "/manage/kyc");
  }

  if (created) {
    return (
      <Screen
        footer={
          <View className="gap-2">
            <Button label="Complete KYC" loading={saving} onPress={() => void openKyc()} />
            <Button label="Later" onPress={() => router.back()} variant="ghost" />
          </View>
        }
      >
        <View className="flex-1 items-center justify-center gap-4 px-4" style={{ minHeight: 480 }}>
          <Animated.View
            className="h-20 w-20 items-center justify-center rounded-full bg-primary"
            entering={ZoomIn.springify().reduceMotion(ReduceMotion.System)}
          >
            <Glyph color={colors.primaryForeground} name="checkmark" size={40} />
          </Animated.View>
          <Animated.View className="items-center gap-2" entering={FadeIn.delay(120).reduceMotion(ReduceMotion.System)}>
            <Text className="text-center" variant="title">
              {created.label} added
            </Text>
            <Text className="text-center" variant="muted">
              Complete its KYC to open every feature.
            </Text>
          </Animated.View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={<Button label="Add branch" loading={saving} onPress={() => void submit()} />}
      header={<AppBar showBack title="New branch" />}
      scroll
    >
      <View className="gap-4 px-5 pt-4">
        <Input
          autoCapitalize="words"
          autoFocus
          error={errors.name}
          label="Branch name"
          maxLength={160}
          onChangeText={(text) => {
            setName(text);
            if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
          }}
          returnKeyType="next"
          textContentType="organizationName"
          value={name}
        />
        <Input
          autoCapitalize="words"
          error={errors.label}
          hint="How you tell it apart, like Block B or Thamel branch."
          label="Branch label"
          maxLength={40}
          onChangeText={(text) => {
            setLabel(text);
            if (errors.label) setErrors((current) => ({ ...current, label: undefined }));
          }}
          onSubmitEditing={() => void submit()}
          returnKeyType="done"
          value={label}
        />
      </View>
    </Screen>
  );
}
