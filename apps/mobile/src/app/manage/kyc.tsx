import { BEDS_BY_ROOM_TYPE, ROOM_TYPE_OPTIONS } from "@hostel/constants/room-types";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { usePreventRemove } from "expo-router/react-navigation";
import { router, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeInLeft, FadeInRight, ReduceMotion, useReducedMotion } from "react-native-reanimated";

import { PinPickerModal, PinPreview } from "@/components/hostel-pin-picker";
import { FoodWeekEditor } from "@/components/manage/food-week-editor";
import { KycDraftContext, useKycDraft, type KycDraft } from "@/components/manage/kyc-draft";
import { KycPayments } from "@/components/manage/kyc-payments";
import { KycOpeningStep, KycRoomsStep } from "@/components/manage/kyc-setup-steps";
import { LeavePromiseCard } from "@/components/leave-promise-card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
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
import { IconButton } from "@/components/ui/icon-button";
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
import {
  addKycDocument,
  getHostelKyc,
  getKycAgreement,
  KYC_AGREEMENT_PDF_PATH,
  removeKycDocument,
  signKycAgreement,
  submitHostelKyc,
  type HostelKyc,
} from "@/lib/admin-api";
import { SignatureInk, SignaturePad } from "@/components/signature-pad";
import { downloadToDevice } from "@/lib/documents";
import { isSignatureComplete, signatureStrokes } from "@/lib/signature";
import { revalidateSession } from "@/lib/auth-session";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { openConfirm } from "@/lib/confirm";
import {
  type GeocodeHit,
  geocodeHostelLocation,
  type FeeScheduleData,
  type ManagedHostel,
  saveKycRates,
  updateManagedHostel,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { requestDeviceLocation } from "@/lib/location";
import { openAssetViewer, viewerSourceFor } from "@/lib/asset-viewer";
import { pickDocument, type PickedDocument } from "@/lib/document-picker";
import { FACILITY_OPTIONS, HOSTEL_TYPES } from "@/lib/hostel-registration";
import type { BadgeTone } from "@/lib/status";
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";
import { useUnloadGuard } from "@/lib/unload-guard";

const SUCCESS_ANIMATION = require("../../../assets/lottie/success.lottie");

const STEPS: Record<string, { hint: string; icon: GlyphName; short: string; title: string }> = {
  details: { hint: "Who lives here, and where", icon: "home", short: "Details", title: "Hostel details" },
  rates: { hint: "Each room type and its monthly rent", icon: "pricetags", short: "Room types & rent", title: "Room types & rent" },
  documents: { hint: "Add your ID", icon: "document-text", short: "Documents", title: "Documents" },
  facilities: { hint: "Tap what you have", icon: "bed", short: "Facilities", title: "Facilities" },
  food: { hint: "", icon: "restaurant", short: "Food", title: "Food menu" },
  location: { hint: "Is this your door?", icon: "location", short: "Map", title: "Map pin" },
  payments: { hint: "", icon: "home", short: "Rent", title: "Rent payments" },
  payout: { hint: "Where we send your money", icon: "card", short: "Booking money", title: "Booking money" },
  opening: { hint: "Your bank balance when you start", icon: "wallet", short: "Opening balance", title: "Opening balance" },
  photos: { hint: "", icon: "image", short: "Photos", title: "Photos" },
  rooms: { hint: "Each floor and its room numbers", icon: "business", short: "Rooms", title: "Rooms & floors" },
  rules: { hint: "", icon: "reader", short: "Rules", title: "House rules" },
  agreement: { hint: "Read it, then sign at the bottom", icon: "create", short: "Agreement", title: "Agreement" },
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
  // The signature pad needs the vertical drag; the page stops scrolling while it is held.
  const [signing, setSigning] = useState(false);
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
  /*
   * Leaving always works — the close button, the back arrow, a swipe or
   * Android's back. The section being edited is saved on the way out, so the
   * KYC keeps everything as a draft until it is submitted. Only a section that
   * cannot be saved as it stands (a half-typed field) asks once: keep editing,
   * or leave that one change behind.
   */
  const saveAndExit = async (exit: () => void) => {
    if (lock.current || status.busy) { toastError("Please wait", "Your changes are being saved."); return; }
    if (!status.dirty) { leave(exit); return; }
    lock.current = true;
    setSaving(true);
    let saved = true;
    try {
      for (const draft of [...entries.current.values()]) {
        if (draft.dirty && !(await draft.save())) { saved = false; break; }
      }
    } catch { saved = false; }
    finally { lock.current = false; setSaving(false); }
    if (saved) { toastSuccess("Saved", "Your KYC is kept as a draft. Finish it any time."); leave(exit); }
    else setPending(() => () => leave(exit));
  };
  usePreventRemove(!allowLeave && (status.dirty || blocked), ({ data }) => {
    void saveAndExit(() => navigation.dispatch(data.action));
  });
  useEffect(() => {
    if (allowLeave) leaving.current?.();
  }, [allowLeave]);
  useUnloadGuard(status.dirty || blocked);

  const steps = kyc.data?.steps ?? [];
  const reviewStatus = kyc.data?.review?.status ?? null;
  const account = useAppSelector(state => state.auth.account);
  // The frozen menus read `/auth/me`; a decision seen here brings them up to date.
  useEffect(() => {
    if (reviewStatus && account?.hostelKyc && account.hostelKyc.status !== reviewStatus) void revalidateSession();
  }, [reviewStatus, account?.hostelKyc]);
  const firstOpen = steps.findIndex(step => !step.done);
  const current = Math.max(0, Math.min(index ?? firstOpen, steps.length - 1));
  const finish = finished || (index === null && firstOpen === -1);
  const go = (next: number) => { setForward(next > current); setIndex(next); setFinished(false); };
  const move = (action: () => void) => {
    if (lock.current || status.busy) return;
    if (status.dirty) setPending(() => action);
    else action();
  };
  // One fixed screen: back closes a sheet, otherwise it leaves, and
  // `usePreventRemove` guards that exit.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (overview) { setOverview(false); return true; }
      if (pending) { if (!saving) setPending(null); return true; }
      return false;
    });
    return () => subscription.remove();
  });

  if (kyc.loading) return <StepSkeleton subtitle="" title="Hostel KYC" total={12} />;
  if (kyc.error || !kyc.data || !steps.length) return <Screen header={<AppBar showBack title="Hostel setup" />}><ErrorState message={kyc.error ?? "Could not load setup."} onRetry={kyc.reload} /></Screen>;
  const data = kyc.data;
  if (index === null && firstOpen >= 0) setIndex(current);
  const step = steps[current];
  const meta = STEPS[step.key];
  // Finished sections never open on their own: Next goes to the next unfinished one.
  const after = steps.findIndex((item, at) => at > current && !item.done);
  const nextOpen = after >= 0 ? after : steps.findIndex((item, at) => at !== current && !item.done);
  const last = nextOpen === -1;
  const done = steps.filter(item => item.done).length;
  const review = data.review ?? null;
  const requiredLeft = review?.missing.length ?? 0;
  const statusLine = !review
    ? `${done} of ${steps.length} done`
    : review.status === "APPROVED"
      ? "Verified by our team"
      : review.status === "SUBMITTED"
        ? "In review — you can still edit"
        : review.status === "REJECTED"
          ? `Sent back: ${review.note ?? "please check and submit again"}`
          : requiredLeft > 0
            ? `${requiredLeft} required ${requiredLeft === 1 ? "section" : "sections"} left`
            : "Ready to submit";
  const submit = () => openConfirm({
    cancelLabel: "Check again",
    confirmLabel: "Send",
    message: "Our team checks it within 24 hours. Please make sure everything you entered is correct.",
    onConfirm: async () => {
      try {
        await submitHostelKyc();
        await reload();
        void revalidateSession();
        toastSuccess("KYC sent", "We check it within 24 hours. You can still edit it.");
      } catch (error) { toastError("Not submitted", readApiError(error)); }
    },
    title: "Send your KYC for submission?",
  });
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
  const next = () => last ? setFinished(true) : go(nextOpen);

  return <KycDraftContext.Provider value={register}>
    <Screen scroll scrollEnabled={!signing} header={<AppBar title="Hostel KYC" showBack onBack={() => void saveAndExit(() => router.back())} actions={<IconButton label="Close KYC" name="close" onPress={() => void saveAndExit(() => router.back())} />} />}
      footer={finish ? review?.canSubmit ? <View className="gap-1"><Button label="Send for submission" onPress={submit} /><Button label={data.percent >= 100 ? "Go home" : "Finish the rest"} variant="ghost" onPress={() => data.percent >= 100 ? router.back() : go(Math.max(0, firstOpen))} /></View> : <View className="gap-1"><Button label={data.percent >= 100 ? "Go home" : "Continue"} onPress={() => data.percent >= 100 ? router.back() : go(Math.max(0, firstOpen))} /><Button label={data.percent >= 100 ? "View steps" : "Go home"} variant="ghost" onPress={() => data.percent >= 100 ? setOverview(true) : router.back()} /></View> : <View className="gap-1"><Button disabled={blocked} label={saving ? "Saving…" : status.busy ? "Please wait…" : status.dirty ? last ? "Save & finish" : "Save & next" : last ? "Finish" : "Next"} onPress={() => void saveAndGo(next)} /><Button label="Skip" variant="ghost" disabled={blocked} onPress={() => move(next)} /></View>}>
      {finish ? <Animated.View entering={FadeIn.duration(220).reduceMotion(ReduceMotion.System)} className="items-center gap-5 py-6">
        {data.percent >= 100 ? <View className="items-center">{!reduced && finished ? <Lottie loop={false} size={140} source={SUCCESS_ANIMATION} /> : <Glyph name="checkmark-circle" color={colors.primary} size={112} />}<Text variant="muted">{done} of {steps.length}</Text></View> : <KycRing percent={data.percent} size={120} />}
        <Text variant="title">{review?.status === "SUBMITTED" ? "Sent for review" : review?.status === "APPROVED" ? "Verified" : review?.canSubmit ? "Send for submission" : data.percent >= 100 ? "All done!" : `${data.percent}% done`}</Text>
        <Text className="text-center" variant="muted">{review?.status === "SUBMITTED" ? "We check it within 24 hours. You can still edit anything until then. Once approved you get:" : review?.status === "APPROVED" ? "Every feature is open on the web and the app." : review?.canSubmit ? "Every required section is done. Once our team approves it you get:" : review && requiredLeft > 0 ? `Finish the ${requiredLeft} required ${requiredLeft === 1 ? "section" : "sections"} to send it.` : data.percent >= 100 ? "Your hostel is ready" : "Finish the rest any time"}</Text>
        {review?.canSubmit || review?.status === "SUBMITTED" ? <View className="w-full gap-2">{([["phone-portrait", "Full access to the web and app portals"], ["document-text", "An agreement letter between you and HostelPalika"], ["download", "Your data stays yours: leave any time and take all of it"]] as const).map(([icon, text]) => <View className="flex-row items-center gap-3 rounded-2xl border border-border p-3" key={text}><View className="h-9 w-9 items-center justify-center rounded-xl bg-brand-soft"><Glyph color={colors.primary} name={icon} size={18} /></View><Text className="flex-1" variant="body">{text}</Text></View>)}</View> : null}
        <View className="w-full flex-row flex-wrap justify-between gap-y-3">{steps.map((item, at) => <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`${STEPS[item.key]?.title}, ${item.done ? "done" : "to do"}`} onPress={() => go(at)} className={`min-h-16 w-[48.5%] flex-row items-center gap-2 rounded-2xl p-2.5 active:opacity-70 ${item.done ? "bg-brand-soft" : "border border-border"}`}>
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-background"><Glyph name={STEPS[item.key]?.icon ?? "ellipse"} color={colors.primary} size={20} /></View>
          <Text className="flex-1" numberOfLines={2} variant="label">{STEPS[item.key]?.short}</Text>
          <Glyph name={item.done ? "checkmark-circle" : "ellipse"} color={item.done ? colors.primary : colors.mutedForeground} size={22} />
        </Pressable>)}</View>
        {data.percent >= 100 ? <View className="flex-row items-center gap-2"><Glyph name="time" color={colors.warning} size={18} /><Text variant="muted">Some checks may take time</Text></View> : null}
        <View className="w-full"><LeavePromiseCard /></View>
      </Animated.View> : <View className="gap-4 pb-4 pt-1">
        <Pressable accessibilityHint="Shows done and to-do sections" accessibilityLabel={`${done} of ${steps.length} sections done. ${statusLine}`} accessibilityRole="button" className="flex-row items-center gap-3 active:opacity-70" disabled={blocked} onPress={() => setOverview(true)}>
          <KycRing percent={data.percent} size={56} />
          <View className="flex-1 gap-0.5">
            <Text variant="label">{done} of {steps.length} sections done</Text>
            <Text numberOfLines={2} variant="caption">{statusLine}</Text>
          </View>
          <Glyph color={colors.mutedForeground} name="chevron-down" size={20} />
        </Pressable>
        <Animated.View key={step.key} entering={(forward ? FadeInRight : FadeInLeft).duration(220).reduceMotion(ReduceMotion.System)} className="gap-5">
          <View className="gap-1"><View className="flex-row items-center gap-2"><Text variant="title">{meta?.title ?? step.key}</Text>{step.required ? <Badge label="Required" tone={step.done ? "success" : "warning"} /> : null}</View>{meta?.hint ? <Text variant="muted">{meta.hint}</Text> : null}</View>
          <View pointerEvents={saving ? "none" : "auto"}><StepBody data={data} onSaved={reload} onSigningChange={setSigning} stepKey={step.key} /></View>
        </Animated.View>
      </View>}
    </Screen>
    <Sheet open={overview} onClose={() => setOverview(false)} title={`${done} of ${steps.length} done`} footer={review?.canSubmit && !finish ? <Button label="Review & send" onPress={() => { setOverview(false); move(() => setFinished(true)); }} /> : undefined}>
      <View className="gap-4">{([["To do", false], ["Done", true]] as const).map(([heading, isDone]) => {
        const group = steps.map((item, at) => ({ at, item })).filter(({ item }) => item.done === isDone);
        return group.length === 0 ? null : <View className="gap-2" key={heading}><Text variant="label">{heading}</Text>{group.map(({ at, item }) => <Pressable key={item.key} accessibilityRole="button" onPress={() => { setOverview(false); if (at !== current || finish) move(() => go(at)); }} className={`min-h-16 flex-row items-center gap-3 rounded-2xl p-3 ${item.done ? "bg-brand-soft" : "border border-border"}`}><Glyph name={item.done ? "checkmark-circle" : "ellipse"} size={24} color={item.done ? colors.primary : colors.mutedForeground} /><Text className="flex-1" variant="subtitle">{STEPS[item.key]?.title}</Text>{!item.done && item.required ? <Badge label="Required" tone="warning" /> : <Text variant="muted">{at === current && !finish ? "Here" : item.done ? "Done" : "To do"}</Text>}</Pressable>)}</View>;
      })}</View>
    </Sheet>
    <Sheet open={pending !== null} onClose={() => { if (!saving) setPending(null); }} title="Save changes?" footer={<Button disabled={blocked} label={saving ? "Saving…" : "Save & go"} onPress={() => pending && void saveAndGo(pending)} />}>
      <View className="gap-3"><Text variant="muted">Your changes are not saved.</Text><Button label="Keep editing" variant="outline" disabled={blocked} onPress={() => setPending(null)} /><Button label="Discard changes" variant="ghost" disabled={blocked} onPress={() => { const action = pending; setPending(null); action?.(); }} /></View>
    </Sheet>
  </KycDraftContext.Provider>;
}

