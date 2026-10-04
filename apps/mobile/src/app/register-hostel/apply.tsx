import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { Camera, FileCheck, Images, Paperclip, Plus } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { MapLinkField, type PinAddress } from "@/components/hostel-pin-picker";
import { PhotoStrip, UploadPreview } from "@/components/registration-form";
import {
  Accordion,
  FactRows,
  ReviewFold,
  ReviewVerdict,
  StepFrame,
  StepSection,
  StepSkeleton,
  TermsAgreement,
} from "@/components/step-flow";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Lottie } from "@/components/ui/lottie";
import { Screen } from "@/components/ui/screen";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDraftAutosave } from "@/hooks/use-draft-autosave";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import type { Coordinates } from "@/lib/geo";
import {
  buildHostelPayload,
  capacitySummary,
  CITY_OPTIONS,
  emptyHostelForm,
  emptyRoomRow,
  FACILITY_OPTIONS,
  firstIncompleteHostelStep,
  HOSTEL_STEPS,
  HOSTEL_TYPES,
  hasHostelErrors,
  hostelStepErrors,
  ID_PROOF_TYPES,
  isHostelStepComplete,
  MEAL_INCLUSIONS,
  numberValue,
  ROOM_TYPE_OPTIONS,
  RULES_TEMPLATES,
  type HostelErrors,
  type HostelForm,
  type HostelStepKey,
  type IdProofType,
  type RoomRow,
  type ShortStayForm,
} from "@/lib/hostel-registration";
import { getRefundPolicy } from "@/lib/booking-api";
import { uploadPublicFile, uploadPublicText } from "@/lib/public-uploads";
import { registerHostelApplication } from "@/lib/registration-api";
import {
  EMPTY_PAYOUT_ACCOUNT,
  RegistrationPayoutFields,
} from "@/components/manage/payout-account-card";
import { Card, SectionHeader } from "@/components/ui/card";
import {
  clearRegistrationDraft,
  readRegistrationDraft,
  type RegistrationDrafts,
  saveRegistrationDraft,
} from "@/lib/registration-draft";
import { toastError } from "@/lib/toast";

/**
 * "Register your hostel", filled in on the phone, one question-group at a time
 * — the same sequence, fields, review and autosave as the ID card flow
 * (`app/id-card/edit.tsx`), so an owner who has made their card already knows
 * how this one works.
 *
 * ## Why it is not a browser tab
 *
 * `WEB_PUBLIC_PATHS.registerHostel` used to open the website's form, on the
 * argument that the application "wants ownership documents that live on a
 * computer". A Nepali hostel owner's citizenship certificate is not a scan in a
 * Downloads folder; it is a card in a drawer, and the device with a camera
 * pointed at it is this one. So both blocking requirements are satisfied here,
 * and neither is relaxed:
 *
 * - **The ID proof** is photographed or picked, and uploaded through the same
 *   public route the website's form posts to.
 * - **The rules document** starts from one of the platform's three templates;
 *   the edited text is attached as a real `text/plain` document
 *   (`uploadPublicText`).
 *
 * A reviewer therefore sees the same application whichever client filed it.
 *
 * ## What is deliberately not ported
 *
 * The plan price calculator with its VAT line, and the seven optional document
 * slots (PAN, bank details, licence, ownership proof). Seven optional uploads
 * on a phone is six chances to abandon the form, and the platform can request
 * any of them afterwards through `requestedDocuments`.
 */

/** Which attachment is at the server, so the pressed button is the one that spins. */
type UploadJob =
  | "id-camera"
  | "id-library"
  | "photo-camera"
  | "photo-library"
  | "rules-file"
  | "rules-text";

type StepCopy = { subtitle: string; title: string };

const STEP_COPY: Record<HostelStepKey, StepCopy> = {
  basics: { subtitle: "Your hostel, and how to reach you.", title: "The basics" },
  documents: { subtitle: "Checked before you go live.", title: "Documents" },
  location: { subtitle: "Where it is, what it offers.", title: "Location" },
  review: { subtitle: "Check it and send it.", title: "Review" },
  rooms: { subtitle: "Room types and prices.", title: "Rooms" },
};

/* `require` paths are case-sensitive on the Linux build machines. */
const STEP_ANIMATIONS: Partial<Record<HostelStepKey, number>> = {
  basics: require("../../../assets/lottie/hostel-basics.lottie"),
  documents: require("../../../assets/lottie/hostel-documents.lottie"),
  location: require("../../../assets/lottie/hostel-location.lottie"),
};
const SENT_ANIMATION = require("../../../assets/lottie/success.lottie");

const REVIEW_INDEX = HOSTEL_STEPS.length - 1;

const ID_PROOF_LABELS: Record<IdProofType, string> = {
  Citizenship: "Citizenship",
  "National Identity Card (NID)": "National ID",
  Passport: "Passport",
};

const MEALS_SERVED = [
  { label: "Veg", value: "veg" },
  { label: "Non-veg", value: "nonVeg" },
] as const;

const MEALS_PER_DAY = ["1", "2", "3", "4"];

type Starter = { label: string; write: (name: string, who: string) => string };

