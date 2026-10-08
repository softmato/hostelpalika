import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { BackHandler, Pressable, View } from "react-native";
import Animated, { FadeIn, ReduceMotion, ZoomIn } from "react-native-reanimated";

import {
  type PinAddress,
  PinPickerModal,
  PinPreview,
  type PinSearchHit,
  useMapLinkReader,
} from "@/components/hostel-pin-picker";
import {
  BranchShortStays,
  bedsFor,
  FacilityChips,
  IconChip,
  PhotoGrid,
  roomTypeOptions,
  RoomTypeEditor,
  RoomTypeRow,
  RulesList,
  type Uploading,
} from "@/components/manage/branch-form-parts";
import { EMPTY_PAYOUT_ACCOUNT } from "@/components/manage/payout-account-card";
import { pickStarters, starterText, withCurrent } from "@/components/registration-sections";
import {
  Accordion,
  FactRows,
  Field,
  FieldHead,
  NumberStepper,
  StepFrame,
  StepSection,
  StepSkeleton,
} from "@/components/step-flow";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Screen } from "@/components/ui/screen";
import { OptionSheet, Select } from "@/components/ui/select";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { WalletMark } from "@/components/ui/wallet-mark";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getBranches, requestBranch } from "@/lib/admin-api";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import type { Coordinates } from "@/lib/geo";
import {
  capacitySummary,
  CITY_OPTIONS,
  emptyRoomRow,
  FACILITY_OPTIONS,
  HOSTEL_TYPES,
  type HostelTypeValue,
  numberValue,
  type RoomRow,
  type ShortStayForm,
} from "@/lib/hostel-registration";
import { BANK_NAMES } from "@/lib/payment-logos";
import { uploadPublicFile } from "@/lib/public-uploads";
import { invalidateQuery } from "@/lib/query-cache";
import { lookupRegistrationLocation } from "@/lib/registration-api";
import { toastError } from "@/lib/toast";

/**
 * "Add a branch" — five steps, a review, and a success screen. It sends the same
 * `branchRequestSchema` body as the web portal's `BranchForm`
 * (`apps/web/src/app/_components/branch-registration-form.tsx`); the phone
 * splits the steps its own way (documents and payout are their own step here),
 * but a field added to one belongs in the other.
 */