function StepBody({
  data,
  onSaved,
  onSigningChange,
  stepKey,
}: {
  data: HostelKyc;
  onSaved: () => Promise<void> | void;
  onSigningChange: (active: boolean) => void;
  stepKey: string;
}) {
  switch (stepKey) {
    case "details":
      return <DetailsStep data={data} onSaved={onSaved} />;
    case "rates":
      return <RatesStep onSaved={onSaved} />;
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
    case "rooms":
      return <KycRoomsStep onSaved={onSaved} />;
    case "opening":
      return <KycOpeningStep onSaved={onSaved} />;
    case "agreement":
      return <AgreementStep onSaved={onSaved} onSigningChange={onSigningChange} />;
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
            {full ? <Glyph color={colors.primary} name="checkmark-circle" size={18} /> : <Text className="w-12 text-right" variant="caption">{group.count}/{group.limit}</Text>}
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
                  onRemove={row.canRemove ? () => openConfirm({
                    confirmLabel: "Remove",
                    destructive: true,
                    message: "You can upload it again any time.",
                    title: `Remove ${doc.label.toLowerCase()}?`,
                    onConfirm: async () => {
                      try { await removeKycDocument(row.id); await onSaved(); toastSuccess("Removed"); }
                      catch (error) { toastError("Could not remove it", readApiError(error)); }
                    },
                  }) : undefined}
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
                <Button className="flex-1" disabled={Boolean(busy)} icon="camera" label={busy === doc.type ? "Uploading…" : "Camera"} onPress={() => void upload(doc.type, doc.label, "camera")} variant="outline" />
                <Button className="flex-1" disabled={Boolean(busy)} icon="document-upload" label="Upload file" onPress={() => void upload(doc.type, doc.label, "file")} variant="outline" />
              </View>
            </View>
          </StepSection>
        );
      })}

      <View className="flex-row items-center gap-2">
        <Glyph color={colors.mutedForeground} name="lock-closed" size={18} />
        <Text variant="muted">Only you and our team see these</Text>
      </View>
    </View>
  );
}