/** Standard descriptions an owner can start from and then edit; three are offered at random. */
const DESCRIPTION_STARTERS: Starter[] = [
  {
    label: "Homely & quiet",
    write: (name, who) =>
      `${name} is a clean, quiet hostel for ${who} with a homely feel, regular meals and a calm place to study and rest.`,
  },
  {
    label: "Student friendly",
    write: (name, who) =>
      `${name} is made for ${who} who study — study tables, fast WiFi, set meal times and quiet hours so exams never clash with noise.`,
  },
  {
    label: "Safe & secure",
    write: (name, who) =>
      `${name} puts safety first for ${who}: CCTV, a staffed gate, fixed entry times and a warden on site around the clock.`,
  },
  {
    label: "Budget stay",
    write: (name, who) =>
      `${name} offers affordable, no-fuss rooms for ${who}, with the essentials covered and fair monthly rent.`,
  },
  {
    label: "Home-style food",
    write: (name, who) =>
      `${name} is known for its home-style food — fresh meals cooked daily for ${who}, in a friendly, family-like hostel.`,
  },
  {
    label: "Working professionals",
    write: (name, who) =>
      `${name} gives ${who} a comfortable base close to offices and transport, with WiFi, laundry and flexible meal times.`,
  },
  {
    label: "Close to colleges",
    write: (name, who) =>
      `${name} is a short walk from nearby colleges, giving ${who} a clean, well-run place to live without a long commute.`,
  },
  {
    label: "Modern & comfortable",
    write: (name, who) =>
      `${name} offers ${who} modern, well-kept rooms, reliable hot water and power backup, and common spaces to relax in.`,
  },
];

const STARTER_AUDIENCE: Record<HostelForm["hostelType"], string> = {
  BOYS: "boys",
  CO_LIVING: "students and working professionals",
  GIRLS: "girls",
};

function writeStarter(starter: Starter, form: HostelForm): string {
  return starter.write(
    form.hostelName.trim() || "Our hostel",
    STARTER_AUDIENCE[form.hostelType],
  );
}

/** `count` starters in random order (Fisher–Yates, so no starter is favoured). */
function pickStarters(count: number): Starter[] {
  const pool = [...DESCRIPTION_STARTERS];

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));

    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  return pool.slice(0, count);
}

export default function RegisterHostelApplyScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const accountId = account?.id ?? "";
  /** `undefined` while the phone is still being asked for a saved draft. */
  const [stored, setStored] = useState<
    RegistrationDrafts["hostel"] | null | undefined
  >(accountId ? undefined : null);

  useEffect(() => {
    if (!accountId) {
      return;
    }

    let live = true;

    void readRegistrationDraft("hostel", accountId).then((snapshot) => {
      if (live) {
        setStored(snapshot);
      }
    });

    return () => {
      live = false;
    };
  }, [accountId]);

  if (!account) {
    return (
      <Screen header={<AppBar showBack title="Register your hostel" />} scroll>
        <EmptyState
          action={
            <Button
              label="Sign in"
              onPress={() => router.push("/(auth)/login")}
            />
          }
          description="Your application is attached to your account, which is how you can come back and see where it has got to. Without one, the only news you would get is an email."
          title="Sign in to register"
        />
      </Screen>
    );
  }

  if (stored === undefined) {
    return (
      <StepSkeleton
        subtitle={STEP_COPY.basics.subtitle}
        title={STEP_COPY.basics.title}
        total={HOSTEL_STEPS.length}
      />
    );
  }

  return (
    <HostelWizard
      accountId={accountId}
      defaults={{
        email: account.email ?? "",
        ownerName: account.name ?? "",
        ownerPhone: account.phone ?? "",
      }}
      stored={stored}
    />
  );
}

