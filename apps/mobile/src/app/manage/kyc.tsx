import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect, type Href } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInRight } from "react-native-reanimated";

import { KYC_CACHE_KEY, KycRing } from "@/components/manage/kyc-card";
import { PayoutAccountFields } from "@/components/manage/payout-account-card";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Lottie } from "@/components/ui/lottie";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { addKycDocument, getHostelKyc, type HostelKyc } from "@/lib/admin-api";
import { addHostelPhoto, updateManagedHostel, updatePaymentProfile } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { FACILITY_OPTIONS } from "@/lib/hostel-registration";
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

const SUCCESS_ANIMATION = require("../../../assets/lottie/success.lottie");

type Meta = { hint: string; href: Href; icon: keyof typeof Ionicons.glyphMap; title: string };

/** One screen per step. `href` is the full editor, for changing a finished step. */
const STEPS: Record<string, Meta> = {
  documents: { hint: "Owner ID and PAN / VAT", href: "/manage/kyc", icon: "document-text", title: "Documents" },
  facilities: {
    hint: "Tap what you offer",
    href: "/manage/settings?panel=facilities",
    icon: "sparkles",
    title: "Facilities",
  },
  food: { hint: "Your weekly menu", href: "/manage/food", icon: "restaurant", title: "Weekly food" },
  location: {
    hint: "Drop the pin on your door",
    href: "/manage/settings?panel=location",
    icon: "location",
    title: "Map pin",
  },
  payments: {
    hint: "Where residents pay rent",
    href: "/manage/finance/payment-setup",
    icon: "qr-code",
    title: "Rent payments",
  },
  payout: { hint: "Where booking money lands", href: "/manage/finance/payouts", icon: "business", title: "Booking payout" },
  photos: { hint: "Outside and inside", href: "/manage/rooms", icon: "images", title: "Photos" },
  rules: { hint: "One rule per line", href: "/manage/settings?panel=rules", icon: "list", title: "House rules" },
};

const DOCUMENTS = [
  { label: "Owner ID", match: (type: string) => !/pan|vat/i.test(type), type: "Owner ID proof" },
  { label: "PAN / VAT", match: (type: string) => /pan|vat/i.test(type), type: "PAN / VAT document" },
] as const;

/**
 * Hostel KYC — a guided walk through what a team-registered hostel still has
 * to finish. One step per screen, saved in place where a small form covers it;
 * the heavy editors (menu, map) open and come back here.
 */
