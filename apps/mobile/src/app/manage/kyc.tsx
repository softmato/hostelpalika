import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInRight } from "react-native-reanimated";

import { PinPreview } from "@/components/hostel-pin-picker";
import { FoodWeekDays, MealSheet, useFoodWeek } from "@/components/manage/food-week";
import {
  BUILDING_SHOTS,
  PHOTO_LIMITS,
  PhotoStrip,
  targetKey,
  useHostelPhotoActions,
} from "@/components/manage/hostel-photos";
import { KYC_CACHE_KEY, KycRing } from "@/components/manage/kyc-card";
import {
  PaymentDestinations,
  PaymentQrCard,
  PaymentSheet,
  PaymentStatusCard,
  usePaymentSetup,
} from "@/components/manage/payment-setup";
import { PayoutAccountPanel } from "@/components/manage/payout-account-card";
import { StepFrame, StepSection, StepSkeleton } from "@/components/step-flow";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Lottie } from "@/components/ui/lottie";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState, PermissionCard } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { addKycDocument, getHostelKyc, type HostelKyc } from "@/lib/admin-api";
import {
  type GeocodeHit,
  geocodeHostelLocation,
  type ManagedHostel,
  updateManagedHostel,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer, viewerSourceFor } from "@/lib/asset-viewer";
import { FACILITY_OPTIONS } from "@/lib/hostel-registration";
import type { BadgeTone } from "@/lib/status";
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";

const SUCCESS_ANIMATION = require("../../../assets/lottie/success.lottie");

const STEPS: Record<string, { hint: string; title: string }> = {
  documents: { hint: "Owner ID and PAN / VAT", title: "Documents" },
  facilities: { hint: "Tap what you offer", title: "Facilities" },
  food: { hint: "Your weekly menu", title: "Weekly food" },
  location: { hint: "Drop the pin on your door", title: "Map pin" },
  payments: { hint: "Where residents pay rent", title: "Rent payments" },
  payout: { hint: "Where booking money lands", title: "Booking payout" },
  photos: { hint: "Outside, inside and your rooms", title: "Photos" },
  rules: { hint: "One rule per line", title: "House rules" },
};

const DOCUMENTS = [
  {
    caption: "Citizenship, passport or licence",
    label: "Owner ID",
    match: (type: string) => !/pan|vat/i.test(type),
    type: "Owner ID proof",
  },
  {
    caption: "The business registration",
    label: "PAN / VAT",
    match: (type: string) => /pan|vat/i.test(type),
    type: "PAN / VAT document",
  },
] as const;

const DOCUMENT_STATUS: Record<HostelKyc["documents"][number]["status"], { label: string; tone: BadgeTone }> = {
  APPROVED: { label: "Verified", tone: "success" },
  PENDING: { label: "In review", tone: "warning" },
  REJECTED: { label: "Sent back", tone: "danger" },
};

/**
 * Hostel KYC — a guided walk through what a team-registered hostel still has
 * to finish, one step per screen like registration and the ID card.
 *
 * Every step is filled in right here and shows what is already saved: the
 * photos, the documents, the payment details, the menu, the pin. Nothing opens
 * another screen — this is usually the owner's first time through, and a detour
 * into the full editor is where a first-timer gets lost. The full editors draw
 * the same pieces (`components/manage/*`), so the two never disagree.
 */
