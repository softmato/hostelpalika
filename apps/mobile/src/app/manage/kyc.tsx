import { usePreventRemove } from "expo-router/react-navigation";
import { router, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AgreementStep } from "@/components/kyc/agreement-step";
import { DetailsStep } from "@/components/kyc/details-step";
import { DocumentsStep } from "@/components/kyc/documents-step";
import { FacilitiesStep } from "@/components/kyc/facilities-step";
import { FoodStep } from "@/components/kyc/food-step";
import { LocationStep } from "@/components/kyc/location-step";
import { PhotosStep } from "@/components/kyc/photos-step";
import { RatesStep } from "@/components/kyc/rates-step";
import { RulesStep } from "@/components/kyc/rules-step";
import { LeavePromiseCard } from "@/components/leave-promise-card";
import { KYC_CACHE_KEY, KycRing } from "@/components/manage/kyc-card";
import { KycDraftContext, type KycDraft } from "@/components/manage/kyc-draft";
import { KycPayments } from "@/components/manage/kyc-payments";
import { KycOpeningStep, KycRoomsStep } from "@/components/manage/kyc-setup-steps";
import { PayoutAccountPanel } from "@/components/manage/payout-account-card";
import { StepSkeleton } from "@/components/step-flow";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getHostelKyc, submitHostelKyc, type HostelKyc } from "@/lib/admin-api";
import { readApiError } from "@/lib/api-contract";
import { revalidateSession } from "@/lib/auth-session";
import { openConfirm } from "@/lib/confirm";
import { firstOpenStep, kycChapters, kycOrder, nextOpenStep } from "@/lib/kyc-order";
import { toastError, toastSuccess } from "@/lib/toast";
import { useUnloadGuard } from "@/lib/unload-guard";

/** Title ≤ 3 words, hint ≤ 8 (TODO.md H0). */
const STEPS: Record<string, { hint: string; icon: GlyphName; title: string }> = {
  agreement: { hint: "Read it, then sign at the bottom", icon: "create", title: "Agreement" },
  details: { hint: "Check what the pin filled in", icon: "home", title: "Hostel details" },
  documents: { hint: "To confirm you own this hostel", icon: "document-text", title: "Documents" },
  facilities: { hint: "Tap what you have", icon: "bed", title: "Facilities" },
  food: { hint: "", icon: "restaurant", title: "Food menu" },
  location: { hint: "Put the pin on your door", icon: "location", title: "Map pin" },
  opening: { hint: "Your bank balance when you start", icon: "wallet", title: "Opening balance" },
  payments: { hint: "How residents pay you rent", icon: "cash", title: "Rent payments" },
  payout: { hint: "Where we send booking money", icon: "card", title: "Booking money" },
  photos: { hint: "", icon: "image", title: "Photos" },
  rates: { hint: "Rent and fees for each type", icon: "pricetags", title: "Room types" },
  rooms: { hint: "How many rooms of each type", icon: "business", title: "Rooms & floors" },
  rules: { hint: "", icon: "reader", title: "House rules" },
};

type Mode = { kind: "hub" } | { kind: "review" } | { kind: "step"; key: string };

/**
 * Hostel KYC (TODO.md H1): a checklist hub, one job per step screen, a review
 * before sending, and a status once sent. Steps save on Save & next and on the
 * way back; each step's own file under `components/kyc/` holds its fields.
 */
export default function KycScreen() {
  const kyc = useResource(getHostelKyc, { cacheKey: KYC_CACHE_KEY });
  return <KycFlow resource={kyc} />;
}