const STEPS = [
  { key: "hostel", subtitle: "A familiar name, a fresh start", title: "Your hostel" },
  { key: "location", subtitle: "Put this branch on the map", title: "Location" },
  { key: "rooms", subtitle: "Make room for your residents", title: "Rooms & capacity" },
  { key: "life", subtitle: "Show what makes it home", title: "Life here" },
  { key: "papers", subtitle: "Reuse what we already have", title: "Documents & payout" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

/** The index past the last step. */
const REVIEW = STEPS.length;

const FOOD = [
  { label: "In rent", value: "included" },
  { label: "Extra charge", value: "extra" },
  { label: "No meals", value: "none" },
] as const;

const PROVINCES = ["Koshi", "Madhesh", "Bagmati", "Gandaki", "Lumbini", "Karnali", "Sudurpashchim"] as const;

const DOCUMENT_KINDS = [
  "Ownership proof",
  "Owner ID proof",
  "PAN / VAT document",
  "Hostel license",
  "Bank account details",
  "Rules & policies",
] as const;

const PAYOUT_METHODS = [
  { label: "Bank", value: "BANK" },
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
] as const;

const BANKS = BANK_NAMES.map((name) => ({ label: name, leading: <WalletMark name={name} size={24} square />, value: name }));

type Attachment = { claimToken?: string; fileAssetId?: string; fileName: string; url: string };
type PhotoKind = "EXTERIOR" | "INTERIOR";
type MapField = "address" | "area" | "city" | "province";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (value: string) => value.replace(/\D/g, "");

export default function NewBranchScreen() {
  const branches = useResource(getBranches, { cacheKey: "admin:branch-list" });

  if (branches.loading) {
    return <StepSkeleton bar subtitle={STEPS[0].subtitle} title={STEPS[0].title} total={STEPS.length} />;
  }

  if (branches.error || !branches.data) {
    return (
      <Screen header={<AppBar showBack title="New branch" />}>
        <ErrorState message={branches.error ?? "Could not load"} onRetry={branches.reload} />
      </Screen>
    );
  }

  return <BranchWizard main={branches.data.main} />;
}

function BranchWizard({ main }: { main: { name: string; panNumber: string | null } }) {
  const { colors } = useAppTheme();
  const [index, setIndex] = useState(0);
  const [forward, setForward] = useState(true);
  const [details, setDetails] = useState({
    address: "",
    admissionFee: "",
    alternatePhone: "",
    area: "",
    city: "Kathmandu",
    cookCount: "",
    description: "",
    email: "",
    formFee: "",
    landmark: "",
    mapLink: "",
    mealsPerDay: "3",
    name: main.name,
    panNumber: "",
    phone: "",
    province: "",
    securityDeposit: "",
    totalCapacity: "",
    totalFloors: "1",
    yearEstablished: "",
  });
  const [hostelType, setHostelType] = useState<HostelTypeValue>("CO_LIVING");
  const [pin, setPin] = useState<Coordinates | null>(null);
  const [fromMap, setFromMap] = useState<MapField[]>([]);
  const [picking, setPicking] = useState(false);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [facilities, setFacilities] = useState<string[]>([]);
  const [food, setFood] = useState<(typeof FOOD)[number]["value"]>("included");
  const [hasVeg, setHasVeg] = useState(true);
  const [hasNonVeg, setHasNonVeg] = useState(true);
  const [rules, setRules] = useState<string[]>([]);
  const [shortStays, setShortStays] = useState<ShortStayForm>({ enabled: false, minNights: "1", rates: {} });
  const [photos, setPhotos] = useState<Record<PhotoKind, Attachment[]>>({ EXTERIOR: [], INTERIOR: [] });
  const [uploading, setUploading] = useState<Record<PhotoKind, Uploading[]>>({ EXTERIOR: [], INTERIOR: [] });
  const [reuseDocuments, setReuseDocuments] = useState(true);
  const [documents, setDocuments] = useState<Record<string, Attachment>>({});
  const [documentBusy, setDocumentBusy] = useState<string | null>(null);
  const [payout, setPayout] = useState(EMPTY_PAYOUT_ACCOUNT);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [starters] = useState(() => pickStarters(3));
  const [nextRoom, setNextRoom] = useState(1);
  // Steps where Continue has been pressed — their errors show from then on.
  const [checked, setChecked] = useState<(StepKey | "review")[]>([]);
  const [openFold, setOpenFold] = useState<StepKey | null>(null);
  // Edit on Review sends the owner back here after one step, not through the rest.
  const [fromReview, setFromReview] = useState(false);
  const [picker, setPicker] = useState<"add" | "change" | null>(null);
  const [editor, setEditor] = useState<{ draft: RoomRow; id: string | null } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [roomMenu, setRoomMenu] = useState<RoomRow | null>(null);

  const set = (key: keyof typeof details, value: string) => {
    setDetails((current) => ({ ...current, [key]: value }));
    if ((["address", "area", "city", "province"] as string[]).includes(key)) {
      setFromMap((list) => list.filter((field) => field !== key));
    }
  };

  const summary = capacitySummary(rooms);
  const step = index < REVIEW ? STEPS[index]!.key : null;
  const uploadsRunning = uploading.EXTERIOR.length + uploading.INTERIOR.length > 0 || documentBusy !== null;

  const snapshot = JSON.stringify([details, rooms, facilities, rules, photos, pin, documents, payout]);
  // The form as it opened — anything else is worth asking about before leaving.
  const [start] = useState(snapshot);
  const dirty = snapshot !== start;

  const goTo = (next: number, direction: boolean) => {
    setForward(direction);
    setIndex(next);
  };

  const back = useCallback(() => {
    if (done) return false;
    // Android's back closes the sheet on top before it walks the steps.
    if (picker) {
      setPicker(null);
      return true;
    }
    if (roomMenu) {
      setRoomMenu(null);
      return true;
    }
    if (editorOpen) {
      setEditorOpen(false);
      return true;
    }
    if (index === 0) {
      if (dirty) {
        openConfirm({
          cancelLabel: "Keep editing",
          confirmLabel: "Discard",
          destructive: true,
          message: "What you've entered so far will be lost.",
          onConfirm: () => router.back(),
          title: "Discard this branch?",
        });
      } else {
        router.back();
      }
    } else {
      goTo(index - 1, false);
    }
    return true;
  }, [dirty, done, editorOpen, index, picker, roomMenu]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", back);
    return () => subscription.remove();
  }, [back]);

  const placePin = useCallback((coordinates: Coordinates, address?: PinAddress) => {
    setPin(coordinates);
    // Fills only what the owner left blank — the same rule as the web's picker.
    setDetails((current) => {
      const filled: MapField[] = [];
      const next = { ...current };

      for (const field of ["address", "area", "city", "province"] as const) {
        const found = address?.[field]?.trim();
        const blank = field === "city" ? !current.city.trim() || current.city === "Kathmandu" : !current[field].trim();

        if (found && blank && found !== current[field]) {
          next[field] = found;
          filled.push(field);
        }
      }

      setFromMap((list) => [...new Set([...list, ...filled])]);
      return next;
    });
  }, []);

  const near = [details.address, details.area, details.city].filter((part) => part.trim()).join(", ");
  const mapLink = useMapLinkReader({
    near,
    onChange: (value) => setDetails((current) => ({ ...current, mapLink: value })),
    onPinned: (match) => placePin(match.coordinates, match.address),
    value: details.mapLink,
  });

  /** Every rule a step breaks, keyed by the field it belongs under. */
  function errorsFor(key: StepKey): Partial<Record<string, string>> {
    const errors: Record<string, string> = {};

    if (key === "hostel") {
      if (details.name.trim().length < 2) errors.name = "Add the hostel name.";
      if (details.phone.trim().length < 7) errors.phone = "Add the branch phone.";
      if (details.alternatePhone.trim() && details.alternatePhone.trim().length < 7) errors.alternatePhone = "Check the alternate phone.";
      if (details.email.trim() && !EMAIL.test(details.email.trim())) errors.email = "Check the contact email.";
      if (details.yearEstablished.trim() && !/^\d{4}$/.test(details.yearEstablished.trim())) errors.yearEstablished = "Year established is four digits.";
    }

    if (key === "location") {
      if (details.area.trim().length < 2) errors.area = "Add the area.";
      if (details.city.trim().length < 2) errors.city = "Add the city.";
    }

    if (key === "rooms") {
      const floors = numberValue(details.totalFloors);

      if (floors === undefined || floors > 50) errors.totalFloors = "Add total floors (0–50).";
      if (!rooms.length && !((numberValue(details.totalCapacity) ?? 0) >= 1)) errors.totalCapacity = "Add total capacity, or add room types.";
    }

    if (key === "papers") {
      if (!reuseDocuments && details.panNumber.trim() && !/^\d{9}$/.test(details.panNumber.trim())) errors.panNumber = "A PAN/VAT number is 9 digits.";
      if ((payout.holderName.trim() || payout.bankName.trim() || payout.branch.trim()) && !payout.number.trim()) {
        errors.payoutNumber = "Enter an account number, or clear the payment details to add them later.";
      }
    }

    return errors;
  }

  const firstError = (key: StepKey) => Object.values(errorsFor(key))[0] ?? null;
  const shownErrors = step && checked.includes(step) ? errorsFor(step) : {};

  function advance() {
    if (!step) return;

    if (firstError(step)) {
      setChecked((list) => [...new Set([...list, step])]);
      return;
    }

    if (fromReview || index === REVIEW - 1) {
      setFromReview(false);
      setOpenFold(null);
      goTo(REVIEW, true);
    } else {
      goTo(index + 1, true);
    }
  }

  function payload() {
    const rents = rooms.map((room) => numberValue(room.monthlyRent)).filter((rent): rent is number => rent !== undefined);
    const roomConfigurations = rooms.map((room) => ({
      bedsPerRoom: numberValue(room.bedsPerRoom) ?? 0,
      mealInclusion: room.mealInclusion,
      monthlyRent: numberValue(room.monthlyRent),
      rooms: numberValue(room.rooms) ?? 0,
      roomType: room.roomType.trim(),
      securityDeposit: numberValue(room.securityDeposit ?? "") ?? numberValue(details.securityDeposit),
      vacantBeds: numberValue(room.vacantBeds) ?? 0,
    }));
    const optional = (value: string) => value.trim() || undefined;

    return {
      alternatePhone: optional(details.alternatePhone),
      capacitySummary: rooms.length ? summary : { totalBeds: numberValue(details.totalCapacity) },
      contact: { email: optional(details.email), phone: details.phone.trim() },
      cookCount: numberValue(details.cookCount),
      description: optional(details.description),
      documents: Object.entries(documents).flatMap(([documentType, file]) =>
        file.claimToken && file.fileAssetId ? [{ claimToken: file.claimToken, documentType, fileAssetId: file.fileAssetId }] : [],
      ),
      facilities,
      food: {
        hasNonVeg: food !== "none" && hasNonVeg,
        hasVeg: food !== "none" && hasVeg,
        mealsPerDay: food === "none" ? 0 : numberValue(details.mealsPerDay),
        notes: food === "extra" ? "Meals available at extra charge" : undefined,
      },
      hostelType,
      landmark: optional(details.landmark),
      location: {
        address: optional(details.address),
        area: details.area.trim(),
        city: details.city.trim(),
        province: optional(details.province),
        ...(pin ? { ...pin, locationSource: "MANUAL" as const } : {}),
      },
      mapLink: optional(details.mapLink),
      name: details.name.trim(),
      notes: details.cookCount.trim() ? `Cooks: ${details.cookCount.trim()}` : undefined,
      panNumber: reuseDocuments ? undefined : optional(details.panNumber),
      payoutAccount: payout.number.trim()
        ? { ...payout, holderName: payout.holderName.trim(), number: payout.number.trim() }
        : undefined,
      photos: (["EXTERIOR", "INTERIOR"] as const).flatMap((kind) => photos[kind].map((photo) => ({ kind, url: photo.url }))),
      pricing: {
        admissionFee: numberValue(details.admissionFee),
        currency: "NPR",
        formFee: numberValue(details.formFee),
        monthlyRentMax: rents.length ? Math.max(...rents) : undefined,
        monthlyRentMin: rents.length ? Math.min(...rents) : undefined,
      },
      reuseDocuments,
      roomConfigurations,
      roomTypes: roomConfigurations.map((room) => room.roomType),
      rules: rules.map((rule) => rule.trim()).filter(Boolean),
      securityDeposit: numberValue(details.securityDeposit),
      shortStays: shortStays.enabled
        ? {
            enabled: true,
            minNights: numberValue(shortStays.minNights) ?? 1,
            rates: roomConfigurations
              .map((room) => ({ dailyRate: numberValue(shortStays.rates[room.roomType] ?? "") ?? 0, roomType: room.roomType }))
              .filter((rate) => rate.dailyRate > 0),
          }
        : undefined,
      totalCapacity: rooms.length ? summary.totalBeds : numberValue(details.totalCapacity),
      totalFloors: numberValue(details.totalFloors),
      yearEstablished: optional(details.yearEstablished),
    };
  }

  async function pick(source: "camera" | "library", limit: number) {
    const permission =
      source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError(source === "camera" ? "Camera access needed" : "Photo access needed", "Allow it to attach a file.");
      return [];
    }

    // `quality: 0.7` keeps a phone photo under the public route's 5 MB cap.
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
        : await ImagePicker.launchImageLibraryAsync({
            allowsMultipleSelection: limit > 1,
            mediaTypes: ["images"],
            quality: 0.7,
            selectionLimit: limit,
          });

    return result.canceled ? [] : result.assets.slice(0, limit);
  }

  async function addPhotos(kind: PhotoKind, source: "camera" | "library") {
    const room = 10 - photos[kind].length - uploading[kind].length;

    if (room < 1) return;

    const assets = await pick(source, room);
    const patch = (id: string, change: ((list: Uploading[]) => Uploading[]) | null) =>
      setUploading((current) => ({
        ...current,
        [kind]: change ? change(current[kind]) : current[kind].filter((item) => item.id !== id),
      }));

    await Promise.all(
      assets.map(async (asset) => {
        const id = `${Date.now()}-${asset.uri}`;
        patch(id, (list) => [...list, { fraction: 0, id, uri: asset.uri }]);

        try {
          const uploaded = await uploadPublicFile(asset, {
            label: "Branch photo",
            onProgress: (fraction) => patch(id, (list) => list.map((item) => (item.id === id ? { ...item, fraction } : item))),
            visibility: "public",
          });

          setPhotos((current) => ({ ...current, [kind]: [...current[kind], { fileName: uploaded.fileName, url: uploaded.url }].slice(0, 10) }));
        } catch (error) {
          toastError("That photo didn't upload", readApiError(error));
        } finally {
          patch(id, null);
        }
      }),
    );
  }

  async function attachDocument(kind: string) {
    const [asset] = await pick("library", 1);

    if (!asset) return;

    setDocumentBusy(kind);

    try {
      const uploaded = await uploadPublicFile(asset, { label: kind });

      setDocuments((current) => ({
        ...current,
        [kind]: { claimToken: uploaded.claimToken, fileAssetId: uploaded.fileAssetId, fileName: uploaded.fileName, url: uploaded.url },
      }));
    } catch (error) {
      toastError("That didn't upload", readApiError(error));
    } finally {
      setDocumentBusy(null);
    }
  }

  async function submit() {
    if (uploadsRunning) {
      toastError("Something is still uploading", "Try again in a moment.");
      return;
    }

    const failing = STEPS.findIndex((entry) => firstError(entry.key));

    if (failing >= 0) {
      setChecked((list) => [...new Set([...list, STEPS[failing]!.key])]);
      setFromReview(true);
      goTo(failing, false);
      return;
    }

    if (!confirmed) {
      setChecked((list) => [...new Set([...list, "review" as const])]);
      return;
    }

    setSaving(true);

    try {
      await requestBranch(payload());
      invalidateQuery("admin:branch-list");
      invalidateQuery("admin:branches");
      setDone(true);
    } catch (error) {
      toastError("Could not submit the branch", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  function openEditor(room: RoomRow | null, type?: string) {
    if (room) {
      setEditor({ draft: room, id: room.id });
    } else {
      const draft = emptyRoomRow(`room-${nextRoom}`, type ?? "");
      setNextRoom((value) => value + 1);
      setEditor({ draft: { ...draft, bedsPerRoom: bedsFor(draft.roomType), rooms: "1", vacantBeds: "0" }, id: null });
    }
    setEditorOpen(true);
  }

  if (done) {
    return (
      <Screen footer={<Button label="Back to branches" onPress={() => router.back()} />}>
        <View className="flex-1 items-center justify-center gap-4 px-4" style={{ minHeight: 480 }}>
          <Animated.View
            className="h-20 w-20 items-center justify-center rounded-full bg-primary"
            entering={ZoomIn.springify().reduceMotion(ReduceMotion.System)}
          >
            <Ionicons color={colors.primaryForeground} name="checkmark" size={40} />
          </Animated.View>
          <Animated.View className="items-center gap-2" entering={FadeIn.delay(120).reduceMotion(ReduceMotion.System)}>
            <Text className="text-center" variant="title">
              {details.name.trim()} sent for approval
            </Text>
            <Text className="text-center" variant="muted">
              We will call this branch before it goes live.
            </Text>
          </Animated.View>
        </View>
      </Screen>
    );
  }

  const fromMapTag = (field: MapField) => (fromMap.includes(field) ? <Badge label="From map" tone="success" /> : null);
  const payoutFilled = Boolean(payout.holderName.trim() || payout.bankName.trim() || payout.branch.trim() || payout.number.trim());
  const methodLabel = PAYOUT_METHODS.find((method) => method.value === payout.method)?.label ?? "the wallet";
  const dash = (value: string) => value.trim() || "—";
  const facts: Record<StepKey, [string, string][]> = {
    hostel: [
      ["Name", dash(details.name)],
      ["Phone", dash(details.phone)],
      ["Alternate phone", dash(details.alternatePhone)],
      ["Email", dash(details.email)],
      ["Established", dash(details.yearEstablished)],
      ["For", HOSTEL_TYPES.find((type) => type.value === hostelType)?.label ?? "—"],
    ],
    life: [
      ["Facilities", facilities.length ? facilities.join(", ") : "—"],
      ["Food", FOOD.find((option) => option.value === food)!.label],
      ["Cooks", dash(details.cookCount)],
      ["House rules", String(rules.filter((rule) => rule.trim()).length)],
      ["Photos", String(photos.EXTERIOR.length + photos.INTERIOR.length)],
    ],
    location: [
      ["Address", dash([details.address, details.area, details.city].filter((part) => part.trim()).join(", "))],
      ["Province", dash(details.province)],
      ["Landmark", dash(details.landmark)],
      ["Map pin", pin ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : "Not placed"],
    ],
    papers: [
      ["Documents", reuseDocuments ? `Same as ${main.name}` : `PAN/VAT ${dash(details.panNumber)}`],
      ["Files added", String(Object.keys(documents).length)],
      ["Payout", payout.number.trim() ? `${methodLabel} · ****${payout.number.trim().slice(-4)}` : "Add later"],
    ],
    rooms: [
      ["Floors", dash(details.totalFloors)],
      ["Beds", String(rooms.length ? summary.totalBeds : dash(details.totalCapacity))],
      ["Room types", rooms.length ? String(rooms.length) : "Add later"],
      ["Free beds", String(summary.vacantBeds)],
      ["Admission fee", details.admissionFee ? formatMoney(Number(details.admissionFee)) : "—"],
      ["Short stays", shortStays.enabled ? `From ${shortStays.minNights || 1} nights` : "Off"],
    ],
  };

  const current = index < REVIEW ? STEPS[index]! : null;

  return (
    <>
      <StepFrame
        bar
        barLabel={current ? undefined : "Review"}
        footer={
          current ? (
            <Button label="Continue" onPress={advance} />
          ) : (
            <Button
              className={confirmed ? undefined : "opacity-50"}
              label={saving ? "Submitting…" : "Submit branch for review"}
              loading={saving}
              onPress={() => void submit()}
            />
          )
        }
        forward={forward}
        onBack={back}
        position={Math.min(index + 1, STEPS.length)}
        stepKey={step ?? "review"}
        subtitle={
          step === "rooms" && summary.totalBeds > 0
            ? `${summary.totalRooms} rooms · ${summary.totalBeds} beds · ${summary.vacantBeds} free`
            : (current?.subtitle ?? "One last look before we call")
        }
        title={current?.title ?? "Review & finish"}
        total={STEPS.length}
      >
        {step === "hostel" ? (
          <>
            <StepSection title="Contact">
              <Field error={shownErrors.name} label="Hostel name" maxLength={160} onChangeText={(value) => set("name", value)} required value={details.name} />
              <Field
                error={shownErrors.phone}
                hint="We call this number before the branch goes live"
                keyboardType="phone-pad"
                label="Branch phone"
                maxLength={24}
                onChangeText={(value) => set("phone", value)}
                required
                value={details.phone}
              />
              <Field error={shownErrors.alternatePhone} keyboardType="phone-pad" label="Alternate phone" maxLength={24} onChangeText={(value) => set("alternatePhone", value)} value={details.alternatePhone} />
              <Field autoCapitalize="none" error={shownErrors.email} keyboardType="email-address" label="Contact email" onChangeText={(value) => set("email", value)} value={details.email} />
              <Field error={shownErrors.yearEstablished} inputMode="numeric" label="Year established" maxLength={4} onChangeText={(value) => set("yearEstablished", digits(value))} placeholder="e.g. 2026" value={details.yearEstablished} />
            </StepSection>
            <StepSection title="Listing">
              <View className="gap-2">
                <FieldHead label="Who is this hostel for?" required />
                <ChoiceChips columns={3} onToggle={setHostelType} options={HOSTEL_TYPES} value={hostelType} />
              </View>
              <View className="gap-2">
                <Field
                  label="About this branch"
                  maxLength={2000}
                  multiline
                  onChangeText={(value) => set("description", value)}
                  placeholder="The space, neighbourhood and atmosphere."
                  style={{ minHeight: 104 }}
                  value={details.description}
                  variant="box"
                />
                <ChoiceChips
                  onToggle={(label) => {
                    const starter = starters.find((entry) => entry.label === label);
                    if (starter) set("description", starterText(starter, details.name, hostelType));
                  }}
                  options={starters.map((entry) => ({ label: entry.label, value: entry.label }))}
                  value={starters.find((entry) => starterText(entry, details.name, hostelType) === details.description)?.label ?? null}
                />
                {details.description.length > 1800 ? (
                  <Text className="text-right" variant="caption">{`${details.description.length} / 2000`}</Text>
                ) : null}
              </View>
            </StepSection>
          </>
        ) : null}

        {step === "location" ? (
          <>
            {pin ? (
              <View className="h-48 overflow-hidden rounded-2xl">
                <PinPreview key={`${pin.lat},${pin.lng}`} pin={pin} />
                <Pressable
                  accessibilityLabel="Change the pin"
                  accessibilityRole="button"
                  className="absolute right-3 top-3 rounded-xl bg-card px-3.5 py-2 active:opacity-70"
                  onPress={() => setPicking(true)}
                >
                  <Text className="font-semibold text-primary" variant={null}>
                    Change
                  </Text>
                </Pressable>
                <View className="absolute bottom-6 left-3 rounded-lg bg-card px-2 py-1" style={{ pointerEvents: "none" }}>
                  <Text className="text-xs text-foreground" style={{ fontVariant: ["tabular-nums"] }} variant={null}>
                    {`${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`}
                  </Text>
                </View>
              </View>
            ) : (
              <View className="items-center gap-2 rounded-2xl bg-muted px-6 py-7">
                <Ionicons color={colors.foreground} name="location-outline" size={32} />
                <Text variant="subtitle">Place the pin</Text>
                <Text className="text-center" variant="caption">
                  Add the exact spot so people can find it.
                </Text>
                <Button className="mt-2" label="Place the pin" onPress={() => setPicking(true)} size="sm" />
              </View>
            )}

            <Field aside={fromMapTag("area")} autoCapitalize="words" error={shownErrors.area} label="Area / neighbourhood" maxLength={120} onChangeText={(value) => set("area", value)} required value={details.area} />
            <View className="gap-0.5">
              <FieldHead label="City" required>
                {fromMapTag("city")}
              </FieldHead>
              <Select
                customLabel={(text) => `Use “${text}”`}
                error={shownErrors.city}
                onChange={(value) => set("city", value)}
                options={withCurrent(CITY_OPTIONS)}
                placeholder="Choose a city"
                sheetTitle="City"
                value={details.city}
                variant="line"
              />
            </View>
            <Field aside={fromMapTag("address")} label="Street address" maxLength={240} onChangeText={(value) => set("address", value)} placeholder="e.g. Ward 10, Ganesh Chowk" value={details.address} />
            <Field label="Nearby landmark" maxLength={240} onChangeText={(value) => set("landmark", value)} placeholder="Opposite the campus gate" value={details.landmark} />
            <View className="gap-0.5">
              <FieldHead label="Province">{fromMapTag("province")}</FieldHead>
              <Select
                onChange={(value) => set("province", value)}
                options={withCurrent(PROVINCES, details.province)}
                placeholder="Select province"
                sheetTitle="Province"
                value={details.province || null}
                variant="line"
              />
            </View>
            <Field
              autoCapitalize="none"
              autoCorrect={false}
              error={mapLink.status?.error ? mapLink.status.text : undefined}
              hint={mapLink.status?.text}
              keyboardType="url"
              label="Google Maps link"
              maxLength={500}
              onChangeText={mapLink.onChangeText}
              onEndEditing={mapLink.onEndEditing}
              placeholder="https://maps.app.goo.gl/…"
              value={details.mapLink}
            />
          </>
        ) : null}

        {step === "rooms" ? (
          <>
            <StepSection title="Building">
              <View className="flex-row gap-5">
                <View className="gap-2">
                  <FieldHead label="Total floors" required />
                  <NumberStepper error={Boolean(shownErrors.totalFloors)} label="Total floors" max={50} onChange={(value) => set("totalFloors", value)} value={details.totalFloors} />
                </View>
                <View className="flex-1">
                  <Field
                    editable={rooms.length === 0}
                    inputMode="numeric"
                    label="Total capacity (beds)"
                    onChangeText={(value) => set("totalCapacity", digits(value))}
                    placeholder="e.g. 30"
                    required={rooms.length === 0}
                    trailing={rooms.length ? <Badge label="From your rooms" /> : undefined}
                    value={rooms.length ? String(summary.totalBeds) : details.totalCapacity}
                  />
                </View>
              </View>
              {shownErrors.totalFloors || shownErrors.totalCapacity ? (
                <Text className="-mt-2 text-destructive" variant="caption">
                  {shownErrors.totalFloors ?? shownErrors.totalCapacity}
                </Text>
              ) : null}
            </StepSection>

            <StepSection title="Fees">
              <View className="flex-row gap-4">
                <View className="flex-1">
                  <Field inputMode="numeric" label="Admission fee" leading={<Text variant="muted">Rs</Text>} onChangeText={(value) => set("admissionFee", digits(value))} placeholder="0" value={details.admissionFee} />
                </View>
                <View className="flex-1">
                  <Field inputMode="numeric" label="Form fee" leading={<Text variant="muted">Rs</Text>} onChangeText={(value) => set("formFee", digits(value))} placeholder="0" value={details.formFee} />
                </View>
              </View>
              <Field
                hint="Used for any room type without its own deposit."
                inputMode="numeric"
                label="Security deposit"
                leading={<Text variant="muted">Rs</Text>}
                maxLength={7}
                onChangeText={(value) => set("securityDeposit", digits(value))}
                placeholder="0"
                value={details.securityDeposit}
              />
            </StepSection>

            <StepSection caption={rooms.length ? undefined : "Add each kind of room you have"} title="Room types">
              <View>
                {rooms.map((room) => (
                  <RoomTypeRow key={room.id} onMore={() => setRoomMenu(room)} onPress={() => openEditor(room)} room={room} />
                ))}
              </View>
              {rooms.length < 30 ? (
                <Pressable
                  accessibilityRole="button"
                  className="min-h-14 flex-row items-center justify-center gap-2 rounded-2xl border border-dashed border-primary active:bg-muted"
                  onPress={() => setPicker("add")}
                >
                  <Ionicons color={colors.primary} name="add" size={20} />
                  <Text className="font-semibold text-primary" variant={null}>
                    Add room type
                  </Text>
                </Pressable>
              ) : null}
            </StepSection>

            <BranchShortStays onChange={setShortStays} rooms={rooms} value={shortStays} />
          </>
        ) : null}

        {step === "life" ? (
          <>
            <StepSection title="Facilities">
              <FacilityChips onChange={setFacilities} options={FACILITY_OPTIONS} value={facilities} />
            </StepSection>

            <StepSection title="Food">
              <ChoiceChips columns={3} onToggle={setFood} options={FOOD} value={food} />
              {food !== "none" ? (
                <View className="flex-row items-end gap-4">
                  <View className="flex-1 gap-2">
                    <FieldHead label="Meals served" />
                    <View className="flex-row flex-wrap gap-2">
                      {/* One of the two always stays on: a kitchen serves something. */}
                      <IconChip icon="leaf-outline" label="Veg" on={hasVeg} onPress={() => (hasNonVeg || !hasVeg ? setHasVeg(!hasVeg) : null)} />
                      <IconChip icon="restaurant-outline" label="Non-veg" on={hasNonVeg} onPress={() => (hasVeg || !hasNonVeg ? setHasNonVeg(!hasNonVeg) : null)} />
                    </View>
                  </View>
                  <View className="gap-2">
                    <FieldHead label="Meals per day" />
                    <NumberStepper label="Meals per day" max={6} onChange={(value) => set("mealsPerDay", value)} value={details.mealsPerDay} />
                  </View>
                </View>
              ) : null}
              <View className="flex-row items-center gap-3">
                <Text className="flex-1 text-sm text-muted-foreground" variant={null}>
                  Number of cooks
                </Text>
                <NumberStepper label="Number of cooks" max={100} onChange={(value) => set("cookCount", value)} value={details.cookCount} />
              </View>
            </StepSection>

            <StepSection title="House rules">
              <RulesList onChange={setRules} rules={rules} />
            </StepSection>

            <StepSection caption="The first one is this branch's cover photo." title="Exterior photos">
              <PhotoGrid
                cover
                onAdd={(source) => void addPhotos("EXTERIOR", source)}
                onRemove={(url) => setPhotos((list) => ({ ...list, EXTERIOR: list.EXTERIOR.filter((photo) => photo.url !== url) }))}
                photos={photos.EXTERIOR}
                uploading={uploading.EXTERIOR}
              />
            </StepSection>
            <StepSection title="Rooms & interior">
              <PhotoGrid
                onAdd={(source) => void addPhotos("INTERIOR", source)}
                onRemove={(url) => setPhotos((list) => ({ ...list, INTERIOR: list.INTERIOR.filter((photo) => photo.url !== url) }))}
                photos={photos.INTERIOR}
                uploading={uploading.INTERIOR}
              />
            </StepSection>
          </>
        ) : null}

        {step === "papers" ? (
          <>
            <View className="flex-row items-center gap-3">
              <View className="flex-1 gap-0.5">
                <Text variant="label">Use the same business documents</Text>
                <Text variant="caption">{`From ${main.name} · PAN/VAT ${main.panNumber ?? "not added yet"}`}</Text>
              </View>
              <Toggle accessibilityLabel="Use the same business documents" onChange={setReuseDocuments} value={reuseDocuments} />
            </View>
            {reuseDocuments ? null : (
              <Field error={shownErrors.panNumber} inputMode="numeric" label="Branch PAN/VAT" maxLength={9} onChangeText={(value) => set("panNumber", digits(value))} value={details.panNumber} />
            )}

            <Accordion caption="Optional" title="Add or replace documents">
              <View>
                {DOCUMENT_KINDS.map((kind) => {
                  const file = documents[kind];

                  return (
                    <Pressable
                      accessibilityHint={file ? "Replace this file" : "Upload a file"}
                      accessibilityRole="button"
                      className="min-h-14 flex-row items-center gap-3 border-b border-border py-2 active:opacity-70"
                      disabled={documentBusy !== null}
                      key={kind}
                      onPress={() => void attachDocument(kind)}
                    >
                      <Ionicons color={file ? colors.primary : colors.mutedForeground} name={file ? "document-attach" : "document-outline"} size={20} />
                      <View className="flex-1">
                        <Text variant="label">{kind}</Text>
                        {file ? <Text numberOfLines={1} variant="caption">{file.fileName}</Text> : null}
                      </View>
                      {documentBusy === kind ? (
                        <Text variant="caption">Uploading…</Text>
                      ) : file ? (
                        <Pressable
                          accessibilityLabel={`Remove ${kind}`}
                          accessibilityRole="button"
                          hitSlop={10}
                          onPress={() =>
                            setDocuments((list) => {
                              const { [kind]: _removed, ...rest } = list;
                              return rest;
                            })
                          }
                        >
                          <Ionicons color={colors.mutedForeground} name="close" size={20} />
                        </Pressable>
                      ) : (
                        <Text className="font-semibold text-primary" variant={null}>
                          Upload
                        </Text>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </Accordion>

            <StepSection
              action={
                payoutFilled ? (
                  <Pressable accessibilityRole="button" hitSlop={10} onPress={() => setPayout(EMPTY_PAYOUT_ACCOUNT)}>
                    <Text className="font-semibold text-primary" variant={null}>
                      Clear
                    </Text>
                  </Pressable>
                ) : undefined
              }
              caption="Where this branch's booking money goes. You can add it later."
              title="Branch payout account"
            >
              <ChoiceChips columns={3} onToggle={(method) => setPayout((value) => ({ ...value, method }))} options={PAYOUT_METHODS} value={payout.method} />
              <Field label="Name on the account" onChangeText={(holderName) => setPayout((value) => ({ ...value, holderName }))} value={payout.holderName} />
              {payout.method === "BANK" ? (
                <>
                  <View className="gap-0.5">
                    <FieldHead label="Bank" />
                    <Select
                      customLabel={(text) => `Use “${text}”`}
                      onChange={(bankName) => setPayout((value) => ({ ...value, bankName }))}
                      options={BANKS}
                      placeholder="Choose a bank"
                      sheetTitle="Bank"
                      value={payout.bankName || null}
                      variant="line"
                    />
                  </View>
                  <Field label="Branch (optional)" onChangeText={(branch) => setPayout((value) => ({ ...value, branch }))} value={payout.branch} />
                </>
              ) : null}
              <Field
                error={shownErrors.payoutNumber}
                inputMode={payout.method === "BANK" ? "numeric" : "tel"}
                label={payout.method === "BANK" ? "Account number" : `Mobile number on ${methodLabel}`}
                onChangeText={(number) => setPayout((value) => ({ ...value, number }))}
                value={payout.number}
              />
            </StepSection>
          </>
        ) : null}

        {step === null ? (
          <View className="gap-5">
            <View>
              {STEPS.map((entry, position) => {
                const problem = firstError(entry.key);
                const open = openFold === entry.key || problem !== null;

                return (
                  <View className={position ? "border-t border-border" : undefined} key={entry.key}>
                    <View className="min-h-14 flex-row items-center gap-3">
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                        className="flex-1 flex-row items-center gap-3 py-3 active:opacity-70"
                        onPress={() => setOpenFold(openFold === entry.key ? null : entry.key)}
                      >
                        <Text className="flex-1" variant="label">{`${position + 1}. ${entry.title}`}</Text>
                        {problem ? (
                          <View className="flex-row items-center gap-1">
                            <Ionicons color={colors.warning} name="alert-circle" size={18} />
                            <Text className="text-warning" variant="caption">
                              Needs a fix
                            </Text>
                          </View>
                        ) : (
                          <Ionicons accessibilityLabel="Complete" color={colors.primary} name="checkmark" size={20} />
                        )}
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Edit ${entry.title}`}
                        accessibilityRole="button"
                        hitSlop={10}
                        onPress={() => {
                          setFromReview(true);
                          goTo(position, false);
                        }}
                      >
                        <Text className="font-semibold text-primary" variant={null}>
                          Edit
                        </Text>
                      </Pressable>
                    </View>
                    {open ? (
                      <Animated.View className="gap-2 pb-4" entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}>
                        <FactRows facts={facts[entry.key]} />
                        {problem ? (
                          <View className="flex-row items-center gap-1.5 pt-1">
                            <Ionicons color={colors.destructive} name="alert-circle" size={16} />
                            <Text className="flex-1 text-destructive" variant="caption">
                              {problem}
                            </Text>
                          </View>
                        ) : null}
                      </Animated.View>
                    ) : null}
                  </View>
                );
              })}
            </View>

            <Text variant="muted">
              We will call{" "}
              <Text className="font-semibold text-foreground" variant={null}>
                {details.phone.trim() || "the branch"}
              </Text>{" "}
              before this branch goes live.
            </Text>

            <View className="gap-1.5">
              <View className="flex-row items-center gap-3 border-t border-border pt-4">
                <View className="flex-1 gap-0.5">
                  <Text variant="label">I confirm</Text>
                  <Text variant="caption">These details and any reused documents apply to this branch.</Text>
                </View>
                <Toggle accessibilityLabel="Confirm branch details" onChange={setConfirmed} value={confirmed} />
              </View>
              {checked.includes("review") && !confirmed ? (
                <Text className="text-destructive" variant="caption">
                  Confirm the branch details before submitting.
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
      </StepFrame>

      <PinPickerModal<PinSearchHit & { address?: PinAddress }>
        initial={pin}
        onClose={() => setPicking(false)}
        onPick={(spot) => {
          setPicking(false);
          const coordinates = { lat: spot.lat, lng: spot.lng };

          if (spot.hit?.address) {
            placePin(coordinates, spot.hit.address);
          } else {
            placePin(coordinates);
            void lookupRegistrationLocation(coordinates)
              .then(([match]) => (match?.address ? placePin(coordinates, match.address) : undefined))
              .catch(() => undefined);
          }
        }}
        open={picking}
        search={async (query) =>
          (await lookupRegistrationLocation({ near, q: query })).map((match) => ({
            ...match.coordinates,
            address: match.address,
            displayName: match.label,
          }))
        }
      />

      <OptionSheet
        customLabel={(text) => `Use “${text.slice(0, 80)}” as a room type`}
        onChoose={(type) => {
          if (picker === "change") {
            setEditor((current) => current && { ...current, draft: { ...current.draft, bedsPerRoom: bedsFor(type) || current.draft.bedsPerRoom, roomType: type } });
          } else {
            openEditor(null, type);
          }
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
        onCustom={(text) => {
          const type = text.slice(0, 80);
          if (picker === "change") setEditor((current) => current && { ...current, draft: { ...current.draft, roomType: type } });
          else openEditor(null, type);
          setPicker(null);
        }}
        open={picker !== null}
        options={roomTypeOptions(rooms, picker === "change" ? (editor?.id ?? null) : null)}
        searchable
        searchPlaceholder="Search room types"
        title="Room type"
        value={picker === "change" ? editor?.draft.roomType : null}
      />

      <RoomTypeEditor
        draft={editor?.draft ?? null}
        isNew={editor?.id === null}
        onChange={(next) => setEditor((current) => current && { ...current, draft: { ...current.draft, ...next } })}
        onClose={() => setEditorOpen(false)}
        onPickType={() => setPicker("change")}
        onSave={() => {
          if (!editor) return;
          const draft = { ...editor.draft, roomType: editor.draft.roomType.trim() };
          setRooms((list) => (editor.id ? list.map((room) => (room.id === editor.id ? draft : room)) : [...list, draft]));
          setEditorOpen(false);
        }}
        open={editorOpen}
        others={rooms}
      />

      <Sheet bare onClose={() => setRoomMenu(null)} open={roomMenu !== null} title={roomMenu?.roomType}>
        <View className="pb-2">
          <SheetRow
            label="Edit"
            leading={<Ionicons color={colors.foreground} name="create-outline" size={20} />}
            onPress={() => {
              const room = roomMenu;
              setRoomMenu(null);
              if (room) openEditor(room);
            }}
          />
          <SheetRow
            label="Remove"
            leading={<Ionicons color={colors.destructive} name="trash-outline" size={20} />}
            onPress={() => {
              const room = roomMenu;
              setRoomMenu(null);
              if (room) setRooms((list) => list.filter((item) => item.id !== room.id));
            }}
          />
        </View>
      </Sheet>

    </>
  );
}