function HostelWizard({
  accountId,
  defaults,
  stored,
}: {
  accountId: string;
  defaults: Pick<HostelForm, "email" | "ownerName" | "ownerPhone">;
  /** The autosaved application from last time. */
  stored: RegistrationDrafts["hostel"] | null;
}) {
  // Checked on `register-hostel/index` before the form opened; the server checks it again.
  const referralCode = useLocalSearchParams<{ ref?: string }>().ref?.trim().toUpperCase() || undefined;
  const [form, setForm] = useState<HostelForm>(() =>
    stored
      ? // Consent is given for what is on screen now, not for last session's form.
        {
          // Under the draft, so a draft saved before a field existed still has it.
          ...emptyHostelForm("room-1"),
          ...stored.form,
          agreed: false,
          idProofType: stored.form.idProofType || "Citizenship",
        }
      : // Citizenship preselected: it is the ID nearly every owner attaches.
        { ...emptyHostelForm("room-1"), ...defaults, idProofType: "Citizenship" },
  );
  const [index, setIndex] = useState(
    Math.min(stored?.index ?? 0, REVIEW_INDEX),
  );
  /** Which way the next screen slides in from. */
  const [forward, setForward] = useState(true);
  const [errors, setErrors] = useState<HostelErrors>({});
  const [busy, setBusy] = useState<UploadJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedName, setSubmittedName] = useState<string | null>(null);
  /** Three description starters, drawn once per visit so they don't reshuffle between steps. */
  const [starters] = useState(() => pickStarters(3));
  // Booking payouts (docs/BOOKINGS.md item 26). Optional, and not part of the saved draft.
  const [payout, setPayout] = useState(EMPTY_PAYOUT_ACCOUNT);

  // Row keys only; a counter rather than `crypto.randomUUID`, which is not on
  // every Android runtime. Starts past any id a restored draft already holds.
  const nextRoomId = useRef(
    Math.max(
      1,
      ...form.rooms.map((room) => Number(room.id.replace(/\D/g, "")) || 0),
    ),
  );

  const snapshot = useMemo(() => ({ form, index }), [form, index]);
  const persist = useCallback(
    (value: RegistrationDrafts["hostel"]) =>
      saveRegistrationDraft("hostel", accountId, value),
    [accountId],
  );
  const markSaved = useDraftAutosave(snapshot, Boolean(stored), persist);

  const step = HOSTEL_STEPS[index]!.key;

  const patch = useCallback((next: Partial<HostelForm>) => {
    setForm((current) => ({ ...current, ...next }));
    // Only the touched fields lose their message: a form that corrects you, not one that nags.
    setErrors((current) => {
      const touched = Object.keys(next) as (keyof HostelForm)[];

      if (!touched.some((field) => current[field])) {
        return current;
      }

      const rest = { ...current };

      for (const field of touched) {
        delete rest[field];
      }

      return rest;
    });
  }, []);

  const addressHint = [form.address, form.area, form.city]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");

  /**
   * Set the pin, and let the lookup fill in the address fields the owner left
   * empty — never the ones they typed, which describe their own door better
   * than a geocoder does.
   */
  const placePin = useCallback(
    (pin: Coordinates, address?: PinAddress) => {
      // Against the latest form, not this render's: a pasted link answers
      // after a network round trip, and the owner may have typed meanwhile.
      setForm((current) => ({
        ...current,
        pin,
        ...(address?.address && !current.address.trim()
          ? { address: address.address }
          : {}),
        ...(address?.area && !current.area.trim() ? { area: address.area } : {}),
      }));
      setErrors((current) => {
        const rest = { ...current };

        delete rest.pin;

        if (address?.address) {
          delete rest.address;
        }

        if (address?.area) {
          delete rest.area;
        }

        return rest;
      });
    },
    [],
  );

  const goTo = useCallback((next: number, direction: boolean) => {
    setForward(direction);
    setIndex(next);
  }, []);

  const back = useCallback(() => {
    if (index === 0) {
      router.back();

      return;
    }

    goTo(index - 1, false);
  }, [goTo, index]);

  const advance = useCallback(() => {
    const found = hostelStepErrors(step, form);

    setErrors(found);

    if (!hasHostelErrors(found)) {
      goTo(Math.min(REVIEW_INDEX, index + 1), true);
    }
  }, [form, goTo, index, step]);

  /* ── uploads ── */

  const pickImage = useCallback(
    async (
      source: "camera" | "library",
    ): Promise<ImagePicker.ImagePickerAsset | null> => {
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        toastError(
          source === "camera" ? "Camera access needed" : "Photo access needed",
          source === "camera"
            ? "Allow the camera so you can photograph your documents."
            : "Allow photo access to attach files you already have.",
        );

        return null;
      }

      const result =
        source === "camera"
          ? // `quality: 0.7` keeps a phone photo under the public route's 5 MB cap.
            await ImagePicker.launchCameraAsync({ quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 0.7,
            });

      return result.canceled ? null : (result.assets[0] ?? null);
    },
    [],
  );

  const attachIdProof = useCallback(
    async (source: "camera" | "library") => {
      const asset = await pickImage(source);

      if (!asset) {
        return;
      }

      setBusy(source === "camera" ? "id-camera" : "id-library");

      try {
        const uploaded = await uploadPublicFile(asset, { label: "ID proof" });

        patch({
          idProof: {
            claimToken: uploaded.claimToken,
            fileAssetId: uploaded.fileAssetId,
            fileName: uploaded.fileName,
            url: uploaded.url,
          },
        });
      } catch (caught) {
        toastError("That didn't upload", readApiError(caught));
      } finally {
        setBusy(null);
      }
    },
    [patch, pickImage],
  );

  const attachRulesText = useCallback(async () => {
    const body = form.rules.trim();

    if (!body) {
      setErrors((current) => ({
        ...current,
        rulesDocument: "Write your rules, or start from a template.",
      }));

      return;
    }

    setBusy("rules-text");

    try {
      const uploaded = await uploadPublicText(body, {
        fileName: "hostel-rules.txt",
        label: "House rules",
      });

      patch({
        rulesDocument: {
          claimToken: uploaded.claimToken,
          fileAssetId: uploaded.fileAssetId,
          fileName: "House rules.txt",
          url: uploaded.url,
        },
      });
    } catch (caught) {
      toastError("Those rules didn't attach", readApiError(caught));
    } finally {
      setBusy(null);
    }
  }, [form.rules, patch]);

  const attachRulesFile = useCallback(async () => {
    const asset = await pickImage("library");

    if (!asset) {
      return;
    }

    setBusy("rules-file");

    try {
      const uploaded = await uploadPublicFile(asset, { label: "House rules" });

      patch({
        rulesDocument: {
          claimToken: uploaded.claimToken,
          fileAssetId: uploaded.fileAssetId,
          fileName: uploaded.fileName,
          url: uploaded.url,
        },
      });
    } catch (caught) {
      toastError("That didn't upload", readApiError(caught));
    } finally {
      setBusy(null);
    }
  }, [patch, pickImage]);

  const addPhoto = useCallback(
    async (source: "camera" | "library") => {
      const asset = await pickImage(source);

      if (!asset) {
        return;
      }

      setBusy(source === "camera" ? "photo-camera" : "photo-library");

      try {
        const uploaded = await uploadPublicFile(asset, {
          label: "Hostel photo",
          visibility: "public",
        });

        setForm((current) => ({
          ...current,
          // The schema caps `photos` at 20.
          photos: [
            ...current.photos,
            { fileName: uploaded.fileName, url: uploaded.url },
          ].slice(0, 20),
        }));
      } catch (caught) {
        toastError("That photo didn't upload", readApiError(caught));
      } finally {
        setBusy(null);
      }
    },
    [pickImage],
  );

  /* ── rooms ── */

  const updateRoom = useCallback(
    (id: string, next: Partial<RoomRow>) => {
      setForm((current) => ({
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === id ? { ...room, ...next } : room,
        ),
      }));
      setErrors((current) => {
        const { rooms: _rooms, ...rest } = current;

        return rest;
      });
    },
    [],
  );

  const removeRoom = useCallback((id: string) => {
    setForm((current) => ({
      ...current,
      // Never below one: an empty rooms step has no obvious way back.
      rooms:
        current.rooms.length > 1
          ? current.rooms.filter((room) => room.id !== id)
          : current.rooms,
    }));
  }, []);

  const addRoom = useCallback(() => {
    nextRoomId.current += 1;
    const id = `room-${nextRoomId.current}`;

    setForm((current) => ({
      ...current,
      rooms: [...current.rooms, emptyRoomRow(id)],
    }));
  }, []);

  /* ── submit ── */

  const submit = useCallback(async () => {
    if (busy) {
      toastError("Something is still uploading", "Try again in a moment.");

      return;
    }

    const incomplete = firstIncompleteHostelStep(form);

    if (incomplete) {
      setErrors(hostelStepErrors(incomplete, form));

      if (incomplete !== "review") {
        toastError("Some details need fixing", "The ones in red.");
        goTo(
          HOSTEL_STEPS.findIndex((entry) => entry.key === incomplete),
          false,
        );
      }

      return;
    }

    setSubmitting(true);

    try {
      const hostel = await registerHostelApplication({
        ...buildHostelPayload(form),
        payoutAccount: payout.number.trim() ? payout : undefined,
        referralCode,
      });

      markSaved();
      void clearRegistrationDraft("hostel", accountId);
      setSubmittedName(hostel.name || form.hostelName.trim());
    } catch (caught) {
      toastError(
        "Your application could not be submitted",
        readApiError(caught),
      );
    } finally {
      setSubmitting(false);
    }
  }, [accountId, busy, form, goTo, markSaved, payout, referralCode]);

  if (submittedName) {
    return <SubmittedView hostelName={submittedName} />;
  }

  const onReview = step === "review";
  const copy = STEP_COPY[step];
  const summary = capacitySummary(form.rooms);
  const animation = STEP_ANIMATIONS[step];

  return (
    <StepFrame
      footer={
        <Button
          // Looks off until the box is ticked, but still answers a tap with why.
          className={onReview && !form.agreed ? "opacity-50" : undefined}
          label={
            onReview
              ? "Submit application"
              : index === REVIEW_INDEX - 1
                ? "Review"
                : "Continue"
          }
          loading={submitting}
          onPress={
            onReview
              ? () => {
                  if (!form.agreed) {
                    toastError(
                      "Confirm the details first",
                      "Tick the box above the button.",
                    );

                    return;
                  }

                  void submit();
                }
              : advance
          }
        />
      }
      forward={forward}
      onBack={back}
      position={index + 1}
      stepKey={step}
      subtitle={
        step === "rooms" && summary.totalBeds > 0
          ? `${summary.totalRooms} rooms · ${summary.totalBeds} beds so far.`
          : copy.subtitle
      }
      title={copy.title}
      total={HOSTEL_STEPS.length}
    >
      {animation ? (
        <View
          className="items-center"
          // The documents artwork sits small inside a lot of empty frame; drawn larger, the frame's
          // top and bottom are pulled back in so it doesn't push the fields down.
          style={step === "documents" ? { marginVertical: -48 } : undefined}
        >
          <Lottie size={step === "documents" ? 280 : 140} source={animation} />
        </View>
      ) : null}

      {step === "basics" ? (
        <>
          <Input
            autoCapitalize="words"
            error={errors.hostelName}
            label="Hostel name *"
            onChangeText={(value) => patch({ hostelName: value })}
            placeholder="As it is written on the building"
            value={form.hostelName}
            variant="line"
          />
          <Input
            error={errors.description}
            label="About the hostel *"
            multiline
            onChangeText={(value) => patch({ description: value })}
            placeholder="Who it suits, what makes it worth living in."
            value={form.description}
            variant="line"
          />
          <ChoiceChips
            onToggle={(label) => {
              const starter = starters.find((entry) => entry.label === label);

              if (starter) {
                patch({ description: writeStarter(starter, form) });
              }
            }}
            options={starters.map((entry) => ({
              label: entry.label,
              value: entry.label,
            }))}
            // The one whose text is in the box stays lit, until the owner edits it.
            value={
              starters.find(
                (entry) => writeStarter(entry, form) === form.description,
              )?.label ?? null
            }
          />
          <ChoiceChips
            columns={3}
            label="Who it is for"
            onToggle={(value) => patch({ hostelType: value })}
            options={HOSTEL_TYPES}
            value={form.hostelType}
          />

          <StepSection title="You">
            <Input
              autoCapitalize="words"
              error={errors.ownerName}
              label="Your name *"
              onChangeText={(value) => patch({ ownerName: value })}
              value={form.ownerName}
              variant="line"
            />
            <Input
              error={errors.ownerPhone}
              keyboardType="phone-pad"
              label="Your phone *"
              onChangeText={(value) => patch({ ownerPhone: value })}
              placeholder="98XXXXXXXX"
              value={form.ownerPhone}
              variant="line"
            />
            <Input
              error={errors.panNumber}
              hint="Optional. Nine digits, from your PAN/VAT certificate."
              keyboardType="number-pad"
              label="PAN/VAT number"
              onChangeText={(value) => patch({ panNumber: value })}
              value={form.panNumber}
              variant="line"
            />
            <Input
              autoCapitalize="none"
              error={errors.email}
              hint="This becomes your owner login."
              keyboardType="email-address"
              label="Your email *"
              onChangeText={(value) => patch({ email: value })}
              value={form.email}
              variant="line"
            />
          </StepSection>
        </>
      ) : null}

      {step === "location" ? (
        <>
          <Input
            error={errors.address}
            label="Address *"
            onChangeText={(value) => patch({ address: value })}
            placeholder="Street or tole"
            value={form.address}
            variant="line"
          />
          <Input
            label="Landmark"
            onChangeText={(value) => patch({ landmark: value })}
            placeholder="Opposite the campus gate"
            value={form.landmark}
            variant="line"
          />
          <Input
            autoCapitalize="words"
            error={errors.area}
            label="Area *"
            onChangeText={(value) => patch({ area: value })}
            placeholder="Bagdol, Baneshwor…"
            value={form.area}
            variant="line"
          />
          <View className="gap-3">
            <Input
              autoCapitalize="words"
              error={errors.city}
              label="City *"
              onChangeText={(value) => patch({ city: value })}
              placeholder="Type your city"
              value={form.city}
              variant="line"
            />
            <ChoiceChips
              onToggle={(value) => patch({ city: value })}
              options={withCurrent(CITY_OPTIONS)}
              value={form.city}
            />
          </View>

          <MapLinkField
            near={addressHint}
            onChange={(value) =>
              // The pin only ever comes from the link, so clearing one clears both.
              patch(value.trim() ? { mapLink: value } : { mapLink: "", pin: null })
            }
            onPinned={(match) => placePin(match.coordinates, match.address)}
            pin={form.pin}
            value={form.mapLink}
          />

          <Input
            inputMode="numeric"
            label="Floors"
            onChangeText={(value) => patch({ totalFloors: value })}
            value={form.totalFloors}
            variant="line"
          />

          <StepSection title="Facilities">
            <ChoiceChips
              onToggle={(facility) =>
                patch({
                  facilities: form.facilities.includes(facility)
                    ? form.facilities.filter((item) => item !== facility)
                    : [...form.facilities, facility],
                })
              }
              options={withCurrent(FACILITY_OPTIONS, ...form.facilities)}
              value={form.facilities}
            />
            <CustomFacility
              onAdd={(name) => {
                // A typed name that matches an existing chip turns that chip on instead of duplicating it.
                const match =
                  [...FACILITY_OPTIONS, ...form.facilities].find(
                    (item) => item.toLowerCase() === name.toLowerCase(),
                  ) ?? name;

                if (!form.facilities.includes(match)) {
                  patch({ facilities: [...form.facilities, match] });
                }
              }}
            />
          </StepSection>
        </>
      ) : null}

      {step === "rooms" ? (
        <>
          <View className="gap-7">
            {form.rooms.map((room, roomIndex) => (
              <RoomSection
                canRemove={form.rooms.length > 1}
                key={room.id}
                onChange={(next) => updateRoom(room.id, next)}
                onRemove={() => removeRoom(room.id)}
                position={roomIndex + 1}
                room={room}
              />
            ))}
          </View>

          {errors.rooms ? (
            <Text className="text-destructive" variant="caption">
              {errors.rooms}
            </Text>
          ) : null}

          <Button
            icon={Plus}
            label="Add room type"
            onPress={addRoom}
            variant="outline"
          />

          <StepSection title="Food">
            <ChoiceChips
              columns={2}
              label="Meals served"
              onToggle={(value) =>
                value === "veg"
                  ? patch({ servesVeg: !form.servesVeg })
                  : patch({ servesNonVeg: !form.servesNonVeg })
              }
              options={MEALS_SERVED}
              value={[
                ...(form.servesVeg ? (["veg"] as const) : []),
                ...(form.servesNonVeg ? (["nonVeg"] as const) : []),
              ]}
            />
            <ChoiceChips
              columns={4}
              label="Meals per day"
              onToggle={(value) => patch({ mealsPerDay: value })}
              options={withCurrent(MEALS_PER_DAY, form.mealsPerDay)}
              value={form.mealsPerDay}
            />
          </StepSection>

          <Accordion
            caption="Optional"
            defaultOpen={Boolean(form.admissionFee)}
            title="Admission fee"
          >
            <Input
              inputMode="numeric"
              label="Admission fee (NPR)"
              onChangeText={(value) => patch({ admissionFee: value })}
              value={form.admissionFee}
              variant="line"
            />
          </Accordion>
<Accordion
            caption="Optional"
            defaultOpen={Boolean(form.formFee)}
            title="Form fee"
          >
            <Input
              inputMode="numeric"
              label="Form fee (NPR)"
              onChangeText={(value) => patch({ formFee: value })}
              error={errors.formFee}
              value={form.formFee}
              variant="line"
            />
          </Accordion>

          <ShortStaysSection
            onChange={(shortStays) => patch({ shortStays })}
            rooms={form.rooms}
            value={form.shortStays}
          />
        </>
      ) : null}

      {step === "documents" ? (
        <>
          <StepSection
            action={
              <Select
                onChange={(value) => patch({ idProofType: value })}
                options={ID_PROOF_TYPES.map((type) => ({
                  label: ID_PROOF_LABELS[type],
                  value: type,
                }))}
                placeholder="Type"
                sheetTitle="Government ID"
                tone={errors.idProofType ? "danger" : undefined}
                value={form.idProofType || null}
                variant="compact"
              />
            }
            title="Government ID *"
          >
            {errors.idProofType ? (
              <Text className="text-destructive" variant="caption">
                {errors.idProofType}
              </Text>
            ) : null}
            {form.idProof ? (
              <UploadPreview
                attachment={form.idProof}
                label="Your ID"
                onRemove={() => patch({ idProof: null })}
              />
            ) : (
              <View className="gap-2">
                <View className="flex-row gap-2">
                  <View style={{ flex: 1 }}>
                    <Button
                      disabled={busy !== null}
                      icon={Camera}
                      label="Take photo"
                      loading={busy === "id-camera"}
                      onPress={() => void attachIdProof("camera")}
                      size="sm"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      disabled={busy !== null}
                      icon={Images}
                      label="Gallery"
                      size="sm"
                      loading={busy === "id-library"}
                      onPress={() => void attachIdProof("library")}
                      variant="outline"
                    />
                  </View>
                </View>
                {errors.idProof ? (
                  <Text className="text-destructive" variant="caption">
                    {errors.idProof}
                  </Text>
                ) : null}
              </View>
            )}
          </StepSection>

          <SectionRule />

          <StepSection title="House rules *">
            <RulesDocumentField
              busy={busy}
              document={form.rulesDocument}
              error={errors.rulesDocument}
              onAttachFile={() => void attachRulesFile()}
              onAttachText={() => void attachRulesText()}
              onChangeText={(value) => patch({ rules: value })}
              onRemove={() => patch({ rulesDocument: null })}
              rules={form.rules}
            />
          </StepSection>

          <SectionRule />

          <Accordion
            caption="Optional"
            defaultOpen={form.photos.length > 0}
            title="Photos"
          >
            <PhotoStrip
              onRemove={(url) =>
                setForm((current) => ({
                  ...current,
                  photos: current.photos.filter((photo) => photo.url !== url),
                }))
              }
              photos={form.photos}
            />
            <View className="flex-row gap-2">
              <View style={{ flex: 1 }}>
                <Button
                  disabled={busy !== null || form.photos.length >= 20}
                  icon={Camera}
                  label="Take photo"
                  loading={busy === "photo-camera"}
                  onPress={() => void addPhoto("camera")}
                  variant="outline"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  disabled={busy !== null || form.photos.length >= 20}
                  icon={Images}
                  label="Gallery"
                  loading={busy === "photo-library"}
                  onPress={() => void addPhoto("library")}
                  variant="outline"
                />
              </View>
            </View>
          </Accordion>
        </>
      ) : null}

      {onReview && referralCode ? (
        <Text className="text-center" variant="muted">
          Referral code {referralCode} — the extra plan time is added once your hostel goes live.
        </Text>
      ) : null}

      {onReview ? (
        <HostelReview
          errors={errors}
          form={form}
          onEdit={(key) =>
            goTo(
              HOSTEL_STEPS.findIndex((entry) => entry.key === key),
              false,
            )
          }
          patch={patch}
        />
      ) : null}

      {onReview ? (
        <View className="mt-6">
          <SectionHeader
            subtitle="Optional. Where we send your share when someone books a bed. You can add it later from Payment setup."
            title="Booking payouts"
          />
          <Card>
            <RegistrationPayoutFields onChange={setPayout} value={payout} />
          </Card>
        </View>
      ) : null}
    </StepFrame>
  );
}