/** One file across the whole row: the page itself, big enough to read, then where it stands. */
function DocumentRow({ onOpen, onRemove, row }: { onOpen: () => void; onRemove?: () => void; row: HostelKyc["documents"][number] }) {
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
          <Glyph color={colors.mutedForeground} name="document-text" size={32} />
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
        {onRemove ? (
          <Pressable accessibilityLabel={`Remove ${row.fileName ?? row.type}`} accessibilityRole="button" className="size-9 items-center justify-center rounded-full active:opacity-70" hitSlop={8} onPress={onRemove}>
            <Glyph color={colors.destructive} name="trash" size={18} />
          </Pressable>
        ) : null}
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
      <Pressable accessibilityRole="button" accessibilityLabel={`Rule ${at + 1} options`} onPress={() => setMenu(at)} className="h-11 w-11 items-center justify-center"><Glyph name="ellipsis-vertical" color={colors.foreground} size={20} /></Pressable>
    </View>)}</Card> : null}
    <Button label="+ Add rule" variant="outline" onPress={() => { setDraft([...rules, ""]); setEditing(rules.length); }} />
    <Text variant="subtitle">Tap to add</Text>
    <View className="flex-row flex-wrap gap-2">{SUGGESTED_RULES.filter(rule => !rules.includes(rule)).map(rule => <Pressable key={rule} accessibilityRole="button" onPress={() => setDraft([...rules, rule])} className="min-h-12 justify-center rounded-xl border border-border px-3"><Text variant="label">+ {rule}</Text></Pressable>)}</View>
    <Sheet open={menu !== null} onClose={() => setMenu(null)} title="Rule options"><View className="gap-2"><Button label="Edit" variant="outline" onPress={() => { setEditing(menu); setMenu(null); }} /><Button label="Move up" variant="outline" disabled={menu === 0} onPress={() => shift(-1)} /><Button label="Move down" variant="outline" disabled={menu === rules.length - 1} onPress={() => shift(1)} /><Button label="Remove" variant="ghost" onPress={() => { setDraft(rules.filter((_, at) => at !== menu)); setEditing(null); setMenu(null); }} /></View></Sheet>
  </View>;
}

