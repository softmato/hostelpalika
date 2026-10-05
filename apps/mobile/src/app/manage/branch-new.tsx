import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { Camera, Images, Plus } from "lucide-react-native";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { MapLinkField, type PinAddress } from "@/components/hostel-pin-picker";
import {
  EMPTY_PAYOUT_ACCOUNT,
  RegistrationPayoutFields,
} from "@/components/manage/payout-account-card";
import { PhotoStrip, UploadPreview } from "@/components/registration-form";
import {
  CustomFacility,
  pickStarters,
  RoomSection,
  ShortStaysSection,
  starterText,
  withCurrent,
} from "@/components/registration-sections";
import {
  Accordion,
  FactRows,
  ReviewFold,
  StepFrame,
  StepSection,
  StepSkeleton,
} from "@/components/step-flow";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { getBranches, requestBranch } from "@/lib/admin-api";
import { readApiError } from "@/lib/api-contract";
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
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * "Set up your new branch" — the web portal's `BranchForm`
 * (`apps/web/src/app/_components/branch-registration-form.tsx`) on the phone:
 * the same five steps, the same fields in the same steps, and the same
 * `branchRequestSchema` body. Change one, change the other.
 */

const STEPS = [
  { key: "hostel", subtitle: "A familiar name, a fresh start", title: "Your hostel" },
  { key: "location", subtitle: "Put this branch on the map", title: "Location" },
  { key: "rooms", subtitle: "Make room for your residents", title: "Rooms & capacity" },
  { key: "life", subtitle: "Show what makes it home", title: "Life here" },
  { key: "review", subtitle: "One last look before we call", title: "Review & finish" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

const REVIEW = STEPS.length - 1;

const FOOD = [
  { label: "In rent", value: "included" },
  { label: "Extra charge", value: "extra" },
  { label: "No meals", value: "none" },
] as const;

const MEALS_SERVED = [
  { label: "Veg", value: "veg" },
  { label: "Non-veg", value: "nonVeg" },
] as const;

const DOCUMENT_KINDS = [
  "Ownership proof",
  "Owner ID proof",
  "PAN / VAT document",
  "Hostel license",
  "Bank account details",
  "Rules & policies",
] as const;

type Attachment = { claimToken?: string; fileAssetId?: string; fileName: string; url: string };
type PhotoKind = "EXTERIOR" | "INTERIOR";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function NewBranchScreen() {
  const branches = useResource(getBranches, { cacheKey: "admin:branch-list" });

  if (branches.loading) {
    return <StepSkeleton subtitle={STEPS[0].subtitle} title={STEPS[0].title} total={STEPS.length} />;
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
    rules: "",
    securityDeposit: "",
    totalCapacity: "",
    totalFloors: "",
    yearEstablished: "",
  });
  const [hostelType, setHostelType] = useState<HostelTypeValue>("CO_LIVING");
  const [pin, setPin] = useState<Coordinates | null>(null);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [facilities, setFacilities] = useState<string[]>([]);
  const [food, setFood] = useState<(typeof FOOD)[number]["value"]>("included");
  const [hasVeg, setHasVeg] = useState(true);
  const [hasNonVeg, setHasNonVeg] = useState(true);
  const [shortStays, setShortStays] = useState<ShortStayForm>({ enabled: false, minNights: "1", rates: {} });
  const [photos, setPhotos] = useState<Record<PhotoKind, Attachment[]>>({ EXTERIOR: [], INTERIOR: [] });
  const [reuseDocuments, setReuseDocuments] = useState(true);
  const [documents, setDocuments] = useState<Record<string, Attachment>>({});
  const [payout, setPayout] = useState(EMPTY_PAYOUT_ACCOUNT);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starters] = useState(() => pickStarters(3));
  const [nextRoom, setNextRoom] = useState(1);
  const [openFold, setOpenFold] = useState<StepKey | null>(null);

  const set = (key: keyof typeof details, value: string) =>
    setDetails((current) => ({ ...current, [key]: value }));

  const summary = capacitySummary(rooms);
  const step = STEPS[index]!.key;

  const goTo = (next: number, direction: boolean) => {
    setForward(direction);
    setIndex(next);
  };

  const placePin = useCallback((coordinates: Coordinates, address?: PinAddress) => {
    setPin(coordinates);
    // Fills what the owner left blank — the same rule as web's picker.
    setDetails((current) => ({
      ...current,
      address: current.address.trim() ? current.address : (address?.address ?? current.address),
      area: current.area.trim() ? current.area : (address?.area ?? current.area),
      city: address?.city && !current.city.trim() ? address.city : current.city,
      province: current.province.trim() ? current.province : (address?.province ?? current.province),
    }));
  }, []);

  /** What blocks leaving `key` — the web's HTML `required`s plus `branchRequestSchema`. */
  function problem(key: StepKey): string | null {
    if (key === "hostel") {
      if (details.name.trim().length < 2) return "Add the hostel name.";
      if (details.phone.trim().length < 7) return "Add the branch phone.";
      if (details.alternatePhone.trim() && details.alternatePhone.trim().length < 7) return "Check the alternate phone.";
      if (details.email.trim() && !EMAIL.test(details.email.trim())) return "Check the contact email.";
      if (details.yearEstablished.trim() && !/^\d{4}$/.test(details.yearEstablished.trim())) return "Year established is four digits.";
    }

    if (key === "location") {
      if (details.area.trim().length < 2) return "Add the area.";
      if (details.city.trim().length < 2) return "Add the city.";
    }

    if (key === "rooms") {
      const floors = numberValue(details.totalFloors);

      if (floors === undefined || floors > 50) return "Add total floors (0–50).";
      if (!rooms.length && !((numberValue(details.totalCapacity) ?? 0) >= 1)) return "Add total capacity, or add room types.";

      const seen = new Set<string>();

      for (const [position, room] of rooms.entries()) {
        const label = `Room type ${position + 1}`;
        const count = numberValue(room.rooms) ?? 0;
        const beds = numberValue(room.bedsPerRoom) ?? 0;

        if (!room.roomType.trim()) return `${label}: pick a type.`;
        if (seen.has(room.roomType.trim().toLowerCase())) return `${label}: use each room type only once.`;
        seen.add(room.roomType.trim().toLowerCase());
        if (count < 1 || beds < 1) return `${label}: enter positive room and bed counts.`;
        if ((numberValue(room.vacantBeds) ?? 0) > count * beds) return `${label}: vacant beds cannot exceed capacity.`;
      }
    }

    if (key === "review") {
      if (!reuseDocuments && details.panNumber.trim() && !/^\d{9}$/.test(details.panNumber.trim())) return "A PAN/VAT number is 9 digits.";
      if ((payout.holderName.trim() || payout.bankName.trim() || payout.branch.trim()) && !payout.number.trim()) {
        return "Enter an account number, or clear the payment details to add them later.";
      }
      if (!confirmed) return "Confirm the branch details before submitting.";
    }

    return null;
  }

  function payload() {
    const rents = rooms
      .map((room) => numberValue(room.monthlyRent))
      .filter((rent): rent is number => rent !== undefined);
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
      documents: reuseDocumentsList(),
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
      photos: (["EXTERIOR", "INTERIOR"] as const).flatMap((kind) =>
        photos[kind].map((photo) => ({ kind, url: photo.url })),
      ),
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
      rules: details.rules
        .split(/\r?\n/)
        .map((rule) => rule.trim())
        .filter(Boolean),
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

  function reuseDocumentsList() {
    return Object.entries(documents).flatMap(([documentType, file]) =>
      file.claimToken && file.fileAssetId
        ? [{ claimToken: file.claimToken, documentType, fileAssetId: file.fileAssetId }]
        : [],
    );
  }

  async function pick(source: "camera" | "library") {
    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError(source === "camera" ? "Camera access needed" : "Photo access needed", "Allow it to attach a file.");
      return null;
    }

    // `quality: 0.7` keeps a phone photo under the public route's 5 MB cap.
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7 });

    return result.canceled ? null : (result.assets[0] ?? null);
  }

  async function addPhoto(kind: PhotoKind, source: "camera" | "library") {
    const asset = await pick(source);

    if (!asset) return;

    setBusy(`${kind}-${source}`);

    try {
      const uploaded = await uploadPublicFile(asset, { label: "Branch photo", visibility: "public" });

      setPhotos((current) => ({
        ...current,
        [kind]: [...current[kind], { fileName: uploaded.fileName, url: uploaded.url }].slice(0, 10),
      }));
    } catch (error) {
      toastError("That photo didn't upload", readApiError(error));
    } finally {
      setBusy(null);
    }
  }

  async function attachDocument(kind: string) {
    const asset = await pick("library");

    if (!asset) return;

    setBusy(kind);

    try {
      const uploaded = await uploadPublicFile(asset, { label: kind });

      setDocuments((current) => ({
        ...current,
        [kind]: {
          claimToken: uploaded.claimToken,
          fileAssetId: uploaded.fileAssetId,
          fileName: uploaded.fileName,
          url: uploaded.url,
        },
      }));
    } catch (error) {
      toastError("That didn't upload", readApiError(error));
    } finally {
      setBusy(null);
    }
  }

  function advance() {
    const issue = problem(step);

    if (issue) {
      toastError("Check this step", issue);
      return;
    }

    goTo(Math.min(REVIEW, index + 1), true);
  }

  async function submit() {
    if (busy) {
      toastError("Something is still uploading", "Try again in a moment.");
      return;
    }

    const failing = STEPS.find((entry) => problem(entry.key));

    if (failing) {
      toastError("Check this step", problem(failing.key)!);
      if (failing.key !== "review") goTo(STEPS.indexOf(failing), false);
      return;
    }

    setSaving(true);

    try {
      await requestBranch(payload());
      toastSuccess(`${details.name.trim()} sent for approval`, "We will call this branch before it goes live.");
      router.back();
    } catch (error) {
      toastError("Could not submit the branch", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  const photoButtons = (kind: PhotoKind) => (
    <>
      <PhotoStrip
        onRemove={(url) =>
          setPhotos((current) => ({ ...current, [kind]: current[kind].filter((photo) => photo.url !== url) }))
        }
        photos={photos[kind]}
      />
      <View className="flex-row gap-2">
        {(["camera", "library"] as const).map((source) => (
          <View key={source} style={{ flex: 1 }}>
            <Button
              disabled={busy !== null || photos[kind].length >= 10}
              icon={source === "camera" ? Camera : Images}
              label={source === "camera" ? "Take photo" : "Gallery"}
              loading={busy === `${kind}-${source}`}
              onPress={() => void addPhoto(kind, source)}
              size="sm"
              variant="outline"
            />
          </View>
        ))}
      </View>
    </>
  );

  const dash = (value: string) => value.trim() || "—";
  const facts: Record<Exclude<StepKey, "review">, [string, string][]> = {
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
      ["Photos", String(photos.EXTERIOR.length + photos.INTERIOR.length)],
    ],
    location: [
      ["Address", dash([details.address, details.area, details.city].filter((part) => part.trim()).join(", "))],
      ["Landmark", dash(details.landmark)],
      ["Map pin", pin ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : "Not placed"],
    ],
    rooms: [
      ["Beds", String(rooms.length ? summary.totalBeds : dash(details.totalCapacity))],
      ["Floors", dash(details.totalFloors)],
      ["Rooms", rooms.length ? String(summary.totalRooms) : "Add later"],
      ["Vacant", String(summary.vacantBeds)],
    ],
  };

  const current = STEPS[index]!;

  return (
    <StepFrame
      footer={
        <Button
          className={step === "review" && !confirmed ? "opacity-50" : undefined}
          label={step === "review" ? "Submit branch for review" : "Continue"}
          loading={saving}
          onPress={step === "review" ? () => void submit() : advance}
        />
      }
      forward={forward}
      onBack={() => (index === 0 ? router.back() : goTo(index - 1, false))}
      position={index + 1}
      stepKey={step}
      subtitle={
        step === "rooms" && summary.totalBeds > 0
          ? `${summary.totalRooms} rooms · ${summary.totalBeds} beds · ${summary.vacantBeds} vacant`
          : current.subtitle
      }
      title={current.title}
      total={STEPS.length}
    >
      {step === "hostel" ? (
        <>
          <Input label="Hostel name *" onChangeText={(value) => set("name", value)} value={details.name} variant="line" />
          <Input keyboardType="phone-pad" label="Branch phone *" onChangeText={(value) => set("phone", value)} value={details.phone} variant="line" />
          <Input keyboardType="phone-pad" label="Alternate phone" onChangeText={(value) => set("alternatePhone", value)} value={details.alternatePhone} variant="line" />
          <Input autoCapitalize="none" keyboardType="email-address" label="Contact email" onChangeText={(value) => set("email", value)} value={details.email} variant="line" />
          <Input inputMode="numeric" label="Year established" maxLength={4} onChangeText={(value) => set("yearEstablished", value)} placeholder="e.g. 2026" value={details.yearEstablished} variant="line" />
          <ChoiceChips columns={3} label="Who is this hostel for?" onToggle={setHostelType} options={HOSTEL_TYPES} value={hostelType} />
          <Input
            label="About this branch"
            multiline
            onChangeText={(value) => set("description", value)}
            placeholder="The space, neighbourhood and atmosphere."
            value={details.description}
            variant="line"
          />
          <ChoiceChips
            onToggle={(label) => {
              const starter = starters.find((entry) => entry.label === label);

              if (starter) set("description", starterText(starter, details.name, hostelType));
            }}
            options={starters.map((entry) => ({ label: entry.label, value: entry.label }))}
            value={starters.find((entry) => starterText(entry, details.name, hostelType) === details.description)?.label ?? null}
          />
        </>
      ) : null}

      {step === "location" ? (
        <>
          <Input autoCapitalize="words" label="Area / neighbourhood *" onChangeText={(value) => set("area", value)} value={details.area} variant="line" />
          <View className="gap-3">
            <Input autoCapitalize="words" label="City *" onChangeText={(value) => set("city", value)} value={details.city} variant="line" />
            <ChoiceChips onToggle={(value) => set("city", value)} options={withCurrent(CITY_OPTIONS)} value={details.city} />
          </View>
          <Input label="Street address" onChangeText={(value) => set("address", value)} value={details.address} variant="line" />
          <Input label="Nearby landmark" onChangeText={(value) => set("landmark", value)} value={details.landmark} variant="line" />
          <Input label="Province" onChangeText={(value) => set("province", value)} value={details.province} variant="line" />
          <MapLinkField
            near={[details.address, details.area, details.city].filter((part) => part.trim()).join(", ")}
            onChange={(value) => {
              set("mapLink", value);
              if (!value.trim()) setPin(null);
            }}
            onPinned={(match) => placePin(match.coordinates, match.address)}
            pin={pin}
            value={details.mapLink}
          />
        </>
      ) : null}

      {step === "rooms" ? (
        <>
          <View className="flex-row gap-4">
            <View style={{ flex: 1 }}>
              <Input inputMode="numeric" label="Total floors *" onChangeText={(value) => set("totalFloors", value)} value={details.totalFloors} variant="line" />
            </View>
            <View style={{ flex: 1 }}>
              <Input
                editable={rooms.length === 0}
                hint={rooms.length ? "From your rooms" : undefined}
                inputMode="numeric"
                label="Total capacity (beds) *"
                onChangeText={(value) => set("totalCapacity", value)}
                value={rooms.length ? String(summary.totalBeds) : details.totalCapacity}
                variant="line"
              />
            </View>
          </View>
          <View className="flex-row gap-4">
            <View style={{ flex: 1 }}>
              <Input inputMode="numeric" label="Admission fee (NPR)" onChangeText={(value) => set("admissionFee", value)} value={details.admissionFee} variant="line" />
            </View>
            <View style={{ flex: 1 }}>
              <Input inputMode="numeric" label="Form fee (NPR)" onChangeText={(value) => set("formFee", value)} value={details.formFee} variant="line" />
            </View>
          </View>
          <Input
            hint="Used for any room type without its own deposit."
            inputMode="numeric"
            label="Security deposit (NPR)"
            onChangeText={(value) => set("securityDeposit", value)}
            value={details.securityDeposit}
            variant="line"
          />

          <View className="gap-7">
            {rooms.map((room, position) => (
              <RoomSection
                canRemove
                key={room.id}
                onChange={(next) =>
                  setRooms((list) => list.map((row) => (row.id === room.id ? { ...row, ...next } : row)))
                }
                onRemove={() => setRooms((list) => list.filter((row) => row.id !== room.id))}
                position={position + 1}
                room={room}
                showDeposit
              />
            ))}
          </View>
          <Button
            icon={Plus}
            label="Add room type"
            onPress={() => {
              setRooms((list) => [...list, emptyRoomRow(`room-${nextRoom}`)]);
              setNextRoom((value) => value + 1);
            }}
            variant="outline"
          />
          <ShortStaysSection onChange={setShortStays} rooms={rooms} value={shortStays} />
        </>
      ) : null}

      {step === "life" ? (
        <>
          <StepSection title="Facilities">
            <ChoiceChips
              onToggle={(facility) =>
                setFacilities((list) => (list.includes(facility) ? list.filter((item) => item !== facility) : [...list, facility]))
              }
              options={withCurrent(FACILITY_OPTIONS, ...facilities)}
              value={facilities}
            />
            <CustomFacility
              onAdd={(name) => {
                const match = [...FACILITY_OPTIONS, ...facilities].find((item) => item.toLowerCase() === name.toLowerCase()) ?? name;

                setFacilities((list) => (list.includes(match) ? list : [...list, match]));
              }}
            />
          </StepSection>

          <StepSection title="Food">
            <ChoiceChips columns={3} label="Food availability" onToggle={setFood} options={FOOD} value={food} />
            {food !== "none" ? (
              <>
                <ChoiceChips
                  columns={2}
                  label="Meals served"
                  onToggle={(value) => (value === "veg" ? setHasVeg(!hasVeg) : setHasNonVeg(!hasNonVeg))}
                  options={MEALS_SERVED}
                  value={[...(hasVeg ? (["veg"] as const) : []), ...(hasNonVeg ? (["nonVeg"] as const) : [])]}
                />
                <Input inputMode="numeric" label="Meals per day" onChangeText={(value) => set("mealsPerDay", value)} value={details.mealsPerDay} variant="line" />
              </>
            ) : null}
            <Input inputMode="numeric" label="Number of cooks" onChangeText={(value) => set("cookCount", value)} value={details.cookCount} variant="line" />
          </StepSection>

          <Input
            label="House rules (one per line)"
            multiline
            onChangeText={(value) => set("rules", value)}
            placeholder="Quiet hours, visitors, meal timings…"
            style={{ minHeight: 120 }}
            value={details.rules}
            variant="line"
          />

          <StepSection caption="Use photos of this location." title="Exterior photos">
            {photoButtons("EXTERIOR")}
          </StepSection>
          <StepSection title="Rooms & interior photos">{photoButtons("INTERIOR")}</StepSection>
        </>
      ) : null}

      {step === "review" ? (
        <View className="gap-5">
          <View>
            {STEPS.slice(0, REVIEW).map((entry, position) => (
              <ReviewFold
                complete={!problem(entry.key)}
                divider={position > 0}
                key={entry.key}
                onEdit={() => goTo(position, false)}
                onToggle={() => setOpenFold(openFold === entry.key ? null : entry.key)}
                open={openFold === entry.key}
                title={`${position + 1}. ${entry.title}`}
              >
                <FactRows facts={facts[entry.key as Exclude<StepKey, "review">]} />
              </ReviewFold>
            ))}
          </View>

          <Text variant="muted">We will call {details.phone.trim() || "the branch"} before this branch goes live.</Text>

          <Card padding="px-4 py-1">
            <ListRow
              icon="documents-outline"
              iconBgColor="#34C759"
              right={<Toggle accessibilityLabel="Use the same business documents" onChange={setReuseDocuments} value={reuseDocuments} />}
              subtitle={`From ${main.name} · PAN/VAT ${main.panNumber ?? "not added yet"}`}
              title="Use the same business documents"
            />
          </Card>
          {reuseDocuments ? null : (
            <Input
              inputMode="numeric"
              label="Branch PAN/VAT"
              maxLength={9}
              onChangeText={(value) => set("panNumber", value)}
              value={details.panNumber}
              variant="line"
            />
          )}

          <Accordion caption="Optional" title="Add or replace documents">
            {DOCUMENT_KINDS.map((kind) =>
              documents[kind] ? (
                <UploadPreview
                  attachment={documents[kind]!}
                  key={kind}
                  label={kind}
                  onRemove={() =>
                    setDocuments((current) => {
                      const { [kind]: _removed, ...rest } = current;

                      return rest;
                    })
                  }
                />
              ) : (
                <Button
                  disabled={busy !== null}
                  icon={Images}
                  key={kind}
                  label={kind}
                  loading={busy === kind}
                  onPress={() => void attachDocument(kind)}
                  size="sm"
                  variant="outline"
                />
              ),
            )}
          </Accordion>

          <StepSection caption="The bank account or wallet for this branch's payments. Optional." title="Branch payout account">
            <RegistrationPayoutFields onChange={setPayout} value={payout} />
          </StepSection>

          <Card padding="px-4 py-1">
            <ListRow
              icon="checkmark-done-outline"
              iconBgColor="#0a8a4b"
              right={<Toggle accessibilityLabel="Confirm branch details" onChange={setConfirmed} value={confirmed} />}
              subtitle="These details and any reused documents apply to this branch."
              title="I confirm"
            />
          </Card>
        </View>
      ) : null}
    </StepFrame>
  );
}