export default function KycScreen() {
  const kyc = useResource(getHostelKyc, { cacheKey: KYC_CACHE_KEY });
  const [index, setIndex] = useState<number | null>(null);
  const [forward, setForward] = useState(true);
  const [finished, setFinished] = useState(false);
  const { refresh } = kyc;
  const reload = useCallback(() => refresh(), [refresh]);

  if (kyc.loading) {
    return (
      <StepSkeleton
        subtitle={STEPS.photos.hint}
        title={STEPS.photos.title}
        total={Object.keys(STEPS).length}
      />
    );
  }

  if (kyc.error || !kyc.data) {
    return (
      <Screen header={<AppBar centerTitle showBack title="Hostel KYC" />}>
        <ErrorState message={kyc.error ?? "Could not load hostel KYC."} onRetry={kyc.reload} />
      </Screen>
    );
  }

  const data = kyc.data;
  const steps = data.steps;
  const firstOpen = steps.findIndex((step) => !step.done);
  const current = index ?? Math.max(0, firstOpen);
  const step = steps[current];
  const meta = STEPS[step.key] ?? { hint: "", title: step.key };
  const last = current >= steps.length - 1;

  const go = (next: number) => {
    setForward(next > current);
    setIndex(next);
  };

  if (finished || (index === null && firstOpen === -1)) {
    return (
      <Screen header={<AppBar centerTitle showBack title="Hostel KYC" />} scroll>
        <Animated.View
          className="items-center gap-4 rounded-3xl border border-border bg-card p-6"
          entering={FadeInRight.duration(260)}
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
            <Button
              label={data.percent < 100 ? "Continue" : "Review steps"}
              onPress={() => {
                setFinished(false);
                go(Math.max(0, firstOpen));
              }}
              variant={data.percent < 100 ? "primary" : "outline"}
            />
            <Button label="Back to home" onPress={() => router.back()} variant={data.percent < 100 ? "ghost" : "primary"} />
          </View>
        </Animated.View>
      </Screen>
    );
  }

  return (
    <StepFrame
      footer={
        <View className="gap-3">
          <StepDots current={current} onJump={go} percent={data.percent} steps={steps} />
          <Button
            label={last ? "Finish" : step.done ? "Next" : "Skip for now"}
            onPress={() => (last ? setFinished(true) : go(current + 1))}
            variant={step.done || last ? "primary" : "outline"}
          />
        </View>
      }
      forward={forward}
      onBack={() => (current > 0 ? go(current - 1) : router.back())}
      position={current + 1}
      stepKey={step.key}
      subtitle={step.done ? "Done. Change anything below." : meta.hint}
      title={meta.title}
      total={steps.length}
    >
      <StepBody data={data} onSaved={reload} stepKey={step.key} />
    </StepFrame>
  );
}

/** Where you are, what is done, and a tap to any step — beside the button that moves on. */
function StepDots({
  current,
  onJump,
  percent,
  steps,
}: {
  current: number;
  onJump: (index: number) => void;
  percent: number;
  steps: HostelKyc["steps"];
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 flex-row gap-1.5">
        {steps.map((item, at) => (
          <Pressable
            accessibilityLabel={`${STEPS[item.key]?.title ?? item.key}${item.done ? ", done" : ""}`}
            accessibilityRole="button"
            accessibilityState={{ selected: at === current }}
            className={`h-2 flex-1 rounded-full ${
              item.done ? "bg-primary" : at === current ? "bg-primary/40" : "bg-muted"
            }`}
            hitSlop={8}
            key={item.key}
            onPress={() => onJump(at)}
          />
        ))}
      </View>
      <Text variant="caption">{percent}% done</Text>
    </View>
  );
}

function StepBody({
  data,
  onSaved,
  stepKey,
}: {
  data: HostelKyc;
  onSaved: () => Promise<void> | void;
  stepKey: string;
}) {
  switch (stepKey) {
    case "photos":
      return <PhotosStep minPhotos={data.minPhotos} onSaved={onSaved} photoCount={data.photoCount} />;
    case "documents":
      return <DocumentsStep data={data} onSaved={onSaved} />;
    case "payout":
      return <PayoutAccountPanel onSaved={() => void onSaved()} />;
    case "payments":
      return <PaymentsStep onSaved={onSaved} />;
    case "food":
      return <FoodStep onSaved={onSaved} />;
    case "rules":
      return <RulesStep onSaved={onSaved} saved={data.rules} />;
    case "facilities":
      return <FacilitiesStep onSaved={onSaved} saved={data.facilities} />;
    case "location":
      return <LocationStep onSaved={onSaved} />;
    default:
      return null;
  }
}