const FACILITY_ICONS: Record<string, GlyphName> = {
  WiFi: "wifi", "Hot water": "water", Parking: "car", Laundry: "shirt", Gym: "barbell", "Study table": "reader", "Attached bathroom": "water", AC: "snow", CCTV: "videocam", "Power backup": "battery-charging", Kitchen: "restaurant", "Common room": "people",
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
      <Glyph name={FACILITY_ICONS[option] ?? "checkmark-circle"} color={selected ? colors.primary : colors.foreground} size={24} /><Text className="flex-1" variant="label">{option === "WiFi" ? "Wi-Fi" : option}</Text>{selected ? <Glyph name="checkmark-circle" color={colors.primary} size={16} /> : null}
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
  const [locating, setLocating] = useState(false);
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
  useKycDraft({ dirty: selected !== null, busy: saving || locating, save });
  // The team portal's "Use my location": the phone's fix becomes the pin, and the
  // address it sits on fills only the fields the listing does not have yet.
  const locateMe = async () => {
    setLocating(true);
    try {
      const outcome = await requestDeviceLocation();
      if (outcome.kind !== "granted") {
        toastError("Location is off", outcome.kind === "denied" ? "Allow location for the app, or move the pin." : "Could not get a fix. Try again outside, or move the pin.");
        return;
      }
      const [hit] = await geocodeHostelLocation(outcome.coordinates).catch(() => []);
      setSelected({ ...outcome.coordinates, hit });
    } finally { setLocating(false); }
  };
  if (hostel.loading) return <SkeletonCard rows={3} />;
  if (hostel.error || !location) return <ErrorState message={hostel.error ?? "Could not load map."} onRetry={hostel.reload} />;
  return <View className="gap-4">
    {pin ? <>
      <Pressable accessibilityLabel="Move the pin" accessibilityRole="button" className="h-64 overflow-hidden rounded-2xl border border-border" onPress={() => setPicking(true)}>
        <PinPreview key={`${pin.lat},${pin.lng}`} pin={pin} />
      </Pressable>
      <View className="flex-row items-center gap-2">
        <Glyph color={colors.foreground} name="location" size={20} />
        <Text className="flex-1" numberOfLines={1} variant="subtitle">{[location.area, location.city].filter(Boolean).join(", ") || "Your hostel"}</Text>
        <Badge label={selected ? "Not saved" : placed ? "Placed by you" : "Check this pin"} tone={placed && !selected ? "success" : "warning"} />
      </View>
      {!placed || selected ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected !== null }} onPress={() => setSelected(selected ? null : pin)} className={`min-h-14 flex-row items-center gap-3 rounded-xl border p-4 ${selected ? "border-primary bg-brand-soft" : "border-border"}`}><Glyph name={selected ? "checkbox" : "square"} variant={selected ? "solid" : "line"} color={colors.primary} size={24} /><Text className="flex-1" variant="label">Yes, this is my door</Text></Pressable> : null}
    </> : <Card className="items-center gap-2 py-8"><Glyph name="location" size={36} color={colors.primary} /><Text variant="muted">Find your hostel on the map</Text></Card>}
    <Button icon="locate" label={locating ? "Finding you…" : "Use my location"} disabled={locating} onPress={() => void locateMe()} />
    <Button icon="location" label={pin ? "Move pin" : "Find on map"} variant="outline" onPress={() => setPicking(true)} />
    <PinPickerModal
      initial={pin}
      onClose={() => setPicking(false)}
      onPick={(next) => { setSelected(next); setPicking(false); }}
      open={picking}
      search={geocodeHostelLocation}
    />
  </View>;
}