export default function KycScreen() {
  const kyc = useResource(getHostelKyc, { cacheKey: KYC_CACHE_KEY });
  const [index, setIndex] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const header = <AppBar accent centerTitle showBack straddle={56} title="Hostel KYC" />;

  // Back from the menu or map editor: re-read, so the tick lands.
  const mounted = useRef(false);
  const { refresh } = kyc;
  useFocusEffect(
    useCallback(() => {
      if (mounted.current) refresh();
      mounted.current = true;
    }, [refresh]),
  );

  if (kyc.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4" style={{ marginTop: -56 }}>
          <Skeleton height={88} radius={24} />
          <Skeleton height={320} radius={24} />
        </View>
      </Screen>
    );
  }

  if (kyc.error || !kyc.data) {
    return (
      <Screen header={header}>
        <ErrorState message={kyc.error ?? "Could not load hostel KYC."} onRetry={kyc.reload} />
      </Screen>
    );
  }

  const data = kyc.data;
  const steps = data.steps;
  const firstOpen = steps.findIndex((step) => !step.done);
  const current = index ?? Math.max(0, firstOpen);
  const showFinish = finished || (index === null && firstOpen === -1);
  const step = steps[current];
  const meta = STEPS[step.key];

  const reload = (next?: HostelKyc) => (next ? kyc.setData(() => next) : kyc.refresh());
  const advance = () => (current >= steps.length - 1 ? setFinished(true) : setIndex(current + 1));

  if (showFinish) {
    return (
      <Screen header={header} scroll>
        <Animated.View
          className="items-center gap-4 rounded-3xl border border-border bg-card p-6"
          entering={FadeInRight.duration(260)}
          style={{ marginTop: -56 }}
        >
          {data.percent >= 100 ? (
            <Lottie loop={false} size={180} source={SUCCESS_ANIMATION} />
          ) : (
            <KycRing percent={data.percent} size={140} />
          )}
          <Text className="text-center" variant="title">
            {data.percent >= 100 ? "KYC complete" : `${data.percent}% done`}
          </Text>
          <Text className="text-center text-muted-foreground" variant="caption">
            {data.percent >= 100 ? "Every feature is unlocked" : "Finish the rest anytime"}
          </Text>
          <View className="w-full gap-2 pt-2">
            {data.percent < 100 ? (
              <Button
                label="Continue"
                onPress={() => {
                  setFinished(false);
                  setIndex(Math.max(0, firstOpen));
                }}
              />
            ) : null}
            <Button label="Back to home" onPress={() => router.back()} variant={data.percent < 100 ? "ghost" : "primary"} />
          </View>
        </Animated.View>
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={kyc.refresh} refreshing={kyc.refreshing} scroll>
      <View className="gap-4" style={{ marginTop: -56 }}>
        <View className="flex-row items-center gap-4 rounded-3xl border border-border bg-card p-4">
          <KycRing percent={data.percent} size={56} />
          <View className="flex-1 gap-2">
            <Text className="font-semibold text-foreground">
              Step {current + 1} of {steps.length}
            </Text>
            <View className="flex-row gap-1.5">
              {steps.map((item, at) => (
                <Pressable
                  accessibilityLabel={`${STEPS[item.key]?.title ?? item.key}${item.done ? ", done" : ""}`}
                  className={`h-2 flex-1 rounded-full ${
                    item.done ? "bg-primary" : at === current ? "bg-primary/40" : "bg-muted"
                  }`}
                  hitSlop={8}
                  key={item.key}
                  onPress={() => setIndex(at)}
                />
              ))}
            </View>
          </View>
        </View>

        <Animated.View
          className="gap-5 rounded-3xl border border-border bg-card p-5"
          entering={FadeInRight.duration(260)}
          key={step.key}
        >
          <View className="items-center gap-3">
            <View className="h-16 w-16 items-center justify-center rounded-3xl bg-brand-soft">
              <StepIcon done={step.done} icon={meta.icon} />
            </View>
            <Text variant="title">{meta.title}</Text>
            <Text className="text-muted-foreground" variant="caption">
              {step.done ? "Done" : meta.hint}
            </Text>
          </View>

          <StepBody data={data} href={meta.href} onAdvance={advance} onReload={reload} stepKey={step.key} />
        </Animated.View>

        <View className="flex-row gap-3">
          {current > 0 ? (
            <View className="flex-1">
              <Button label="Back" onPress={() => setIndex(current - 1)} variant="ghost" />
            </View>
          ) : null}
          <View className="flex-1">
            <Button label={step.done ? "Next" : "Skip"} onPress={advance} variant={step.done ? "primary" : "ghost"} />
          </View>
        </View>
      </View>
    </Screen>
  );
}

function StepIcon({ done, icon }: { done: boolean; icon: Meta["icon"] }) {
  const { colors } = useAppTheme();

  return <Ionicons color={colors.primary} name={done ? "checkmark-circle" : icon} size={32} />;
}

function StepBody({
  data,
  href,
  onAdvance,
  onReload,
  stepKey,
}: {
  data: HostelKyc;
  href: Href;
  onAdvance: () => void;
  onReload: (next?: HostelKyc) => void;
  stepKey: string;
}) {
  const done = data.steps.find((step) => step.key === stepKey)?.done ?? false;
  const saved = () => {
    onReload();
    onAdvance();
  };

  if (stepKey === "photos") return <PhotosStep data={data} onReload={onReload} />;
  if (stepKey === "documents") return <DocumentsStep data={data} onReload={onReload} />;
  if (done) return <Button label="Change" onPress={() => router.push(href)} variant="outline" />;

  switch (stepKey) {
    case "payout":
      return <PayoutAccountFields onSaved={saved} value={null} />;
    case "payments":
      return <PaymentsStep onSaved={saved} />;
    case "rules":
      return <RulesStep initial={data.rules} onSaved={saved} />;
    case "facilities":
      return <FacilitiesStep initial={data.facilities} onSaved={saved} />;
    case "food":
      return <Button label="Set weekly menu" onPress={() => router.push(href)} />;
    case "location":
      return <Button label="Place the pin" onPress={() => router.push(href)} />;
    default:
      return <Button label="Open" onPress={() => router.push(href)} />;
  }
}

function PhotosStep({ data, onReload }: { data: HostelKyc; onReload: () => void }) {
  const [busy, setBusy] = useState("");

  async function add(kind: "EXTERIOR" | "INTERIOR") {
    const picked = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      mediaTypes: ["images"],
      quality: 0.8,
      selectionLimit: kind === "EXTERIOR" ? 3 : 10,
    });

    if (picked.canceled) return;

    setBusy(kind);

    try {
      for (const asset of picked.assets) {
        const fileAssetId = await uploadAsset(asset, { accessLevel: "PUBLIC", label: "Hostel photo" });
        await addHostelPhoto({ fileAssetId, kind });
      }
      toastSuccess("Photos added");
    } catch (error) {
      toastError("Upload failed", readApiError(error));
    } finally {
      setBusy("");
      onReload();
    }
  }

  return (
    <View className="gap-3">
      <Text className="text-center text-2xl font-bold text-foreground">
        {Math.min(data.photoCount, data.minPhotos)} / {data.minPhotos}
      </Text>
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button label="Outside" loading={busy === "EXTERIOR"} onPress={() => void add("EXTERIOR")} variant="outline" />
        </View>
        <View className="flex-1">
          <Button label="Inside" loading={busy === "INTERIOR"} onPress={() => void add("INTERIOR")} variant="outline" />
        </View>
      </View>
    </View>
  );
}