/** The listing's photos, cached with Rooms — so what is added here is there too. */
function useManagedHostel() {
  const query = adminQuery.managedHostel();

  return useResource<ManagedHostel>(query.load, { cacheKey: query.key, topics: query.topics });
}

function PhotosStep({
  minPhotos,
  onSaved,
  photoCount,
}: {
  minPhotos: number;
  onSaved: () => Promise<void> | void;
  photoCount: number;
}) {
  const hostel = useManagedHostel();
  const { refresh } = hostel;
  const reread = useCallback(async () => {
    await Promise.all([refresh(), onSaved()]);
  }, [onSaved, refresh]);
  const { addPhotos, removePhoto, uploadingFor } = useHostelPhotoActions({
    hostelName: hostel.data?.name,
    refresh: reread,
  });

  if (hostel.loading) {
    return <SkeletonCard rows={3} />;
  }

  if (hostel.error || !hostel.data) {
    return <ErrorState message={hostel.error ?? "Could not load your photos."} onRetry={hostel.reload} />;
  }

  const photos = hostel.data.photos;
  const rooms = hostel.data.roomConfigurations;

  return (
    <View className="gap-4">
      {photoCount < minPhotos ? (
        <Meter
          label={`${photoCount} of ${minPhotos} photos needed`}
          percent={Math.round((photoCount / minPhotos) * 100)}
        />
      ) : null}

      {BUILDING_SHOTS.map((shot) => {
        const shots = photos.filter((photo) => photo.kind === shot.kind);

        return (
          <StepSection caption={shot.note} key={shot.kind} title={shot.name}>
            <PhotoStrip
              busy={uploadingFor === targetKey({ kind: shot.kind })}
              limit={PHOTO_LIMITS[shot.kind]}
              name={`${shot.name} of ${hostel.data?.name ?? "the hostel"}`}
              onAdd={() => void addPhotos({ kind: shot.kind }, shots.length)}
              onRemove={removePhoto}
              photos={shots}
            />
          </StepSection>
        );
      })}

      <StepSection caption="Each room type's own photos" title="Rooms">
        {rooms.length === 0 ? (
          <Text variant="caption">No room types on the listing yet.</Text>
        ) : (
          rooms.map((config) => {
            const shots = photos.filter(
              (photo) => photo.kind === "ROOM" && photo.roomType === config.roomType,
            );
            const target = { kind: "ROOM", roomType: config.roomType } as const;

            return (
              <View className="gap-2" key={config.roomType}>
                <Text variant="label">{config.roomType}</Text>
                <PhotoStrip
                  busy={uploadingFor === targetKey(target)}
                  limit={PHOTO_LIMITS.ROOM}
                  name={config.roomType}
                  onAdd={() => void addPhotos(target, shots.length)}
                  onRemove={removePhoto}
                  photos={shots}
                />
              </View>
            );
          })
        )}
      </StepSection>
    </View>
  );
}