/** Who lives here and the address: the quick sign-up filed a name only. */
function DetailsStep({ data, onSaved }: { data: HostelKyc; onSaved: () => Promise<void> | void }) {
  const saved = { address: data.details?.address ?? "", area: data.details?.area ?? "", city: data.details?.city || "Kathmandu", hostelType: data.details?.hostelType ?? "CO_LIVING" };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const [saving, setSaving] = useState(false);
  const form = draft ?? saved;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = (patch: Partial<typeof saved>) => setDraft({ ...form, ...patch });
  const save = async () => {
    if (form.area.trim().length < 2 || form.city.trim().length < 2) {
      toastError("Not saved", "Enter the area and the city.");
      return false;
    }
    setSaving(true);
    try {
      await updateManagedHostel({ hostelType: form.hostelType, location: { address: form.address.trim(), area: form.area.trim(), city: form.city.trim() } });
      await onSaved();
      setDraft(null);
      return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving, save });
  return <View className="gap-4">
    <ChoiceChips columns={3} label="Who lives here" onToggle={(hostelType) => set({ hostelType })} options={HOSTEL_TYPES} value={form.hostelType as (typeof HOSTEL_TYPES)[number]["value"]} />
    <Input autoCapitalize="words" label="City" onChangeText={(city) => set({ city })} value={form.city} />
    <Input autoCapitalize="words" label="Area" onChangeText={(area) => set({ area })} placeholder="Baneshwor" value={form.area} />
    <Input autoCapitalize="sentences" label="Address" onChangeText={(address) => set({ address })} placeholder="Street, near a landmark" value={form.address} />
  </View>;
}

