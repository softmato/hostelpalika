import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { usePreventRemove } from "expo-router/react-navigation";
import { router, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, FileUp, List, MapPin } from "lucide-react-native";
import { BackHandler, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeInLeft, FadeInRight, ReduceMotion, useReducedMotion } from "react-native-reanimated";

import { PinPickerModal, PinPreview } from "@/components/hostel-pin-picker";
import { FoodWeekEditor } from "@/components/manage/food-week-editor";
import { KycDraftContext, useKycDraft, type KycDraft } from "@/components/manage/kyc-draft";
import { KycPayments } from "@/components/manage/kyc-payments";
import { Sheet } from "@/components/ui/sheet";
import { useFoodWeek } from "@/components/manage/food-week";
import {
  BUILDING_SHOTS,
  PHOTO_LIMITS,
  PhotoStrip,
  targetKey,
  useHostelPhotoActions,
} from "@/components/manage/hostel-photos";
import { KYC_CACHE_KEY, KycRing } from "@/components/manage/kyc-card";
import { PayoutAccountPanel } from "@/components/manage/payout-account-card";
import { isPdfReceipt, PdfPreview, readRemotePdf } from "@/components/receipt-preview";
import { StepSection, StepSkeleton } from "@/components/step-flow";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Lottie } from "@/components/ui/lottie";
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
import { pickDocument, type PickedDocument } from "@/lib/document-picker";
import { FACILITY_OPTIONS } from "@/lib/hostel-registration";
import type { BadgeTone } from "@/lib/status";
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";
import { useUnloadGuard } from "@/lib/unload-guard";

const SUCCESS_ANIMATION = require("../../../assets/lottie/success.lottie");

const STEPS: Record<string, { hint: string; icon: keyof typeof Ionicons.glyphMap; short: string; title: string }> = {
  documents: { hint: "Add your ID", icon: "document-text-outline", short: "Documents", title: "Documents" },
  facilities: { hint: "Tap what you have", icon: "bed-outline", short: "Facilities", title: "Facilities" },
  food: { hint: "", icon: "restaurant-outline", short: "Food", title: "Food menu" },
  location: { hint: "Is this your door?", icon: "location-outline", short: "Map", title: "Map pin" },
  payments: { hint: "", icon: "home-outline", short: "Rent", title: "Rent payments" },
  payout: { hint: "Where we send your money", icon: "card-outline", short: "Booking money", title: "Booking money" },
  photos: { hint: "", icon: "image-outline", short: "Photos", title: "Photos" },
  rules: { hint: "", icon: "reader-outline", short: "Rules", title: "House rules" },
};

const DOCUMENTS = [
  {
    caption: "Citizenship, passport or licence",
    label: "Your ID",
    match: (type: string) => !/pan|vat/i.test(type),
    type: "Owner ID proof",
  },
  {
    caption: "",
    label: "PAN / VAT",
    match: (type: string) => /pan|vat/i.test(type),
    type: "PAN / VAT document",
  },
] as const;

const DOCUMENT_STATUS: Record<HostelKyc["documents"][number]["status"], { label: string; tone: BadgeTone }> = {
  APPROVED: { label: "Verified", tone: "success" },
  PENDING: { label: "In review", tone: "warning" },
  REJECTED: { label: "Add again", tone: "danger" },
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
  return <KycFlow resource={kyc} />;
}