function DocumentsStep({ data, onReload }: { data: HostelKyc; onReload: (next?: HostelKyc) => void }) {
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState("");

  async function upload(type: string, label: string) {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    const asset = picked.canceled ? null : picked.assets[0];

    if (!asset) return;

    setBusy(type);

    try {
      const uploaded = await uploadPublicFile(asset, { label });

      if (!uploaded.claimToken || !uploaded.fileAssetId) throw new Error("Upload failed");

      onReload(
        await addKycDocument({
          claimToken: uploaded.claimToken,
          documentType: type,
          fileAssetId: uploaded.fileAssetId,
        }),
      );
      toastSuccess(`${label} added`);
    } catch (error) {
      toastError("Upload failed", readApiError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <View className="gap-3">
      {DOCUMENTS.map((doc) => {
        const uploaded = data.documents.some((row) => doc.match(row.type));

        return (
          <Pressable
            accessibilityRole="button"
            className="flex-row items-center gap-3 rounded-2xl border border-border p-4 active:opacity-70"
            disabled={Boolean(busy)}
            key={doc.type}
            onPress={() => void upload(doc.type, doc.label)}
          >
            <Ionicons color={colors.mutedForeground} name="id-card-outline" size={22} />
            <Text className="flex-1 font-semibold text-foreground">{doc.label}</Text>
            {busy === doc.type ? (
              <Text variant="caption">Uploading…</Text>
            ) : uploaded ? (
              <Ionicons color={colors.primary} name="checkmark-circle" size={24} />
            ) : (
              <Text className="font-semibold text-primary">Upload</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function PaymentsStep({ onSaved }: { onSaved: () => void }) {
  const [esewaId, setEsewaId] = useState("");
  const [khaltiId, setKhaltiId] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!esewaId.trim() && !khaltiId.trim()) {
      toastError("Rent payments", "Add an eSewa or Khalti ID.");
      return;
    }

    setSaving(true);

    try {
      await updatePaymentProfile({
        ...(esewaId.trim() ? { esewaId: esewaId.trim() } : {}),
        ...(khaltiId.trim() ? { khaltiId: khaltiId.trim() } : {}),
      });
      onSaved();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="gap-3">
      <Input keyboardType="phone-pad" label="eSewa ID" onChangeText={setEsewaId} placeholder="98XXXXXXXX" value={esewaId} />
      <Input keyboardType="phone-pad" label="Khalti ID" onChangeText={setKhaltiId} placeholder="98XXXXXXXX" value={khaltiId} />
      <Button label="Save" loading={saving} onPress={() => void save()} />
      <Button label="Bank or QR instead" onPress={() => router.push("/manage/finance/payment-setup")} variant="ghost" />
    </View>
  );
}

function RulesStep({ initial, onSaved }: { initial: string[]; onSaved: () => void }) {
  const [text, setText] = useState(initial.join("\n"));
  const [saving, setSaving] = useState(false);
  const rules = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  async function save() {
    setSaving(true);

    try {
      await updateManagedHostel({ rules });
      onSaved();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="gap-3">
      <Input
        multiline
        onChangeText={setText}
        placeholder={"Gate closes at 10 PM\nNo smoking indoors"}
        style={{ minHeight: 120, textAlignVertical: "top" }}
        value={text}
      />
      <Button disabled={rules.length === 0} label="Save" loading={saving} onPress={() => void save()} />
    </View>
  );
}

function FacilitiesStep({ initial, onSaved }: { initial: string[]; onSaved: () => void }) {
  const [picked, setPicked] = useState<string[]>(initial);
  const [saving, setSaving] = useState(false);
  const options = [...new Set([...FACILITY_OPTIONS, ...initial])].map((value) => ({ label: value, value }));

  async function save() {
    setSaving(true);

    try {
      await updateManagedHostel({ facilities: picked });
      onSaved();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="gap-3">
      <ChoiceChips
        onToggle={(value) =>
          setPicked((current) =>
            current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
          )
        }
        options={options}
        value={picked}
      />
      <Button disabled={picked.length === 0} label="Save" loading={saving} onPress={() => void save()} />
    </View>
  );
}