/**
 * Room types and their rent, both set here: a type is added or changed in a
 * sheet (saves at once, like photos); the rents and joining fees are the step's
 * draft and go to the rate card through the wizard's save.
 */
function RatesStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const hostel = useManagedHostel();
  const feeQuery = adminQuery.feeSchedules();
  const fees = useResource<FeeScheduleData>(feeQuery.load, { cacheKey: feeQuery.key, topics: feeQuery.topics });
  const [rents, setRents] = useState<Record<string, string>>({});
  const [admission, setAdmission] = useState<string>();
  const [deposit, setDeposit] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ at: number | null; bedsPerRoom: string; rooms: string; roomType: string } | null>(null);
  const rooms = hostel.data?.roomConfigurations ?? [];
  const card = fees.data?.schedules.find((item) => item.standing === "upcoming") ?? fees.data?.schedules.find((item) => item.standing === "current");
  const savedRent = (roomType: string) => card?.rates.find((rate) => (rate.roomType ?? "").toLowerCase() === roomType.toLowerCase())?.monthlyAmount;
  const rentOf = (roomType: string) => rents[roomType] ?? String(savedRent(roomType) ?? "");
  const admissionValue = admission ?? (card?.admissionFee ? String(card.admissionFee) : "");
  const depositValue = deposit ?? (card?.depositAmount ? String(card.depositAmount) : "");
  const rates = rooms.filter((room) => Number(rentOf(room.roomType)) > 0).map((room) => ({ monthlyAmount: Number(rentOf(room.roomType)), roomType: room.roomType }));
  const dirty = Object.keys(rents).length > 0 || admission !== undefined || deposit !== undefined;
  const digits = (value: string) => value.replace(/\D/g, "");
  const save = async () => {
    if (!rates.length) { toastError("Not saved", "Enter a monthly rent."); return false; }
    setSaving(true);
    try {
      const saved = await saveKycRates({ admissionFee: admissionValue ? Number(admissionValue) : undefined, depositAmount: depositValue ? Number(depositValue) : undefined, rates });
      if (saved.nextMonth) toastSuccess("Saved", "Residents are already billed at the old price this month, so the new price starts next month.");
      setRents({}); setAdmission(undefined); setDeposit(undefined);
      await Promise.all([fees.reload(), hostel.reload(), onSaved()]);
      return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving, save });
  const saveType = async () => {
    if (!editing) return;
    const roomType = editing.roomType.trim();
    const bedsPerRoom = Math.max(1, Number(editing.bedsPerRoom) || 1);
    const count = Math.max(0, Number(editing.rooms) || 0);
    if (!roomType) { toastError("Not saved", "Name the room type."); return; }
    const before = editing.at === null ? null : rooms[editing.at];
    const row = { bedsPerRoom, mealInclusion: before?.mealInclusion || "Included", monthlyRent: before?.monthlyRent ?? 0, rooms: count, roomType, vacantBeds: Math.min(before?.vacantBeds ?? count * bedsPerRoom, count * bedsPerRoom) };
    setSaving(true);
    try {
      const next = await updateManagedHostel({ roomConfigurations: editing.at === null ? [...rooms, row] : rooms.map((room, at) => at === editing.at ? row : room) });
      hostel.setData(() => next);
      await Promise.all([fees.reload(), onSaved()]);
      setEditing(null);
    } catch (error) { toastError("Not saved", readApiError(error)); }
    finally { setSaving(false); }
  };
  if (hostel.loading || fees.loading) return <SkeletonCard rows={3} />;
  return <View className="gap-4">
    {rooms.length ? <Card padding="p-0">{rooms.map((room, at) => <View className={`gap-2 p-4 ${at ? "border-t border-border" : ""}`} key={room.roomType}>
      <Pressable accessibilityLabel={`Edit ${room.roomType}`} accessibilityRole="button" className="min-h-11 flex-row items-center gap-3" onPress={() => setEditing({ at, bedsPerRoom: String(room.bedsPerRoom), rooms: String(room.rooms), roomType: room.roomType })}>
        <View className="flex-1"><Text variant="label">{room.roomType}</Text><Text variant="caption">{room.bedsPerRoom} {room.bedsPerRoom === 1 ? "bed" : "beds"} a room · {room.rooms} {room.rooms === 1 ? "room" : "rooms"}</Text></View>
        {savedRent(room.roomType) ? null : <Badge label="Not priced" tone="warning" />}
        <Glyph color={colors.mutedForeground} name="create" size={18} />
      </Pressable>
      <Input accessibilityLabel={`${room.roomType} rent`} keyboardType="number-pad" label="Rent (Rs / month)" onChangeText={(text) => setRents((current) => ({ ...current, [room.roomType]: digits(text) }))} placeholder="12000" value={rentOf(room.roomType)} />
    </View>)}</Card> : <Text variant="muted">Add each room type first — single, double, triple — then its monthly rent.</Text>}
    <Button label="+ Add room type" onPress={() => setEditing({ at: null, bedsPerRoom: "1", rooms: "1", roomType: "" })} variant="outline" />
    {rooms.length ? <>
      <Input keyboardType="number-pad" label="Admission fee (optional)" onChangeText={(text) => setAdmission(digits(text))} placeholder="0" value={admissionValue} />
      <Input keyboardType="number-pad" label="Security deposit (optional)" onChangeText={(text) => setDeposit(digits(text))} placeholder="0" value={depositValue} />
    </> : null}
    <Sheet footer={<Button disabled={saving} label={saving ? "Saving…" : "Save room type"} onPress={() => void saveType()} />} onClose={() => setEditing(null)} open={editing !== null} title={editing?.at === null ? "Add room type" : "Edit room type"}>
      {editing ? <View className="gap-4">
        <Input autoCapitalize="words" label="Room type" onChangeText={(roomType) => setEditing({ ...editing, roomType })} placeholder="Double Sharing" value={editing.roomType} />
        {editing.at === null ? <View className="flex-row flex-wrap gap-2">{ROOM_TYPE_OPTIONS.filter((option) => !rooms.some((room) => room.roomType === option)).map((option) => <Pressable accessibilityRole="button" className={`min-h-11 justify-center rounded-xl border px-3 ${editing.roomType === option ? "border-primary bg-brand-soft" : "border-border"}`} key={option} onPress={() => setEditing({ ...editing, bedsPerRoom: String(BEDS_BY_ROOM_TYPE[option] ?? 1), roomType: option })}><Text variant="label">{option}</Text></Pressable>)}</View> : null}
        <Input keyboardType="number-pad" label="Beds a room" onChangeText={(text) => setEditing({ ...editing, bedsPerRoom: digits(text) })} value={editing.bedsPerRoom} />
        <Input keyboardType="number-pad" label="Rooms of this type" onChangeText={(text) => setEditing({ ...editing, rooms: digits(text) })} value={editing.rooms} />
      </View> : null}
    </Sheet>
  </View>;
}