function KycFlow({ resource: kyc }: { resource: ReturnType<typeof useResource<HostelKyc>> }) {
  const navigation = useNavigation();
  const { colors } = useAppTheme();
  const reduced = useReducedMotion();
  const [index, setIndex] = useState<number | null>(null);
  const [forward, setForward] = useState(true);
  const [finished, setFinished] = useState(false);
  const [overview, setOverview] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const [allowLeave, setAllowLeave] = useState(false);
  const leaving = useRef<(() => void) | null>(null);
  const lock = useRef(false);
  const entries = useRef(new Map<string, KycDraft>());
  const [status, setStatus] = useState({ dirty: false, busy: false });
  const register = useCallback((id: string, draft: KycDraft | null) => {
    if (draft) entries.current.set(id, draft);
    else entries.current.delete(id);
    const values = [...entries.current.values()];
    const dirty = values.some(value => value.dirty);
    const busy = values.some(value => value.busy);
    setStatus(previous => previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy });
  }, []);
  const { refresh } = kyc;
  const reload = useCallback(() => refresh(), [refresh]);
  const blocked = saving || status.busy;
  // Leaving waits a render for `allowLeave`: a discarded or just-saved draft
  // still reads dirty until its step unmounts, and would be stopped again.
  const leave = (action: () => void) => { leaving.current = action; setAllowLeave(true); };
  usePreventRemove(!allowLeave && (status.dirty || blocked), ({ data }) => {
    if (lock.current || status.busy) { toastError("Please wait", "Your changes are being saved."); return; }
    setPending(() => () => leave(() => navigation.dispatch(data.action)));
  });
  useEffect(() => {
    if (allowLeave) leaving.current?.();
  }, [allowLeave]);
  useUnloadGuard(status.dirty || blocked);

  const steps = kyc.data?.steps ?? [];
  const firstOpen = steps.findIndex(step => !step.done);
  const current = Math.max(0, Math.min(index ?? firstOpen, steps.length - 1));
  const finish = finished || (index === null && firstOpen === -1);
  const go = (next: number) => { setForward(next > current); setIndex(next); setFinished(false); };
  const move = (action: () => void) => {
    if (lock.current || status.busy) return;
    if (status.dirty) setPending(() => action);
    else action();
  };
  // Android's back walks the steps like the header arrow; on the first step or
  // the finish screen it leaves, and `usePreventRemove` guards that exit.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (overview) { setOverview(false); return true; }
      if (pending) { if (!saving) setPending(null); return true; }
      if (!steps.length || finish || current === 0) return false;
      move(() => go(current - 1));
      return true;
    });
    return () => subscription.remove();
  });

  if (kyc.loading) return <StepSkeleton subtitle="" title="Hostel setup" total={8} />;
  if (kyc.error || !kyc.data || !steps.length) return <Screen header={<AppBar showBack title="Hostel setup" />}><ErrorState message={kyc.error ?? "Could not load setup."} onRetry={kyc.reload} /></Screen>;
  const data = kyc.data;
  if (index === null && firstOpen >= 0) setIndex(current);
  const step = steps[current];
  const meta = STEPS[step.key];
  const last = current === steps.length - 1;
  const done = steps.filter(item => item.done).length;
  const saveAndGo = async (action: () => void) => {
    if (lock.current || status.busy) return;
    // Pin the initial step before its completion changes the first-open index.
    setIndex(current);
    lock.current = true;
    setSaving(true);
    try {
      for (const draft of [...entries.current.values()]) {
        if (draft.dirty && !(await draft.save())) return;
      }
      await reload();
      setPending(null);
      action();
    } catch (error) { toastError("Not saved", readApiError(error)); }
    finally { lock.current = false; setSaving(false); }
  };
  const next = () => last ? setFinished(true) : go(current + 1);

  return <KycDraftContext.Provider value={register}>
    <Screen scroll header={<AppBar title="Hostel setup" showBack onBack={() => move(() => finish || current === 0 ? leave(() => router.back()) : go(current - 1))} actions={<Button icon={List} label="All steps" size="sm" variant="secondary" disabled={blocked} onPress={() => setOverview(true)} />} />}
      footer={finish ? <View className="gap-1"><Button label={data.percent >= 100 ? "Go home" : "Continue"} onPress={() => data.percent >= 100 ? router.back() : go(Math.max(0, firstOpen))} /><Button label={data.percent >= 100 ? "View steps" : "Go home"} variant="ghost" onPress={() => data.percent >= 100 ? setOverview(true) : router.back()} /></View> : <View className="gap-1"><Button disabled={blocked} label={saving ? "Saving…" : status.busy ? "Please wait…" : status.dirty ? last ? "Save & finish" : "Save & next" : last ? "Finish" : "Next"} onPress={() => void saveAndGo(next)} /><Button label="Skip" variant="ghost" disabled={blocked} onPress={() => move(next)} /></View>}>
      {finish ? <Animated.View entering={FadeIn.duration(220).reduceMotion(ReduceMotion.System)} className="items-center gap-5 py-6">
        {data.percent >= 100 ? <View className="items-center">{!reduced && finished ? <Lottie loop={false} size={140} source={SUCCESS_ANIMATION} /> : <Ionicons name="checkmark-circle-outline" color={colors.primary} size={112} />}<Text variant="muted">{done} of {steps.length}</Text></View> : <KycRing percent={data.percent} size={120} />}
        <Text variant="title">{data.percent >= 100 ? "All done!" : `${data.percent}% done`}</Text>
        <Text variant="muted">{data.percent >= 100 ? "Your hostel is ready" : "Finish the rest any time"}</Text>
        <View className="w-full flex-row flex-wrap justify-between gap-y-3">{steps.map((item, at) => <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`${STEPS[item.key]?.title}, ${item.done ? "done" : "to do"}`} onPress={() => go(at)} className={`min-h-16 w-[48.5%] flex-row items-center gap-2 rounded-2xl p-2.5 active:opacity-70 ${item.done ? "bg-brand-soft" : "border border-border"}`}>
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-background"><Ionicons name={STEPS[item.key]?.icon ?? "ellipse-outline"} color={colors.primary} size={20} /></View>
          <Text className="flex-1" numberOfLines={2} variant="label">{STEPS[item.key]?.short}</Text>
          <Ionicons name={item.done ? "checkmark-circle" : "ellipse-outline"} color={item.done ? colors.primary : colors.mutedForeground} size={22} />
        </Pressable>)}</View>
        {data.percent >= 100 ? <View className="flex-row items-center gap-2"><Ionicons name="time-outline" color={colors.warning} size={18} /><Text variant="muted">Some checks may take time</Text></View> : null}
      </Animated.View> : <View className="gap-4 pb-4 pt-1">
        <View accessibilityLabel={`Step ${current + 1} of ${steps.length}, ${done} done`} className="gap-1.5">
          <View className="flex-row items-center justify-between">
            <Text className="text-primary" variant="label">Step {current + 1} of {steps.length}</Text>
            <Text variant="caption">{done} done</Text>
          </View>
          <View className="flex-row gap-1">
            {steps.map((item, at) => <View key={item.key} className={`h-1 flex-1 rounded-full ${item.done ? "bg-primary" : at === current ? "bg-primary/40" : "bg-muted"}`} />)}
          </View>
        </View>
        <Animated.View key={step.key} entering={(forward ? FadeInRight : FadeInLeft).duration(220).reduceMotion(ReduceMotion.System)} className="gap-5">
          <View className="gap-1"><Text variant="title">{meta?.title ?? step.key}</Text>{meta?.hint ? <Text variant="muted">{meta.hint}</Text> : null}</View>
          <View pointerEvents={saving ? "none" : "auto"}><StepBody data={data} onSaved={reload} stepKey={step.key} /></View>
        </Animated.View>
      </View>}
    </Screen>
    <Sheet open={overview} onClose={() => setOverview(false)} title={`${done} of ${steps.length} done`}>
      <View className="gap-2">{steps.map((item, at) => <Pressable key={item.key} accessibilityRole="button" onPress={() => { setOverview(false); if (at !== current || finish) move(() => go(at)); }} className="min-h-16 flex-row items-center gap-3 rounded-2xl border border-border p-3"><Ionicons name={item.done ? "checkmark-circle" : "ellipse-outline"} size={24} color={item.done ? colors.primary : colors.mutedForeground} /><Text className="flex-1" variant="subtitle">{STEPS[item.key]?.title}</Text><Text variant="muted">{item.done ? "Done" : at === current ? "Here" : "To do"}</Text></Pressable>)}</View>
    </Sheet>
    <Sheet open={pending !== null} onClose={() => { if (!saving) setPending(null); }} title="Save changes?" footer={<Button disabled={blocked} label={saving ? "Saving…" : "Save & go"} onPress={() => pending && void saveAndGo(pending)} />}>
      <View className="gap-3"><Text variant="muted">Your changes are not saved.</Text><Button label="Keep editing" variant="outline" disabled={blocked} onPress={() => setPending(null)} /><Button label="Discard changes" variant="ghost" disabled={blocked} onPress={() => { const action = pending; setPending(null); action?.(); }} /></View>
    </Sheet>
  </KycDraftContext.Provider>;
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
      return <PhotosStep onSaved={onSaved} />;
    case "documents":
      return <DocumentsStep data={data} onSaved={onSaved} />;
    case "payout":
      return <PayoutAccountPanel onSaved={() => void onSaved()} />;
    case "payments":
      return <KycPayments onSaved={onSaved} />;
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

function PhotosStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const hostel = useManagedHostel();
  const { refresh } = hostel;
  const reread = useCallback(async () => {
    await Promise.all([refresh(), onSaved()]);
  }, [onSaved, refresh]);
  const { addPhotos, removePhoto, uploadingFor } = useHostelPhotoActions({
    hostelName: hostel.data?.name,
    refresh: reread,
  });

  useKycDraft({ dirty: false, busy: Boolean(uploadingFor), save: async () => true });

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
      {/* How full each kind is, at a glance — the add tiles below fill it. */}
      <Card className="gap-2.5">
        {[
          ...BUILDING_SHOTS.map((shot) => ({ count: photos.filter((photo) => photo.kind === shot.kind).length, limit: PHOTO_LIMITS[shot.kind], name: shot.name })),
          ...rooms.map((config) => ({ count: photos.filter((photo) => photo.kind === "ROOM" && photo.roomType === config.roomType).length, limit: PHOTO_LIMITS.ROOM, name: config.roomType })),
        ].map((group) => {
          const full = group.count >= group.limit;
          return <View className="flex-row items-center gap-3" key={group.name}>
            <Text className="w-24" numberOfLines={1} variant="label">{group.name}</Text>
            <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><View className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (group.count / group.limit) * 100)}%` }} /></View>
            {full ? <Ionicons color={colors.primary} name="checkmark-circle" size={18} /> : <Text className="w-12 text-right" variant="caption">{group.count}/{group.limit}</Text>}
          </View>;
        })}
      </Card>

      {BUILDING_SHOTS.map((shot) => {
        const shots = photos.filter((photo) => photo.kind === shot.kind);

        return (
          <StepSection caption={shot.kind === "EXTERIOR" ? "Listing cover" : undefined} key={shot.kind} title={shot.name}>
            <PhotoStrip
              large
              disabled={Boolean(uploadingFor)}
              busy={uploadingFor === targetKey({ kind: shot.kind })}
              limit={PHOTO_LIMITS[shot.kind]}
              name={`${shot.name} of ${hostel.data?.name ?? "the hostel"}`}
              onAdd={(source) => void addPhotos({ kind: shot.kind }, shots.length, source)}
              onRemove={removePhoto}
              photos={shots}
            />
          </StepSection>
        );
      })}

      <StepSection title="Rooms">
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
              large
              disabled={Boolean(uploadingFor)}
                  busy={uploadingFor === targetKey(target)}
                  limit={PHOTO_LIMITS.ROOM}
                  name={config.roomType}
                  onAdd={(source) => void addPhotos(target, shots.length, source)}
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
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState("");
  useKycDraft({ dirty: false, busy: Boolean(busy), save: async () => true });

  async function upload(type: string, label: string, source: "camera" | "file") {
    let asset: PickedDocument | null = null;

    try {
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) { toastError("Permission needed", "Allow the camera to photograph the document."); return; }
        const picked = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
        asset = picked.canceled ? null : picked.assets[0];
      } else {
        asset = await pickDocument();
      }
    } catch (error) {
      toastError("Could not open that", readApiError(error));
      return;
    }

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
            <View className="gap-3">
              {rows.map((row, at) => (
                <DocumentRow
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
              <View className="flex-row gap-2">
                <Button className="flex-1" disabled={Boolean(busy)} icon={Camera} label={busy === doc.type ? "Uploading…" : "Camera"} onPress={() => void upload(doc.type, doc.label, "camera")} variant="outline" />
                <Button className="flex-1" disabled={Boolean(busy)} icon={FileUp} label="Upload file" onPress={() => void upload(doc.type, doc.label, "file")} variant="outline" />
              </View>
            </View>
          </StepSection>
        );
      })}

      <View className="flex-row items-center gap-2">
        <Ionicons color={colors.mutedForeground} name="lock-closed-outline" size={18} />
        <Text variant="muted">Only you and our team see these</Text>
      </View>
    </View>
  );
}

/** One file across the whole row: the page itself, big enough to read, then where it stands. */
function DocumentRow({ onOpen, row }: { onOpen: () => void; row: HostelKyc["documents"][number] }) {
  const { colors } = useAppTheme();
  const token = useAppSelector((state) => state.auth.accessToken);
  const status = DOCUMENT_STATUS[row.status] ?? DOCUMENT_STATUS.PENDING;
  const pdf = isPdfReceipt(row.mimeType ?? undefined);
  const source =
    row.fileAssetId && !pdf
      ? viewerSourceFor({ assetId: row.fileAssetId }, { baseUrl: API_BASE_URL, token })
      : null;

  return (
    <View className="gap-2">
      {pdf && row.fileAssetId ? (
        <PdfPreview height={200} label={`Open ${row.fileName ?? row.type}`} onPress={onOpen} read={() => readRemotePdf({ assetId: row.fileAssetId ?? undefined })} />
      ) : (
        <Pressable
          accessibilityLabel={`Open ${row.fileName ?? row.type}`}
          accessibilityRole="imagebutton"
          className="h-[200px] items-center justify-center overflow-hidden rounded-xl bg-muted active:opacity-80"
          disabled={!row.fileAssetId}
          onPress={onOpen}
        >
          {/* Under the image, so a file that will not load still reads as a document. */}
          <Ionicons color={colors.mutedForeground} name="document-text-outline" size={32} />
          {source ? (
            <Image
              contentFit="contain"
              source={source}
              style={{ height: "100%", left: 0, position: "absolute", top: 0, width: "100%" }}
              transition={150}
            />
          ) : null}
        </Pressable>
      )}
      <View className="flex-row items-center gap-2">
        <Badge label={status.label} tone={status.tone} />
        <Text className={`flex-1 ${row.status === "REJECTED" ? "text-destructive" : ""}`} numberOfLines={2} variant="caption">
          {row.status === "REJECTED" && row.rejectionReason ? row.rejectionReason : row.fileName ?? row.type}
        </Text>
      </View>
    </View>
  );
}

function FoodStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const week = useFoodWeek({ onSaved: () => void onSaved() });
  const { cells, dirty, filled, food, save, saving } = week;
  useKycDraft({ dirty, busy: saving, save });

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
      <FoodWeekEditor week={week} />
      <Text variant="caption">{filled} of {cells} meals filled{dirty ? " · not saved yet" : ""}</Text>
    </View>
  );
}

const SUGGESTED_RULES = ["No smoking", "Gate closes at 9 PM", "Keep rooms clean", "No loud music", "Pay rent on time", "No food in rooms"];
function RulesStep({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: string[] }) {
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const rules = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    const next = rules.map(rule => rule.trim()).filter(Boolean);
    setSaving(true);
    try { await updateManagedHostel({ rules: next }); await onSaved(); setDraft(null); setEditing(null); return true; }
    catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving, save });
  const shift = (direction: number) => {
    if (menu === null || menu + direction < 0 || menu + direction >= rules.length) return;
    const next = [...rules];
    [next[menu], next[menu + direction]] = [next[menu + direction], next[menu]];
    setDraft(next); setEditing(null); setMenu(null);
  };
  return <View className="gap-4">
    <Text variant="muted">{rules.filter(rule => rule.trim()).length} rules</Text>
    {rules.length ? <Card padding="p-0">{rules.map((rule, at) => <View key={at} className={`flex-row items-center gap-3 p-4 ${at ? "border-t border-border" : ""}`}>
      <View className="h-8 w-8 items-center justify-center rounded-full bg-muted"><Text variant="label">{at + 1}</Text></View>
      {editing === at ? <View className="flex-1"><Input accessibilityLabel={`Rule ${at + 1}`} multiline autoFocus value={rule} placeholder="Add a rule" onChangeText={text => setDraft(rules.map((value, index) => index === at ? text : value))} /></View> : <Pressable accessibilityRole="button" accessibilityLabel={`Edit rule ${at + 1}`} onPress={() => setEditing(at)} className="min-h-11 flex-1 justify-center"><Text>{rule || "Add a rule"}</Text></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={`Rule ${at + 1} options`} onPress={() => setMenu(at)} className="h-11 w-11 items-center justify-center"><Ionicons name="ellipsis-vertical" color={colors.foreground} size={20} /></Pressable>
    </View>)}</Card> : null}
    <Button label="+ Add rule" variant="outline" onPress={() => { setDraft([...rules, ""]); setEditing(rules.length); }} />
    <Text variant="subtitle">Tap to add</Text>
    <View className="flex-row flex-wrap gap-2">{SUGGESTED_RULES.filter(rule => !rules.includes(rule)).map(rule => <Pressable key={rule} accessibilityRole="button" onPress={() => setDraft([...rules, rule])} className="min-h-12 justify-center rounded-xl border border-border px-3"><Text variant="label">+ {rule}</Text></Pressable>)}</View>
    <Sheet open={menu !== null} onClose={() => setMenu(null)} title="Rule options"><View className="gap-2"><Button label="Edit" variant="outline" onPress={() => { setEditing(menu); setMenu(null); }} /><Button label="Move up" variant="outline" disabled={menu === 0} onPress={() => shift(-1)} /><Button label="Move down" variant="outline" disabled={menu === rules.length - 1} onPress={() => shift(1)} /><Button label="Remove" variant="ghost" onPress={() => { setDraft(rules.filter((_, at) => at !== menu)); setEditing(null); setMenu(null); }} /></View></Sheet>
  </View>;
}

const FACILITY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  WiFi: "wifi-outline", "Hot water": "water-outline", Parking: "car-outline", Laundry: "shirt-outline", Gym: "barbell-outline", "Study table": "reader-outline", "Attached bathroom": "water-outline", AC: "snow-outline", CCTV: "videocam-outline", "Power backup": "battery-charging-outline", Kitchen: "restaurant-outline", "Common room": "people-outline",
};
function FacilitiesStep({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: string[] }) {
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const picked = draft ?? saved;
  const options = [...new Set([...FACILITY_OPTIONS, ...saved])];
  const dirty = [...picked].sort().join("|") !== [...saved].sort().join("|");
  const save = async () => {
    setSaving(true);
    try { await updateManagedHostel({ facilities: picked }); await onSaved(); setDraft(null); return true; }
    catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving, save });
  return <View className="gap-4"><Text variant="muted">{picked.length} picked</Text><View className="flex-row flex-wrap gap-3">{options.map(option => {
    const selected = picked.includes(option);
    return <Pressable key={option} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => setDraft(selected ? picked.filter(item => item !== option) : [...picked, option])} className={`min-h-20 w-[48%] flex-row items-center gap-2 rounded-2xl border p-3 ${selected ? "border-primary/30 bg-brand-soft" : "border-border"}`}>
      <Ionicons name={FACILITY_ICONS[option] ?? "checkmark-circle-outline"} color={selected ? colors.primary : colors.foreground} size={24} /><Text className="flex-1" variant="label">{option === "WiFi" ? "Wi-Fi" : option}</Text>{selected ? <Ionicons name="checkmark-circle" color={colors.primary} size={16} /> : null}
    </Pressable>;
  })}</View></View>;
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
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<{ lat: number; lng: number; hit?: GeocodeHit } | null>(null);
  const location = hostel.data?.location;
  const savedPin = location?.lat != null && location.lng != null ? { lat: location.lat, lng: location.lng } : null;
  const pin = selected ?? savedPin;
  const placed = location?.locationSource === "MANUAL";
  const save = async () => {
    if (!selected || !location) return false;
    setSaving(true);
    try {
      const next = await updateManagedHostel({ location: {
        address: location.address ? undefined : selected.hit?.address,
        area: location.area ? undefined : selected.hit?.area,
        city: location.city ? undefined : selected.hit?.city,
        province: location.province ? undefined : selected.hit?.province,
        lat: selected.lat, lng: selected.lng, locationSource: "MANUAL",
      } });
      hostel.setData(() => next);
      await onSaved(); setSelected(null); return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty: selected !== null, busy: saving, save });
  if (hostel.loading) return <SkeletonCard rows={3} />;
  if (hostel.error || !location) return <ErrorState message={hostel.error ?? "Could not load map."} onRetry={hostel.reload} />;
  return <View className="gap-4">
    {pin ? <>
      <Pressable accessibilityLabel="Move the pin" accessibilityRole="button" className="h-64 overflow-hidden rounded-2xl border border-border" onPress={() => setPicking(true)}>
        <PinPreview key={`${pin.lat},${pin.lng}`} pin={pin} />
      </Pressable>
      <View className="flex-row items-center gap-2">
        <Ionicons color={colors.foreground} name="location-outline" size={20} />
        <Text className="flex-1" numberOfLines={1} variant="subtitle">{[location.area, location.city].filter(Boolean).join(", ") || "Your hostel"}</Text>
        <Badge label={selected ? "Not saved" : placed ? "Placed by you" : "Check this pin"} tone={placed && !selected ? "success" : "warning"} />
      </View>
      {!placed || selected ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected !== null }} onPress={() => setSelected(selected ? null : pin)} className={`min-h-14 flex-row items-center gap-3 rounded-xl border p-4 ${selected ? "border-primary bg-brand-soft" : "border-border"}`}><Ionicons name={selected ? "checkbox" : "square-outline"} color={colors.primary} size={24} /><Text className="flex-1" variant="label">Yes, this is my door</Text></Pressable> : null}
    </> : <Card className="items-center gap-2 py-8"><Ionicons name="location-outline" size={36} color={colors.primary} /><Text variant="muted">Find your hostel on the map</Text></Card>}
    <Button icon={MapPin} label={pin ? "Move pin" : "Find on map"} variant="outline" onPress={() => setPicking(true)} />
    <PinPickerModal
      initial={pin}
      onClose={() => setPicking(false)}
      onPick={(next) => { setSelected(next); setPicking(false); }}
      open={picking}
      search={geocodeHostelLocation}
    />
  </View>;
}