function KycFlow({ resource: kyc }: { resource: ReturnType<typeof useResource<HostelKyc>> }) {
  const navigation = useNavigation();
  const [mode, setMode] = useState<Mode>({ kind: "hub" });
  const [saving, setSaving] = useState(false);
  // The signature pad needs the vertical drag; the page stops scrolling while it is held.
  const [signing, setSigning] = useState(false);
  const entries = useRef(new Map<string, KycDraft>());
  const [status, setStatus] = useState({ busy: false, dirty: false });
  const register = useCallback((id: string, draft: KycDraft | null) => {
    if (draft) entries.current.set(id, draft);
    else entries.current.delete(id);
    const values = [...entries.current.values()];
    const dirty = values.some((value) => value.dirty);
    const busy = values.some((value) => value.busy);
    setStatus((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { busy, dirty }));
  }, []);
  const { refresh } = kyc;
  const reload = useCallback(() => refresh(), [refresh]);
  const blocked = saving || status.busy;

  const account = useAppSelector((state) => state.auth.account);
  const reviewStatus = kyc.data?.review?.status ?? null;
  // The frozen menus read `/auth/me`; a decision seen here brings them up to date.
  useEffect(() => {
    if (reviewStatus && account?.hostelKyc && account.hostelKyc.status !== reviewStatus) void revalidateSession();
  }, [reviewStatus, account?.hostelKyc]);

  /** Saves every dirty draft on screen; false when one cannot be saved as it stands. */
  const saveDrafts = async () => {
    setSaving(true);
    try {
      for (const draft of [...entries.current.values()]) {
        if (draft.dirty && !(await draft.save())) return false;
      }
      return true;
    } catch (error) {
      toastError("Not saved", readApiError(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Back from a step: autosave, then the hub. A step that cannot save asks once. */
  const leaveStep = async () => {
    const toHub = () => setMode({ kind: "hub" });
    if (blocked) return;
    if (!status.dirty) return toHub();
    if (await saveDrafts()) {
      await reload();
      return toHub();
    }
    openConfirm({
      cancelLabel: "Keep editing",
      confirmLabel: "Leave",
      destructive: true,
      message: "This change is not saved yet.",
      onConfirm: toHub,
      title: "Leave without saving?",
    });
  };

  // Swipe back and Android back step out of the flow one level at a time.
  usePreventRemove(mode.kind !== "hub" || blocked, ({ data }) => {
    if (blocked) return;
    if (mode.kind === "step") void leaveStep();
    else if (mode.kind === "review") setMode({ kind: "hub" });
    else navigation.dispatch(data.action);
  });
  useUnloadGuard(status.dirty || blocked);

  if (kyc.loading) return <StepSkeleton subtitle="" title="Hostel KYC" total={13} />;
  if (kyc.error || !kyc.data || !kyc.data.steps.length) {
    return (
      <Screen header={<AppBar showBack title="Hostel KYC" />}>
        <ErrorState message={kyc.error ?? "Could not load KYC."} onRetry={kyc.reload} />
      </Screen>
    );
  }

  const data = kyc.data;
  const steps = data.steps;
  const review = data.review ?? null;
  const open = firstOpenStep(steps);
  const openStep = (key: string) => setMode({ kind: "step", key });

  const submit = () => openConfirm({
    cancelLabel: "Check again",
    confirmLabel: "Send",
    message: "Our team checks it within 24 hours.",
    onConfirm: async () => {
      try {
        await submitHostelKyc();
        await reload();
        void revalidateSession();
        setMode({ kind: "hub" });
        toastSuccess("KYC sent", "You can still edit it until it is checked.");
      } catch (error) {
        toastError("Not sent", readApiError(error));
      }
    },
    title: "Send your KYC?",
  });

  return (
    <KycDraftContext.Provider value={register}>
      {mode.kind === "step" ? (
        <StepScreen
          blocked={blocked}
          data={data}
          onBack={() => void leaveStep()}
          onNext={async (skip) => {
            if (blocked) return;
            if (!skip && !(await saveDrafts())) return;
            await reload();
            const next = nextOpenStep(steps, mode.key);
            setMode(next ? { kind: "step", key: next } : { kind: "review" });
          }}
          onSaved={reload}
          onSigningChange={setSigning}
          saving={saving}
          signing={signing}
          stepKey={mode.key}
        />
      ) : mode.kind === "review" ? (
        <ReviewScreen data={data} onBack={() => setMode({ kind: "hub" })} onOpen={openStep} onSubmit={submit} />
      ) : (
        <HubScreen
          data={data}
          onContinue={() => (review?.canSubmit || !open ? setMode({ kind: "review" }) : openStep(open))}
          onOpen={openStep}
          onSubmit={submit}
        />
      )}
    </KycDraftContext.Provider>
  );
}

/** Where a sent KYC stands: Sent → In review → Approved, or why it came back. */
function StatusTrack({ review }: { review: NonNullable<HostelKyc["review"]> }) {
  const { colors } = useAppTheme();
  if (review.status === "REJECTED") {
    return (
      <Card className="flex-row items-center gap-3 border border-destructive/30">
        <Glyph color={colors.destructive} name="alert-circle" size={24} />
        <View className="flex-1">
          <Text variant="label">Sent back</Text>
          <Text variant="caption">{review.note ?? "Fix the steps marked below, then send again."}</Text>
        </View>
      </Card>
    );
  }
  if (review.status === "DRAFT") return null;
  const approved = review.status === "APPROVED";
  const marks = [
    { label: "Sent", state: "done" },
    { label: "In review", state: approved ? "done" : "here" },
    { label: "Approved", state: approved ? "done" : "later" },
  ] as const;
  return (
    <Card className="flex-row items-center">
      {marks.map((mark) => (
        <View className="flex-1 items-center gap-1" key={mark.label}>
          <Glyph
            color={mark.state === "later" ? colors.mutedForeground : colors.primary}
            name={mark.state === "done" ? "checkmark-circle" : mark.state === "here" ? "time" : "ellipse"}
            size={24}
            variant={mark.state === "done" ? "solid" : "line"}
          />
          <Text className={mark.state === "later" ? "" : "text-foreground"} variant="caption">{mark.label}</Text>
        </View>
      ))}
    </Card>
  );
}

function StepIcon({ icon }: { icon: GlyphName }) {
  const { colors } = useAppTheme();
  return (
    <View className="h-10 w-10 items-center justify-center rounded-xl bg-brand-soft">
      <Glyph color={colors.primary} name={icon} size={20} />
    </View>
  );
}

/** A rejected document marks its step until it is added again. */
const sentBack = (data: HostelKyc, key: string) => key === "documents" && data.documents.some((doc) => doc.status === "REJECTED");

function HubScreen({ data, onContinue, onOpen, onSubmit }: { data: HostelKyc; onContinue: () => void; onOpen: (key: string) => void; onSubmit: () => void }) {
  const { colors } = useAppTheme();
  const review = data.review ?? null;
  const done = data.steps.filter((step) => step.done).length;
  const open = firstOpenStep(data.steps);
  const requiredLeft = review?.missing.length ?? 0;
  const line = !review
    ? open ? "Finish the rest any time" : "All done"
    : review.status === "APPROVED"
      ? "Verified"
      : review.status === "SUBMITTED"
        ? "In review · you can still edit"
        : requiredLeft
          ? `${requiredLeft} required left`
          : "Ready to send";
  // Sending is always on this screen: off until the required steps are done, gone once it is sent.
  const sendable = review && (review.status === "DRAFT" || review.status === "REJECTED");
  const footer = sendable ? (
    <View className="gap-2">
      {!review.canSubmit && open ? <Button label="Continue" onPress={onContinue} variant="outline" /> : null}
      <Button disabled={!review.canSubmit} label="Submit KYC" onPress={onSubmit} />
    </View>
  ) : !review && open ? (
    <Button label="Continue" onPress={onContinue} />
  ) : undefined;

  return (
    <Screen
      footer={footer}
      header={<AppBar showBack title="Hostel KYC" />}
      scroll
    >
      <View className="gap-6 pb-4 pt-1">
        <View className="flex-row items-center gap-4">
          <KycRing percent={data.percent} size={64} />
          <View className="flex-1 gap-0.5">
            <Text variant="subtitle">{done} of {data.steps.length} done</Text>
            <Text variant="caption">{line}</Text>
          </View>
        </View>

        {review ? <StatusTrack review={review} /> : null}

        {kycChapters(data.steps).map((chapter) => (
          <View className="gap-2" key={chapter.title}>
            <Text variant="label">{chapter.title}</Text>
            <Card className="px-4" padding="p-0">
              {chapter.steps.map((step, at) => {
                const meta = STEPS[step.key];
                const back = sentBack(data, step.key);
                return (
                  <ListRow
                    className={at ? "border-t border-border" : ""}
                    key={step.key}
                    left={<StepIcon icon={meta?.icon ?? "ellipse"} />}
                    onPress={() => onOpen(step.key)}
                    right={
                      step.done && !back ? (
                        <Glyph color={colors.primary} name="checkmark-circle" size={20} variant="solid" />
                      ) : (
                        <Text className={back ? "text-destructive" : step.required ? "text-foreground" : ""} variant="caption">
                          {back ? "Add again" : step.required || !review ? "To do" : "Optional"}
                        </Text>
                      )
                    }
                    title={meta?.title ?? step.key}
                  />
                );
              })}
            </Card>
          </View>
        ))}
      </View>
    </Screen>
  );
}

function StepScreen({
  blocked,
  data,
  onBack,
  onNext,
  onSaved,
  onSigningChange,
  saving,
  signing,
  stepKey,
}: {
  blocked: boolean;
  data: HostelKyc;
  onBack: () => void;
  onNext: (skip: boolean) => Promise<void>;
  onSaved: () => Promise<void> | void;
  onSigningChange: (active: boolean) => void;
  saving: boolean;
  signing: boolean;
  stepKey: string;
}) {
  const order = kycOrder(data.steps);
  const at = Math.max(0, order.findIndex((step) => step.key === stepKey));
  const step = order[at];
  const meta = STEPS[stepKey];
  const optional = Boolean(data.review) && !step?.required;

  return (
    <Screen
      footer={
        <View className="flex-row gap-2">
          {optional && !step?.done ? <Button disabled={blocked} label="Skip" onPress={() => void onNext(true)} variant="ghost" /> : null}
          <View className="flex-1">
            <Button disabled={blocked && !saving} label="Save & next" loading={saving} onPress={() => void onNext(false)} />
          </View>
        </View>
      }
      header={<AppBar onBack={onBack} showBack subtitle={optional ? "Optional" : undefined} title={meta?.title ?? stepKey} />}
      scroll
      scrollEnabled={!signing}
    >
      <View className="gap-5 pb-4 pt-1">
        <View className="gap-2">
          <View className="h-1 overflow-hidden rounded-full bg-muted">
            <View className="h-full rounded-full bg-primary" style={{ width: `${((at + 1) / order.length) * 100}%` }} />
          </View>
          {meta?.hint ? <Text variant="caption">{meta.hint}</Text> : null}
        </View>
        <View pointerEvents={saving ? "none" : "auto"}>
          <StepBody data={data} onSaved={onSaved} onSigningChange={onSigningChange} stepKey={stepKey} />
        </View>
      </View>
    </Screen>
  );
}

/** The one fact a review row shows for a step. */
function stepFact(data: HostelKyc, key: string, done: boolean) {
  if (!done) return "To do";
  switch (key) {
    case "details":
      return [data.details?.area, data.details?.city].filter(Boolean).join(", ") || "Done";
    case "facilities":
      return `${data.facilities.length} picked`;
    case "photos":
      return `${data.photoCount} photos`;
    case "rules":
      return `${data.rules.length} rules`;
    case "documents":
      return `${data.documents.length} added`;
    default:
      return "Done";
  }
}

function ReviewScreen({ data, onBack, onOpen, onSubmit }: { data: HostelKyc; onBack: () => void; onOpen: (key: string) => void; onSubmit: () => void }) {
  const { colors } = useAppTheme();
  const review = data.review ?? null;
  const missing = review?.missing ?? [];
  const firstMissing = kycOrder(data.steps).find((step) => missing.includes(step.key))?.key;
  const footer = review?.canSubmit ? (
    <Button label="Send" onPress={onSubmit} />
  ) : firstMissing ? (
    <Button label={`Finish ${missing.length} required`} onPress={() => onOpen(firstMissing)} />
  ) : (
    <Button label="Done" onPress={() => router.back()} variant="outline" />
  );

  return (
    <Screen footer={footer} header={<AppBar onBack={onBack} showBack title="Review" />} scroll>
      <View className="gap-6 pb-4 pt-1">
        {kycChapters(data.steps).map((chapter) => (
          <View className="gap-2" key={chapter.title}>
            <Text variant="label">{chapter.title}</Text>
            <Card className="px-4" padding="p-0">
              {chapter.steps.map((step, at) => {
                const need = missing.includes(step.key);
                return (
                  <ListRow
                    className={at ? "border-t border-border" : ""}
                    key={step.key}
                    left={
                      <Glyph
                        color={step.done ? colors.primary : need ? colors.warning : colors.mutedForeground}
                        name={step.done ? "checkmark-circle" : "ellipse"}
                        size={20}
                        variant={step.done ? "solid" : "line"}
                      />
                    }
                    onPress={() => onOpen(step.key)}
                    right={<Text className="font-semibold text-primary" variant="caption">Edit</Text>}
                    subtitle={stepFact(data, step.key, step.done)}
                    title={STEPS[step.key]?.title ?? step.key}
                  />
                );
              })}
            </Card>
          </View>
        ))}
        <LeavePromiseCard />
      </View>
    </Screen>
  );
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