function DocumentsStep({ data, onSaved }: { data: HostelKyc; onSaved: () => Promise<void> | void }) {
  const [busy, setBusy] = useState("");

  async function upload(type: string, label: string) {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    const asset = picked.canceled ? null : picked.assets[0];

    if (!asset) return;

    setBusy(type);

    try {
      const uploaded = await uploadPublicFile(asset, { label });

      if (!uploaded.claimToken || !uploaded.fileAssetId) throw new Error("Upload failed");

      await addKycDocument({
        claimToken: uploaded.claimToken,
        documentType: type,
        fileAssetId: uploaded.fileAssetId,
      });
      await onSaved();
      toastSuccess(`${label} added`);
    } catch (error) {
      toastError("Upload failed", readApiError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <View className="gap-4">
      {DOCUMENTS.map((doc) => {
        const rows = data.documents.filter((row) => doc.match(row.type));
        const viewable = rows.filter((row) => row.fileAssetId);

        return (
          <StepSection caption={doc.caption} key={doc.type} title={doc.label}>
            <View className="flex-row flex-wrap gap-3">
              {rows.map((row, at) => (
                <DocumentTile
                  key={`${row.type}-${at}`}
                  onOpen={() =>
                    openAssetViewer(
                      viewable.map((item) => ({
                        assetId: item.fileAssetId ?? undefined,
                        caption: DOCUMENT_STATUS[item.status]?.label,
                        mimeType: item.mimeType ?? undefined,
                        title: item.fileName ?? item.type,
                      })),
                      Math.max(0, viewable.indexOf(row)),
                    )
                  }
                  row={row}
                />
              ))}
              <AddDocumentTile
                busy={busy === doc.type}
                disabled={Boolean(busy)}
                label={rows.length > 0 ? "Add another" : `Upload ${doc.label}`}
                onPress={() => void upload(doc.type, doc.label)}
              />
            </View>
          </StepSection>
        );
      })}

      <Text variant="caption">Only you and the HostelPalika team can open these.</Text>
    </View>
  );
}

/** Half the row: the file itself, then where it stands. */
function DocumentTile({ onOpen, row }: { onOpen: () => void; row: HostelKyc["documents"][number] }) {
  const { colors } = useAppTheme();
  const token = useAppSelector((state) => state.auth.accessToken);
  const status = DOCUMENT_STATUS[row.status] ?? DOCUMENT_STATUS.PENDING;
  const image = !row.mimeType || row.mimeType.startsWith("image/");
  const source =
    row.fileAssetId && image
      ? viewerSourceFor({ assetId: row.fileAssetId }, { baseUrl: API_BASE_URL, token })
      : null;

  return (
    <View className="w-[48%] gap-1.5">
      <Pressable
        accessibilityLabel={`Open ${row.type}`}
        accessibilityRole="imagebutton"
        className="aspect-[1.4] items-center justify-center overflow-hidden rounded-2xl border border-border bg-muted active:opacity-70"
        disabled={!row.fileAssetId}
        onPress={onOpen}
      >
        {/* Under the image, so a file that will not load still reads as a document. */}
        <Ionicons color={colors.mutedForeground} name={image ? "image-outline" : "document-text-outline"} size={28} />
        {image ? null : (
          <Text className="mt-1" variant="caption">
            {row.mimeType?.split("/")[1]?.toUpperCase() ?? "FILE"}
          </Text>
        )}
        {source ? (
          <Image
            contentFit="cover"
            source={source}
            style={{ height: "100%", left: 0, position: "absolute", top: 0, width: "100%" }}
            transition={150}
          />
        ) : null}
      </Pressable>
      <View className="flex-row">
        <Badge label={status.label} tone={status.tone} />
      </View>
      {row.status === "REJECTED" && row.rejectionReason ? (
        <Text className="text-destructive" numberOfLines={3} variant="caption">
          {row.rejectionReason}
        </Text>
      ) : (
        <Text numberOfLines={1} variant="caption">
          {row.fileName ?? row.type}
        </Text>
      )}
    </View>
  );
}

function AddDocumentTile({
  busy,
  disabled,
  label,
  onPress,
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      className="aspect-[1.4] w-[48%] items-center justify-center gap-1 rounded-2xl border border-dashed border-border active:opacity-70"
      disabled={disabled}
      onPress={onPress}
    >
      <Ionicons color={colors.primary} name={busy ? "hourglass-outline" : "cloud-upload-outline"} size={24} />
      <Text className="text-center" variant="caption">
        {busy ? "Uploading" : label}
      </Text>
    </Pressable>
  );
}

function PaymentsStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const setup = usePaymentSetup({ onSaved: () => void onSaved() });

  if (setup.resource.loading) {
    return <SkeletonCard rows={3} />;
  }

  if (setup.resource.error || !setup.profile) {
    return (
      <ErrorState
        message={setup.resource.error ?? "Could not load your payment setup."}
        onRetry={setup.resource.reload}
      />
    );
  }

  return (
    <View className="gap-5">
      <PaymentStatusCard profile={setup.profile} />
      <PaymentQrCard setup={setup} />
      <PaymentDestinations setup={setup} />
      <PaymentSheet setup={setup} />
    </View>
  );
}

function FoodStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const week = useFoodWeek({ onSaved: () => void onSaved() });
  const { cells, dirty, filled, food, save, saving, setDraft } = week;

  if (food.loading) {
    return <SkeletonCard rows={3} />;
  }

  if (food.error) {
    return <ErrorState message={food.error} onRetry={food.reload} />;
  }

  if (food.data?.routine === null) {
    return <PermissionCard capability="food" feature="The weekly menu" />;
  }

  return (
    <View className="gap-4">
      <Meter label={`${filled} of ${cells} meals set this week`} percent={Math.round((filled / cells) * 100)} />
      <FoodWeekDays week={week} />
      {dirty ? (
        <View className="flex-row gap-2">
          <Button className="flex-1" label="Discard" onPress={() => setDraft(null)} variant="outline" />
          <Button className="flex-[2]" label="Save the week" loading={saving} onPress={() => void save()} />
        </View>
      ) : null}
      <MealSheet week={week} />
    </View>
  );
}