/**
 * The service agreement, read in full on the page and signed at its foot: full
 * name, drawn signature, a tick. The wizard's footer signs it. It can be
 * signed again until it is issued on approval — then it is final, emailed as
 * a PDF, and downloadable here.
 */
function AgreementStep({ onSaved, onSigningChange }: { onSaved: () => Promise<void> | void; onSigningChange: (active: boolean) => void }) {
  const { colors } = useAppTheme();
  const agreement = useResource(getKycAgreement, { cacheKey: "kyc-agreement" });
  const [again, setAgain] = useState(false);
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [agree, setAgree] = useState(false);
  const [saving, setSaving] = useState(false);
  const data = agreement.data;
  const signed = data?.signed && !again ? data.signed : null;
  const save = async () => {
    if (name.trim().length < 2 || !isSignatureComplete(signature) || !agree) {
      toastError("Not signed", "Type your full name, sign in the box and tick that you agree.");
      return false;
    }
    setSaving(true);
    try { await signKycAgreement({ signature, signerName: name.trim() }); await agreement.reload(); await onSaved(); setAgain(false); return true; }
    catch (error) { toastError("Not signed", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty: !signed && Boolean(name.trim() || signature || agree), busy: saving, save });

  if (!data) return agreement.error ? <ErrorState message={agreement.error} onRetry={agreement.reload} /> : <SkeletonCard />;

  return <View className="gap-4">
    <Card className="gap-3">
      <Text variant="subtitle">{data.title}</Text>
      <Text variant="muted">{data.intro}</Text>
      {data.terms.map(section => <View className="gap-1.5" key={section.heading}>
        <Text variant="label">{section.heading}</Text>
        {section.points.map(point => <View className="flex-row gap-2" key={point}><Text variant="body">•</Text><Text className="flex-1" variant="body">{point}</Text></View>)}
      </View>)}
    </Card>
    {signed ? <Card className="gap-3">
      <SignatureInk color={colors.foreground} height={80} strokes={signatureStrokes(signed.signature)} width={240} />
      <Text variant="body">Signed by {signed.signerName} on {new Date(signed.signedAt).toLocaleDateString("en-GB")}</Text>
      {signed.refCode
        ? <Button label={`Download agreement ${signed.refCode}`} onPress={() => void downloadToDevice({ extension: "pdf", fileName: `HostelPalika-Agreement-${signed.refCode!.replace(/\//g, "-")}`, label: "Agreement", mimeType: "application/pdf", url: `${API_BASE_URL}${KYC_AGREEMENT_PDF_PATH}` }).catch(error => toastError("Not downloaded", readApiError(error)))} />
        : <><Text variant="muted">We email you the signed PDF when your KYC is approved.</Text><Button label="Sign again" variant="ghost" onPress={() => setAgain(true)} /></>}
    </Card> : <View className="gap-4">
      <Input autoCapitalize="words" autoComplete="name" label="Your full name" onChangeText={setName} value={name} />
      <SignaturePad onActiveChange={onSigningChange} onChange={setSignature} value={signature} />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: agree }} onPress={() => setAgree(!agree)} className="min-h-12 flex-row items-center gap-3">
        <Glyph name={agree ? "checkmark-circle" : "ellipse"} color={agree ? colors.primary : colors.mutedForeground} size={24} />
        <Text className="flex-1" variant="body">I have read this agreement and I agree to it.</Text>
      </Pressable>
    </View>}
  </View>;
}