/** The faint hairline between one document and the next. */
/**
 * "Do you offer short stays?" — a daily rate per room type, each shown against
 * its floor (monthly ÷ 30 plus the platform's markup). The server checks again.
 */
function ShortStaysSection({
  onChange,
  rooms,
  value,
}: {
  onChange: (next: ShortStayForm) => void;
  rooms: HostelForm["rooms"];
  value: ShortStayForm;
}) {
  const policy = useResource(getRefundPolicy, { cacheKey: "booking-policy" });
  const terms = policy.data?.shortStay;

  return (
    <Accordion caption="Optional" defaultOpen={value.enabled} title="Short stays">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1" variant="caption">
          {`Guests book a few nights${terms ? ` (up to ${terms.maxNights})` : ""} and pay us upfront. You get ${terms ? `${terms.hostelSharePercent}%` : "your share"} of the nights once they check in.`}
        </Text>
        <Toggle
          accessibilityLabel="Offers short stays"
          onChange={(enabled) => onChange({ ...value, enabled })}
          value={value.enabled}
        />
      </View>
      {value.enabled ? (
        <>
          <Input
            inputMode="numeric"
            label="Fewest nights"
            onChangeText={(minNights) => onChange({ ...value, minNights })}
            value={value.minNights}
            variant="line"
          />
          {rooms
            .filter((room) => room.roomType.trim())
            .map((room) => {
              const name = room.roomType.trim();
              const monthly = numberValue(room.monthlyRent) ?? 0;
              const floor =
                terms && monthly > 0 ? Math.max(1, Math.ceil((monthly * (100 + terms.minMarkupPercent)) / 3000)) : null;
              const rate = value.rates[name] ?? "";

              return (
                <Input
                  error={floor && rate && Number(rate) < floor ? `At least NPR ${floor} a night` : undefined}
                  hint={floor ? `At least NPR ${floor} a night` : "Enter its monthly rent first"}
                  inputMode="numeric"
                  key={room.id}
                  label={`${name} · a night`}
                  onChangeText={(next) => onChange({ ...value, rates: { ...value.rates, [name]: next } })}
                  value={rate}
                  variant="line"
                />
              );
            })}
        </>
      ) : null}
    </Accordion>
  );
}