function RulesStep({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: string[] }) {
  const [editing, setEditing] = useState(saved.length === 0);
  const [text, setText] = useState(saved.join("\n"));
  const [saving, setSaving] = useState(false);
  const rules = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  async function save() {
    setSaving(true);

    try {
      await updateManagedHostel({ rules });
      await onSaved();
      toastSuccess("Rules saved");
      setEditing(false);
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <View className="gap-3">
        <Card padding="px-4 py-1">
          {saved.map((rule, at) => (
            <View
              className={`flex-row gap-3 py-3 ${at > 0 ? "border-t border-border" : ""}`}
              key={`${at}-${rule}`}
            >
              <Text className="w-5 text-muted-foreground">{at + 1}</Text>
              <Text className="flex-1 text-foreground">{rule}</Text>
            </View>
          ))}
        </Card>
        <Button
          label="Edit rules"
          onPress={() => {
            setText(saved.join("\n"));
            setEditing(true);
          }}
          variant="outline"
        />
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Input
        multiline
        onChangeText={setText}
        placeholder={"Gate closes at 10 PM\nNo smoking indoors"}
        style={{ minHeight: 140, textAlignVertical: "top" }}
        value={text}
      />
      <Button disabled={rules.length === 0} label="Save rules" loading={saving} onPress={() => void save()} />
      {saved.length > 0 ? <Button label="Cancel" onPress={() => setEditing(false)} variant="ghost" /> : null}
    </View>
  );
}

function FacilitiesStep({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: string[] }) {
  const [picked, setPicked] = useState<string[]>(saved);
  const [saving, setSaving] = useState(false);
  const options = [...new Set([...FACILITY_OPTIONS, ...saved])].map((value) => ({ label: value, value }));
  const changed = [...picked].sort().join("|") !== [...saved].sort().join("|");

  async function save() {
    setSaving(true);

    try {
      await updateManagedHostel({ facilities: picked });
      await onSaved();
      toastSuccess("Facilities saved");
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="gap-4">
      <Text variant="caption">
        {picked.length > 0 ? `${picked.length} selected` : "Nothing selected yet"}
      </Text>
      <ChoiceChips
        onToggle={(value) =>
          setPicked((current) =>
            current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
          )
        }
        options={options}
        value={picked}
      />
      <Button
        disabled={!changed || picked.length === 0}
        label={changed || saved.length === 0 ? "Save facilities" : "Saved"}
        loading={saving}
        onPress={() => void save()}
      />
    </View>
  );
}

/**
 * The pin, shown, then moved by search: a place name, a pasted Google Maps link
 * or a raw `lat,lng` — `profile/geocode` reads all three, and the pasted link is
 * the common case on a phone. A picked place is the owner's own pin (`MANUAL`),
 * which is what stops the server re-geocoding it back to the area's centre.
 */
function LocationStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const hostel = useManagedHostel();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState("");

  if (hostel.loading) {
    return <SkeletonCard rows={3} />;
  }

  if (hostel.error || !hostel.data) {
    return <ErrorState message={hostel.error ?? "Could not load your location."} onRetry={hostel.reload} />;
  }

  const location = hostel.data.location;
  const pin = location.lat != null && location.lng != null ? { lat: location.lat, lng: location.lng } : null;
  const placed = location.locationSource === "MANUAL";

  async function search() {
    if (query.trim().length < 2) return;

    setSearching(true);

    try {
      const results = await geocodeHostelLocation(query.trim());

      setHits(results);

      if (results.length === 0) {
        toastError("Nothing found", "Try the area name, or paste the Google Maps link.");
      }
    } catch (error) {
      toastError("Could not look that up", readApiError(error));
    } finally {
      setSearching(false);
    }
  }

  async function place(at: { lat: number; lng: number }, key: string, hit?: GeocodeHit) {
    setSaving(key);

    try {
      // The server merges `location` field by field: send the pin, and fill only
      // the address parts that are still blank from the picked place.
      const next = await updateManagedHostel({
        location: {
          address: location.address ? undefined : hit?.address,
          area: location.area ? undefined : hit?.area,
          city: location.city ? undefined : hit?.city,
          lat: at.lat,
          lng: at.lng,
          locationSource: "MANUAL",
          province: location.province ? undefined : hit?.province,
        },
      });

      hostel.setData(() => next);
      setHits([]);
      setQuery("");
      await onSaved();
      toastSuccess("Pin saved");
    } catch (error) {
      toastError("Could not save the pin", readApiError(error));
    } finally {
      setSaving("");
    }
  }

  return (
    <View className="gap-4">
      {pin ? (
        <View className="gap-2">
          <View className="h-48 overflow-hidden rounded-2xl border border-border">
            <PinPreview key={`${pin.lat},${pin.lng}`} pin={pin} />
          </View>
          <View className="flex-row items-center gap-2">
            <Badge label={placed ? "Placed by you" : "Guessed from the address"} tone={placed ? "success" : "warning"} />
            <Text className="flex-1" numberOfLines={1} variant="caption">
              {[location.area, location.city].filter(Boolean).join(", ")}
            </Text>
          </View>
          {placed ? null : (
            <Button
              label="The pin is on my door"
              loading={saving === "confirm"}
              onPress={() => void place(pin, "confirm")}
              variant="outline"
            />
          )}
        </View>
      ) : (
        <Card className="items-center gap-2 py-6">
          <Ionicons color={colors.mutedForeground} name="location-outline" size={28} />
          <Text variant="caption">No pin yet. Find your hostel below.</Text>
        </Card>
      )}

      <StepSection
        caption="A place name, or paste your Google Maps link"
        title={pin ? "Move the pin" : "Find your hostel"}
      >
        <Input
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          onSubmitEditing={() => void search()}
          placeholder="Baluwatar, Kathmandu"
          returnKeyType="search"
          value={query}
        />
        <Button
          disabled={query.trim().length < 2}
          label="Search"
          loading={searching}
          onPress={() => void search()}
          variant="outline"
        />
        {hits.map((hit) => {
          const key = `${hit.lat},${hit.lng}`;

          return (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-3 rounded-xl border border-border p-3 active:opacity-70"
              disabled={Boolean(saving)}
              key={key}
              onPress={() => void place(hit, key, hit)}
            >
              <View className="flex-1">
                <Text numberOfLines={2}>{hit.displayName ?? key}</Text>
                <Text variant="caption">{`${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}`}</Text>
              </View>
              <Text className="text-primary" variant="label">
                {saving === key ? "Saving" : "Pin here"}
              </Text>
            </Pressable>
          );
        })}
      </StepSection>
    </View>
  );
}