function SectionRule() {
  return <View className="h-px bg-border opacity-50" />;
}

/** "Add your own" under the facility chips: opens a field, and the typed name joins the chips already on. */
function CustomFacility({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const add = () => {
    const value = name.trim();

    if (value) {
      onAdd(value);
    }

    setName("");
    setOpen(false);
  };

  if (!open) {
    return (
      <Button
        className="self-start"
        icon={Plus}
        label="Add your own"
        onPress={() => setOpen(true)}
        size="sm"
        variant="ghost"
      />
    );
  }

  return (
    <Input
      autoFocus
      label="Facility"
      onChangeText={setName}
      onSubmitEditing={add}
      returnKeyType="done"
      trailing={
        <Pressable hitSlop={10} onPress={add}>
          <Text className="text-primary" variant="label">
            {name.trim() ? "Add" : "Cancel"}
          </Text>
        </Pressable>
      }
      value={name}
      variant="line"
    />
  );
}

/** A list's options, plus any value saved before the list had it — so it stays visible and removable. */
function withCurrent(
  options: readonly string[],
  ...current: string[]
): { label: string; value: string }[] {
  return [...new Set([...options, ...current.filter(Boolean)])].map(
    (value) => ({ label: value, value }),
  );
}

/**
 * One room type.
 *
 * `vacantBeds` is asked for because "beds free" is the most looked-at number on
 * a hostel card, and a hostel that registers with it unset publishes as full.
 * It starts blank rather than at the bed count — guessing an occupancy on an
 * owner's behalf is inventing data about their business.
 */
function RoomSection({
  canRemove,
  onChange,
  onRemove,
  position,
  room,
}: {
  canRemove: boolean;
  onChange: (next: Partial<RoomRow>) => void;
  onRemove: () => void;
  position: number;
  room: RoomRow;
}) {
  const { colors } = useAppTheme();

  return (
    <StepSection
      action={
        canRemove ? (
          <Pressable
            accessibilityLabel={`Remove room type ${position}`}
            accessibilityRole="button"
            hitSlop={10}
            onPress={onRemove}
          >
            <Ionicons
              color={colors.destructive}
              name="trash-outline"
              size={18}
            />
          </Pressable>
        ) : undefined
      }
      title={`Room type ${position}`}
    >
      <ChoiceChips
        onToggle={(value) => onChange({ roomType: value })}
        options={withCurrent(ROOM_TYPE_OPTIONS, room.roomType)}
        value={room.roomType}
      />

      <View className="flex-row gap-4">
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="How many"
            onChangeText={(value) => onChange({ rooms: value })}
            value={room.rooms}
            variant="line"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="Beds each"
            onChangeText={(value) => onChange({ bedsPerRoom: value })}
            value={room.bedsPerRoom}
            variant="line"
          />
        </View>
      </View>

      <View className="flex-row gap-4">
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="Rent / month"
            onChangeText={(value) => onChange({ monthlyRent: value })}
            placeholder="NPR"
            value={room.monthlyRent}
            variant="line"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="Beds free now"
            onChangeText={(value) => onChange({ vacantBeds: value })}
            value={room.vacantBeds}
            variant="line"
          />
        </View>
      </View>

      <ChoiceChips
        columns={3}
        label="Meals"
        onToggle={(value) => onChange({ mealInclusion: value })}
        options={MEAL_INCLUSIONS.map((meal) => ({ label: meal, value: meal }))}
        value={room.mealInclusion}
      />
    </StepSection>
  );
}

/**
 * The house-rules document: start from a template and edit the words, and the
 * text is attached as a real `text/plain` document — or attach a file. Once
 * something is attached it collapses to one removable row, because offering
 * two ways to replace a thing already there is asking a question it has the
 * answer to.
 */
function RulesDocumentField({
  busy,
  document,
  error,
  onAttachFile,
  onAttachText,
  onChangeText,
  onRemove,
  rules,
}: {
  busy: UploadJob | null;
  document: { fileName: string; url: string } | null;
  error?: string;
  onAttachFile: () => void;
  onAttachText: () => void;
  onChangeText: (value: string) => void;
  onRemove: () => void;
  rules: string;
}) {
  const [template, setTemplate] = useState<string | null>(null);

  if (document) {
    return (
      <UploadPreview
        attachment={document}
        label="House rules"
        onRemove={onRemove}
        // Rules written here went up as text; a picked file is an image.
        text={document.fileName.endsWith(".txt") ? rules : undefined}
      />
    );
  }

  return (
    <View className="gap-5">
      <ChoiceChips
        label="Template"
        onToggle={(value) => {
          setTemplate(value);
          onChangeText(
            RULES_TEMPLATES.find((item) => item.id === value)?.body ?? rules,
          );
        }}
        options={RULES_TEMPLATES.map((item) => ({
          label: item.name,
          value: item.id,
        }))}
        value={template}
      />

      <Input
        error={error}
        label="Your rules"
        multiline
        onChangeText={onChangeText}
        placeholder="One rule per line."
        style={{ minHeight: 160 }}
        value={rules}
        variant="line"
      />

      <View className="gap-2">
        <Button
          disabled={busy !== null}
          icon={FileCheck}
          label="Use these rules"
          loading={busy === "rules-text"}
          onPress={onAttachText}
        />
        <Button
          disabled={busy !== null}
          icon={Paperclip}
          label="Attach a photo instead"
          loading={busy === "rules-file"}
          onPress={onAttachFile}
          variant="ghost"
        />
      </View>
    </View>
  );
}

function HostelReview({
  errors,
  form,
  onEdit,
  patch,
}: {
  errors: HostelErrors;
  form: HostelForm;
  onEdit: (step: HostelStepKey) => void;
  patch: (next: Partial<HostelForm>) => void;
}) {
  const [openStep, setOpenStep] = useState<HostelStepKey | null>(null);
  const dash = (value: string) => value.trim() || "—";
  const summary = capacitySummary(form.rooms);

  const facts: Record<Exclude<HostelStepKey, "review">, [string, string][]> = {
    basics: [
      ["Hostel", dash(form.hostelName)],
      ["About", dash(form.description)],
      [
        "Who it is for",
        HOSTEL_TYPES.find((type) => type.value === form.hostelType)?.label ??
          "—",
      ],
      ["Owner", dash(form.ownerName)],
      ["Phone", dash(form.ownerPhone)],
      ["PAN/VAT", dash(form.panNumber)],
      ["Email", dash(form.email)],
    ],
    documents: [
      [
        "Government ID",
        form.idProof
          ? `${form.idProofType ? ID_PROOF_LABELS[form.idProofType] : "ID"} — attached`
          : "Not attached",
      ],
      ["House rules", form.rulesDocument ? "Attached" : "Not attached"],
      ["Photos", form.photos.length > 0 ? String(form.photos.length) : "—"],
    ],
    location: [
      ["Address", dash(form.address)],
      ["Landmark", dash(form.landmark)],
      ["Area", dash(form.area)],
      ["City", dash(form.city)],
      [
        "Map pin",
        form.pin ? `${form.pin.lat.toFixed(5)}, ${form.pin.lng.toFixed(5)}` : "Not placed",
      ],
      ["Maps link", dash(form.mapLink)],
      ["Facilities", dash(form.facilities.join(", "))],
      ["Floors", dash(form.totalFloors)],
    ],
    rooms: [
      ...form.rooms.map(
        (room): [string, string] => [
          room.roomType || "Room",
          `${room.rooms || 0} × ${room.bedsPerRoom || 0} beds${room.monthlyRent ? ` · NPR ${room.monthlyRent}` : ""}`,
        ],
      ),
      ["Capacity", `${summary.totalRooms} rooms · ${summary.totalBeds} beds`],
      [
        "Food",
        [
          form.servesVeg ? "Veg" : "",
          form.servesNonVeg ? "Non-veg" : "",
          form.mealsPerDay ? `${form.mealsPerDay} a day` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "—",
      ],
      ["Form fee", form.formFee ? `NPR ${form.formFee}` : "None"],
      [
        "Admission fee",
        form.admissionFee ? `NPR ${form.admissionFee}` : "None",
      ],
      [
        "Short stays",
        form.shortStays.enabled
          ? Object.entries(form.shortStays.rates)
              .filter(([, rate]) => Number(rate) > 0)
              .map(([name, rate]) => `${name} NPR ${rate}/night`)
              .join(" · ") || "Yes"
          : "No",
      ],
    ],
  };

  const steps = HOSTEL_STEPS.filter((entry) => entry.key !== "review");
  const incomplete = steps.find(
    (entry) => !isHostelStepComplete(entry.key, form),
  );

  return (
    <View className="gap-5">
      <View>
        {steps.map((entry, position) => (
          <ReviewFold
            complete={isHostelStepComplete(entry.key, form)}
            divider={position > 0}
            key={entry.key}
            onEdit={() => onEdit(entry.key)}
            onToggle={() =>
              setOpenStep(openStep === entry.key ? null : entry.key)
            }
            open={openStep === entry.key}
            title={`${position + 1}. ${STEP_COPY[entry.key].title}`}
          >
            <FactRows
              facts={facts[entry.key as Exclude<HostelStepKey, "review">]}
            />
          </ReviewFold>
        ))}
      </View>

      <ReviewVerdict
        incomplete={incomplete ? STEP_COPY[incomplete.key].title : null}
        onFix={() => incomplete && onEdit(incomplete.key)}
      />

      <Text variant="caption">
        We&apos;ll verify your documents and email you within 1–2 business
        days.
      </Text>

      <TermsAgreement
        agreed={form.agreed}
        error={errors.agreed}
        onChange={(value) => patch({ agreed: value })}
        prefix="I run this hostel, these details are true, and I agree to"
      />
    </View>
  );
}

/**
 * Submitted. The one thing worth being precise about is *what has not happened
 * yet*: an owner who reads "registered" believes their hostel is listed.
 */
function SubmittedView({ hostelName }: { hostelName: string }) {
  return (
    <Screen
      footer={
        <View className="gap-2">
          <Button
            label="Explore plans & pricing"
            onPress={() => router.replace("/pricing")}
          />
          <Button
            label="Done"
            onPress={() => router.replace("/register-hostel")}
            variant="ghost"
          />
        </View>
      }
      header={<AppBar title="" />}
    >
      <View className="flex-1 items-center justify-center gap-3 px-4 pt-16">
        <Lottie loop={false} size={180} source={SENT_ANIMATION} />
        <Text className="text-center" variant="title">
          {hostelName} is with the review team
        </Text>
        <Text className="text-center" variant="muted">
          We&apos;ll verify your documents and email you within 1–2 business
          days. Until then, explore our plans and pricing.
        </Text>
      </View>
    </Screen>
  );
}
