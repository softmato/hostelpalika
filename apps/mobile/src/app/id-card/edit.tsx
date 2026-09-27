import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View, type ViewStyle } from "react-native";

import { GuidedCapture, type GuideShape } from "@/components/guided-capture";
import { SignatureInk, SignaturePad } from "@/components/signature-pad";
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
import { FieldLabel, Input } from "@/components/ui/input";
import { Lottie } from "@/components/ui/lottie";
import { Screen } from "@/components/ui/screen";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { revalidateSession } from "@/lib/auth-session";
import {
  draftFromProfile,
  firstIncompleteIdentityStep,
  hasIdentityErrors,
  idCardNoun,
  idCardTypeForAccount,
  IDENTITY_STEPS,
  identityStepComplete,
  isResidentPhone,
  type IdentityDraft,
  type IdentityErrors,
  type IdentityStep,
  type IdentityTextField,
  toProfileInput,
  validateIdentity,
  validateIdentityStep,
} from "@/lib/id-card";
import {
  type BloodGroup,
  checkIdentityEmail,
  checkIdentityPhone,
  type DietaryPreference,
  type EmailCheckStatus,
  type Gender,
  type GovernmentIdType,
  type IdentityResponse,
  identityPhotoSource,
  identitySignatureSource,
  type Occupation,
  saveIdentity,
} from "@/lib/identity-api";
import {
  clearIdentityDraft,
  type IdentityDraftSnapshot,
  readIdentityDraft,
  saveIdentityDraft,
} from "@/lib/identity-draft";
import { residentQuery } from "@/lib/resident-queries";
import { signatureStrokes } from "@/lib/signature";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

/**
 * The one-time profile behind the ID card, collected one question-group at a
 * time.
 *
 * ## Why this is a sequence and not a form
 *
 * What is being collected is a KYC pack — name, address, guardian, government
 * ID, a face and a signature. As a single page it was a wall of seven cards and
 * thirty-odd fields, and the problem with a wall is not its length but that you
 * cannot see the end of it: somebody opening it has no idea whether this is a
 * two-minute job or a twenty-minute one, and that judgement is made before the
 * first field is touched. A counter and a bar answer it up front. The banking
 * apps in `ui_inspiration_folder` all collect exactly this sort of pack exactly
 * this way, and the residents using this app have already been through that
 * flow at eSewa and their bank.
 *
 * The steps themselves live in `lib/id-card.ts` — order, titles, which fields
 * each one owns, and what "done" means for each. This file is how they look.
 *
 * ## Editing opens on Review
 *
 * A first-time holder walks the steps. Somebody coming back to fix their phone
 * number lands on Review and taps Edit beside Contact — nobody should page
 * through eight screens to change one line. Same rule the finance screens
 * already follow: facts, with a per-section Edit.
 *
 * ## Photo and signature are steps, not attachments
 *
 * Both print on the card, so both are asked for in the run rather than left to
 * be discovered afterwards. Each uploads the moment it is captured and rides
 * along with the save as a handle, so the server attaches them in the same
 * write — a first save without a photo is refused outright, and the signature
 * can be either drawn on the glass or photographed off paper.
 *
 * ## The email is the sign-in email
 *
 * Filled in from the account and locked whenever the account has one; the
 * server overwrites it anyway, so a client cannot put someone else's address on
 * a card. Only an account with no email types one, and that is checked live
 * against every other account once typing pauses.
 *
 * ## Saving mints the ID
 *
 * The first save allocates the resident id and emails the card once, then lands
 * on the card rather than going back — the form was never the destination. A
 * later edit goes back, because the card is where they were.
 */

const GENDER_OPTIONS: { label: string; value: Gender }[] = [
  { label: "Male", value: "MALE" },
  { label: "Female", value: "FEMALE" },
  { label: "Other", value: "OTHER" },
  { label: "Prefer not to say", value: "PREFER_NOT_TO_SAY" },
];

/** `UNKNOWN` last and worded as a choice, as on the web. */
const BLOOD_OPTIONS: { label: string; value: BloodGroup }[] = [
  { label: "A+", value: "A+" },
  { label: "A-", value: "A-" },
  { label: "B+", value: "B+" },
  { label: "B-", value: "B-" },
  { label: "AB+", value: "AB+" },
  { label: "AB-", value: "AB-" },
  { label: "O+", value: "O+" },
  { label: "O-", value: "O-" },
  { label: "I do not know", value: "UNKNOWN" },
];

const OCCUPATION_OPTIONS: { label: string; value: Occupation }[] = [
  { label: "Student", value: "STUDENT" },
  { label: "Working professional", value: "WORKING_PROFESSIONAL" },
  { label: "Neither", value: "OTHER" },
];

const DIET_OPTIONS: { label: string; value: DietaryPreference }[] = [
  { label: "No preference", value: "NO_PREFERENCE" },
  { label: "Vegetarian", value: "VEG" },
  { label: "Non-vegetarian", value: "NON_VEG" },
  { label: "Eggetarian", value: "EGGETARIAN" },
  { label: "Vegan", value: "VEGAN" },
];

const ID_TYPE_OPTIONS: { label: string; value: GovernmentIdType }[] = [
  { label: "Citizenship", value: "CITIZENSHIP" },
  { label: "National ID", value: "NATIONAL_ID" },
  { label: "Passport", value: "PASSPORT" },
  { label: "Driving license", value: "DRIVING_LICENSE" },
  { label: "Student ID", value: "STUDENT_ID" },
  { label: "Other", value: "OTHER" },
];

const GENDER_LABELS = new Map(GENDER_OPTIONS.map((o) => [o.value, o.label]));
const OCCUPATION_LABELS = new Map(
  OCCUPATION_OPTIONS.map((o) => [o.value, o.label]),
);
const DIET_LABELS = new Map(DIET_OPTIONS.map((o) => [o.value, o.label]));
const ID_TYPE_LABELS = new Map(ID_TYPE_OPTIONS.map((o) => [o.value, o.label]));

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type EmailCheck = "idle" | "checking" | EmailCheckStatus;

/**
 * Asks the server whether an email or phone is free once typing pauses. A new
 * keystroke cancels the pending ask, and an answer is kept with the value it
 * was for, so a slow one for an older value never shows against a newer one.
 * The save re-checks; this makes the refusal early.
 */
function useContactCheck(
  kind: "email" | "phone",
  raw: string,
  enabled: boolean,
): EmailCheck {
  const value = kind === "email" ? raw.trim().toLowerCase() : raw.trim();
  const checkable =
    enabled &&
    (kind === "email" ? EMAIL_PATTERN.test(value) : isResidentPhone(value));
  const [answer, setAnswer] = useState<{
    status: EmailCheck;
    value: string;
  } | null>(null);

  useEffect(() => {
    if (!checkable) {
      return;
    }

    let current = true;

    const timer = setTimeout(() => {
      (kind === "email" ? checkIdentityEmail(value) : checkIdentityPhone(value))
        .then((result) => {
          if (current) {
            setAnswer({ status: result.status, value });
          }
        })
        // Rate limited or offline: say nothing rather than guess.
        .catch(() => {
          if (current) {
            setAnswer({ status: "idle", value });
          }
        });
    }, 600);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [checkable, kind, value]);

  if (!checkable) {
    return "idle";
  }

  return answer?.value === value ? answer.status : "checking";
}

const PHONE_TAKEN = "Already used by another account. Use your own number.";

export default function EditIdentityScreen() {
  const identityQuery = residentQuery.identity();
  const identity = useResource<IdentityResponse>(identityQuery.load, {
    cacheKey: identityQuery.key,
    topics: identityQuery.topics,
  });
  const account = useAppSelector((state) => state.auth.account);
  const accountId = account?.id ?? "";
  /** `undefined` while the phone is still being asked for a saved draft. */
  const [stored, setStored] = useState<
    IdentityDraftSnapshot | null | undefined
  >(undefined);

  useEffect(() => {
    let live = true;

    void readIdentityDraft(accountId).then((snapshot) => {
      if (live) {
        setStored(snapshot);
      }
    });

    return () => {
      live = false;
    };
  }, [accountId]);

  // Named from the cached account, so the title is right from the first frame
  // — the loading and error states render this same bar.
  const cardNoun = idCardNoun(
    idCardTypeForAccount({
      isServiceProvider: account?.isServiceProvider,
      role: account?.role ?? "PUBLIC",
    }),
  );

  if (identity.loading || stored === undefined) {
    return (
      // Drawn as step 1 itself, so arriving from "Create my card" reads as one move.
      <StepSkeleton
        subtitle={IDENTITY_STEPS[0]!.subtitle}
        title={IDENTITY_STEPS[0]!.title}
        total={IDENTITY_STEPS.length}
      />
    );
  }

  if (identity.error || !identity.data) {
    return (
      <Screen
        header={<AppBar showBack subtitle="Your details" title="Your ID" />}
      >
        <ErrorState
          message={identity.error ?? "Your details could not be loaded."}
          onRetry={identity.reload}
        />
      </Screen>
    );
  }

  return (
    <IdentityWizard
      accountId={accountId}
      cardNoun={cardNoun}
      response={identity.data}
      stored={stored}
    />
  );
}

/** What each step screen is handed. Keeps the field helpers out of nine props. */
type FormControl = {
  draft: IdentityDraft;
  errors: IdentityErrors;
  set: <K extends keyof IdentityDraft>(
    field: K,
    value: IdentityDraft[K],
  ) => void;
};

const REVIEW_INDEX = IDENTITY_STEPS.length - 1;

function IdentityWizard({
  accountId,
  cardNoun,
  response,
  stored,
}: {
  accountId: string;
  cardNoun: string;
  response: IdentityResponse;
  /** The autosaved form from last time, which outranks the server's copy. */
  stored: IdentityDraftSnapshot | null;
}) {
  const token = useAppSelector((state) => state.auth.accessToken);
  const { identity, profile } = response;

  const [draft, setDraft] = useState<IdentityDraft>(() => {
    if (stored) {
      return stored.draft;
    }

    const loaded = draftFromProfile(profile);

    return {
      ...loaded,
      fullName: loaded.fullName || identity.accountName,
      // The sign-in email outranks whatever an older save stored.
      primaryEmail: identity.accountEmail || loaded.primaryEmail || "",
    };
  });
  // Raw comma-separated text: a chip editor cannot express "still typing".
  const [interestsText, setInterestsText] = useState(
    stored?.interestsText ?? (profile?.interests ?? []).join(", "),
  );
  // Changed from the card screen, not here; the save sends it back unchanged.
  const [sharingEnabled] = useState(
    stored?.sharingEnabled ?? identity.sharingEnabled,
  );
  const [errors, setErrors] = useState<IdentityErrors>({});
  const [saving, setSaving] = useState(false);
  const [signing, setSigning] = useState(false);
  /** Terms and privacy consent; only a first save asks, and Create waits on it. */
  const [agreed, setAgreed] = useState(false);
  /** A first save lands on the success screen before the card. */
  const [done, setDone] = useState(false);

  const isFirstSave = !identity.hasProfile;

  /*
   * An edit opens on Review. Somebody who already has a card came back to
   * change one thing, and nine screens between them and it is nine screens of
   * other people's decisions.
   */
  const [index, setIndex] = useState(
    stored?.index ?? (isFirstSave ? 0 : REVIEW_INDEX),
  );
  /** Which way the next screen slides in from. */
  const [forward, setForward] = useState(true);

  const [photoUri, setPhotoUri] = useState<string | null>(
    stored?.photoUri ?? null,
  );
  const [photoAssetId, setPhotoAssetId] = useState<string | null>(
    stored?.photoAssetId ?? null,
  );
  const [signatureUri, setSignatureUri] = useState<string | null>(
    stored?.signatureUri ?? null,
  );
  const [signatureAssetId, setSignatureAssetId] = useState<string | null>(
    stored?.signatureAssetId ?? null,
  );

  /*
   * Autosave: one second after the last change, the whole form goes to the
   * phone. The first snapshot is the form as it opened, and nothing is written
   * until something differs from it — opening and leaving is not a draft.
   * `saved` stops a timer from the last keystroke re-writing a draft the
   * successful save has just cleared.
   */
  const snapshot = useMemo<IdentityDraftSnapshot>(
    () => ({
      draft,
      index,
      interestsText,
      photoAssetId,
      photoUri,
      sharingEnabled,
      signatureAssetId,
      signatureUri,
    }),
    [
      draft,
      index,
      interestsText,
      photoAssetId,
      photoUri,
      sharingEnabled,
      signatureAssetId,
      signatureUri,
    ],
  );
  const opened = useRef(JSON.stringify(snapshot));
  const saved = useRef(false);

  useEffect(() => {
    if (JSON.stringify(snapshot) === opened.current) {
      return;
    }

    const timer = setTimeout(() => {
      if (!saved.current) {
        void saveIdentityDraft(accountId, snapshot);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [accountId, snapshot]);

  useEffect(() => {
    if (stored) {
      toastSuccess("Picked up where you left off");
    }
    // Once, for the draft this screen opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [uploading, setUploading] = useState<null | GuideShape>(null);
  const [camera, setCamera] = useState<null | GuideShape>(null);

  const photoSource = photoUri
    ? { uri: photoUri }
    : identityPhotoSource(identity, token);
  const signatureSource = signatureUri
    ? { uri: signatureUri }
    : identitySignatureSource(identity, token);

  const hasPhoto = Boolean(photoAssetId || identity.hasPhoto);
  const hasSignatureImage = Boolean(
    signatureAssetId || identity.hasSignatureImage,
  );

  const emailLocked = Boolean(identity.accountEmail);
  const emailCheck = useContactCheck("email", draft.primaryEmail, !emailLocked);
  // Only a number being set or changed is checked — the save applies the same rule.
  const phoneCheck = useContactCheck(
    "phone",
    draft.primaryPhone,
    draft.primaryPhone.trim() !== (profile?.primaryPhone ?? "").trim(),
  );

  const set = useCallback(
    <K extends keyof IdentityDraft>(field: K, value: IdentityDraft[K]) => {
      setDraft((current) => ({ ...current, [field]: value }));
      // The error under a field is about what *was* there. Clearing it as soon
      // as the field is touched is the difference between a form that corrects
      // you and one that nags.
      setErrors((current) =>
        current[field] ? { ...current, [field]: undefined } : current,
      );
    },
    [],
  );

  /** The draft with the comma-separated interests box folded back in. */
  const full = useMemo<IdentityDraft>(
    () => ({ ...draft, interests: interestsText.split(",") }),
    [draft, interestsText],
  );

  const step = IDENTITY_STEPS[index]!;
  const assets = { hasPhoto, hasSignatureImage };

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
    const found = validateIdentityStep(step.key, full);

    if (!emailLocked && step.key === "contact" && emailCheck === "TAKEN") {
      found.primaryEmail =
        "Already used by another account. Use a different one.";
    }

    if (step.key === "contact" && phoneCheck === "TAKEN" && !found.primaryPhone) {
      found.primaryPhone = PHONE_TAKEN;
    }

    if (step.key === "photo" && !hasPhoto) {
      toastError("Your photo is missing", "It goes on the front of your card.");

      return;
    }

    setErrors(found);

    if (hasIdentityErrors(found)) {
      return;
    }

    goTo(Math.min(REVIEW_INDEX, index + 1), true);
  }, [emailCheck, emailLocked, full, goTo, hasPhoto, index, phoneCheck, step.key]);

  /** Uploads a captured file and remembers its handle for the save. */
  const attach = useCallback(
    async (shape: GuideShape, uri: string) => {
      const label = shape === "face" ? "ID card photo" : "Signature";

      if (shape === "face") {
        setPhotoUri(uri);
      } else {
        setSignatureUri(uri);
        // The two signatures are exclusive, and the draft is what the payload
        // is built from — leaving strokes behind would send both.
        set("signature", "");
        set("signatureImageUri", uri);
      }

      setUploading(shape);

      try {
        const assetId = await uploadAsset({ uri }, { kind: "GENERIC", label });

        if (shape === "face") {
          setPhotoAssetId(assetId);
        } else {
          setSignatureAssetId(assetId);
        }
      } catch (caught) {
        if (shape === "face") {
          setPhotoUri(null);
        } else {
          setSignatureUri(null);
          set("signatureImageUri", "");
        }

        toastError(
          `Could not upload that ${label.toLowerCase()}`,
          readApiError(caught),
        );
      } finally {
        setUploading(null);
      }
    },
    [set],
  );

  /** The gallery, for a photo somebody already has. Square crop, as the card is. */
  const pickPhotoFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to pick your photo.");

      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ["images"],
      quality: 0.85,
    });
    const picked = result.canceled ? null : result.assets[0];

    if (picked) {
      await attach("face", picked.uri);
    }
  }, [attach]);

  const submit = useCallback(async () => {
    const found = validateIdentity(full);

    if (!emailLocked && emailCheck === "TAKEN") {
      found.primaryEmail =
        "Already used by another account. Use a different one.";
    }

    if (phoneCheck === "TAKEN" && !found.primaryPhone) {
      found.primaryPhone = PHONE_TAKEN;
    }

    setErrors(found);

    if (uploading) {
      toastError("Something is still uploading", "Try again in a moment.");

      return;
    }

    const incomplete = firstIncompleteIdentityStep(full, assets);

    if (incomplete || hasIdentityErrors(found)) {
      const target = IDENTITY_STEPS.findIndex(
        (entry) => entry.key === incomplete,
      );

      toastError("Some details need fixing", "The ones in red.");

      if (target >= 0) {
        goTo(target, false);
      }

      return;
    }

    setSaving(true);

    try {
      await saveIdentity({
        ...(photoAssetId ? { photoAssetId } : {}),
        profile: toProfileInput(full),
        ...(signatureAssetId ? { signatureAssetId } : {}),
        sharingEnabled,
      });

      saved.current = true;
      void clearIdentityDraft(accountId);

      if (isFirstSave) {
        // The save minted the id; `/auth/me`'s `userResidentId` is now stale.
        // Not awaited — the card does not depend on it.
        void revalidateSession();
        // The success screen's button `replace`s to the card, so backing out
        // of the card leaves rather than reopening the form.
        setDone(true);

        return;
      }

      toastSuccess("Details saved");
      router.back();
    } catch (caught) {
      toastError("Could not save your details", readApiError(caught));
    } finally {
      setSaving(false);
    }
  }, [
    accountId,
    assets,
    emailCheck,
    emailLocked,
    full,
    goTo,
    isFirstSave,
    phoneCheck,
    photoAssetId,
    sharingEnabled,
    signatureAssetId,
    uploading,
  ]);

  const control: FormControl = { draft, errors, set };
  const onReview = step.key === "review";
  const animation = STEP_ANIMATIONS[step.key];

  if (done) {
    return (
      <Screen
        footer={
          <Button
            label="View my ID"
            onPress={() => router.replace("/id-card")}
          />
        }
        header={<AppBar title="" />}
      >
        <View className="flex-1 items-center justify-center gap-3 px-4 pt-16">
          <Lottie loop={false} size={180} source={SUCCESS_ANIMATION} />
          <Text className="text-center" variant="title">
            Your ID is ready!
          </Text>
          <Text className="text-center" variant="muted">
            Any hostel can now register you from your QR code or your {cardNoun}{" "}
            ID.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <>
      <StepFrame
        footer={
          <Button
            label={
              onReview
                ? isFirstSave
                  ? "Create my ID"
                  : "Save changes"
                : continueLabel(step.key, full, assets)
            }
            // Looks off until the terms are ticked, but still answers a tap with why.
            className={onReview && isFirstSave && !agreed ? "opacity-50" : undefined}
            loading={onReview && saving}
            onPress={
              onReview
                ? () => {
                    if (isFirstSave && !agreed) {
                      toastError(
                        "Agree to the terms first",
                        "Tick the Terms and Privacy Policy box above.",
                      );

                      return;
                    }

                    void submit();
                  }
                : advance
            }
          />
        }
        actions={
          step.key === "work" ? (
            <Pressable hitSlop={10} onPress={() => goTo(index + 1, true)}>
              <Text className="text-primary" variant="label">
                Skip
              </Text>
            </Pressable>
          ) : undefined
        }
        forward={forward}
        onBack={back}
        position={index + 1}
        scrollEnabled={!signing}
        stepKey={step.key}
        subtitle={step.subtitle}
        title={step.title}
        total={IDENTITY_STEPS.length}
      >
          {animation ? (
            <View className="items-center">
              {/* The location and guardian artwork carry more padding in their frames than the others. */}
              <Lottie
                size={
                  step.key === "address" || step.key === "guardian" ? 170 : 120
                }
                source={animation}
              />
            </View>
          ) : null}

          {step.key === "about" ? <AboutStep control={control} /> : null}
          {step.key === "contact" ? (
            <ContactStep
              check={emailCheck}
              control={control}
              locked={emailLocked}
              phoneCheck={phoneCheck}
            />
          ) : null}
          {step.key === "address" ? <AddressStep control={control} /> : null}
          {step.key === "work" ? <WorkStep control={control} /> : null}
          {step.key === "guardian" ? <GuardianStep control={control} /> : null}
          {step.key === "preferences" ? (
            <PreferencesStep
              control={control}
              interestsText={interestsText}
              onInterestsChange={setInterestsText}
            />
          ) : null}
          {step.key === "photo" ? (
            <PhotoStep
              busy={uploading === "face"}
              onOpenCamera={() => setCamera("face")}
              onPickFromLibrary={() => void pickPhotoFromLibrary()}
              source={photoSource}
            />
          ) : null}
          {step.key === "signature" ? (
            <SignatureStep
              busy={uploading === "signature"}
              control={control}
              hasImage={hasSignatureImage}
              onOpenCamera={() => setCamera("signature")}
              onSigningChange={setSigning}
              source={signatureSource}
            />
          ) : null}
          {step.key === "review" ? (
            <ReviewStep
              assets={assets}
              cardNoun={cardNoun}
              draft={full}
              interestsText={interestsText}
              onEdit={(key) =>
                goTo(
                  IDENTITY_STEPS.findIndex((entry) => entry.key === key),
                  false,
                )
              }
              agreed={isFirstSave ? agreed : null}
              onAgreedChange={setAgreed}
              photoSource={photoSource}
              signatureSource={signatureSource}
            />
          ) : null}
      </StepFrame>

      <GuidedCapture
        onCancel={() => setCamera(null)}
        onConfirm={(uri) => {
          const shape = camera;

          setCamera(null);

          if (shape) {
            void attach(shape, uri);
          }
        }}
        shape={camera ?? "face"}
        visible={camera !== null}
      />
    </>
  );
}

/* `require` paths are case-sensitive on the Linux build machines — `Location` keeps its capital. */
const STEP_ANIMATIONS: Partial<Record<IdentityStep, number>> = {
  about: require("../../../assets/lottie/about.lottie"),
  address: require("../../../assets/lottie/Location.lottie"),
  guardian: require("../../../assets/lottie/guardian.lottie"),
  work: require("../../../assets/lottie/work.lottie"),
};
const SUCCESS_ANIMATION = require("../../../assets/lottie/success.lottie");

/**
 * "Skip" rather than "Continue" on a step where nothing has been filled in and
 * nothing is required — so the way past it is stated rather than guessed at.
 */
function continueLabel(
  step: IdentityStep,
  draft: IdentityDraft,
  assets: { hasPhoto: boolean; hasSignatureImage: boolean },
): string {
  const optional = step === "work" || step === "preferences";
  const untouched =
    optional &&
    !hasIdentityErrors(validateIdentityStep(step, draft)) &&
    isBlank(step, draft);

  if (untouched) {
    return "Skip";
  }

  return step === "signature" && identityStepComplete(step, draft, assets)
    ? "Review"
    : "Continue";
}

/** Whether an optional step has been left entirely alone. */
function isBlank(step: IdentityStep, draft: IdentityDraft): boolean {
  if (step === "address") {
    return (
      !draft.permanentAddress.trim() &&
      !draft.city.trim() &&
      !draft.province.trim()
    );
  }

  if (step === "work") {
    return !draft.institution.trim() && !draft.courseOrDesignation.trim();
  }

  return (
    !draft.budgetRange.trim() &&
    !draft.medicalNotes.trim() &&
    !draft.governmentIdNumber.trim() &&
    draft.interests.length === 0
  );
}

const PROVINCES = [
  "Koshi",
  "Madhesh",
  "Bagmati",
  "Gandaki",
  "Lumbini",
  "Karnali",
  "Sudurpashchim",
];

const INTEREST_PRESETS = [
  "Music",
  "Sports",
  "Travel",
  "Books",
  "Movies",
  "Gaming",
  "Cooking",
  "Art",
];

/* ── steps ── */

function AboutStep({ control }: { control: FormControl }) {
  const { draft, errors, set } = control;

  return (
    <View className="gap-6">
      <TextField control={control} label="Full name" name="fullName" required />
      <ChoiceChips
        columns={2}
        error={errors.gender}
        label="Gender *"
        onToggle={(value) => set("gender", value)}
        options={GENDER_OPTIONS}
        value={draft.gender}
      />
      <DatePickerField control={control} name="dateOfBirth" />
      <ChoiceChips
        columns={4}
        label="Blood group"
        // Tapping the chosen group again takes it back to "not known".
        onToggle={(value) =>
          set("bloodGroup", draft.bloodGroup === value ? "UNKNOWN" : value)
        }
        options={BLOOD_OPTIONS.filter((option) => option.value !== "UNKNOWN")}
        value={draft.bloodGroup}
      />
    </View>
  );
}

function ContactStep({
  check,
  control,
  locked,
  phoneCheck,
}: {
  check: EmailCheck;
  control: FormControl;
  locked: boolean;
  phoneCheck: EmailCheck;
}) {
  const { colors } = useAppTheme();
  const good = !locked && (check === "AVAILABLE" || check === "YOURS");
  const hint = locked
    ? "Your sign-in email — filled in for you."
    : check === "checking"
      ? "Checking…"
      : check === "AVAILABLE"
        ? "Looks good!"
        : check === "YOURS"
          ? "Your account's email"
          : undefined;
  const phoneGood = phoneCheck === "AVAILABLE" || phoneCheck === "YOURS";
  // TAKEN is said the moment it is known, not only when Next is pressed.
  const phoneError =
    control.errors.primaryPhone ?? (phoneCheck === "TAKEN" ? PHONE_TAKEN : undefined);
  const phoneHint =
    phoneCheck === "checking"
      ? "Checking…"
      : phoneCheck === "AVAILABLE"
        ? "Looks good!"
        : phoneCheck === "YOURS"
          ? "Your account's phone"
          : undefined;
  const checkMark = (
    <Ionicons color={colors.primary} name="checkmark-circle" size={18} />
  );

  return (
    <View className="gap-6">
      <Input
        error={phoneError}
        hint={phoneHint}
        keyboardType="phone-pad"
        label="Main phone *"
        onChangeText={(value) => control.set("primaryPhone", value)}
        placeholder="98XXXXXXXX"
        tone={phoneGood ? "success" : undefined}
        trailing={phoneGood ? checkMark : null}
        value={control.draft.primaryPhone}
        variant="line"
      />
      <TextField
        control={control}
        keyboardType="phone-pad"
        label="Second phone"
        name="alternatePhone"
        placeholder="98XXXXXXXX"
      />
      <Input
        autoCapitalize="none"
        autoComplete="email"
        editable={!locked}
        error={control.errors.primaryEmail}
        hint={hint}
        keyboardType="email-address"
        label="Main email *"
        onChangeText={(value) => control.set("primaryEmail", value)}
        tone={good ? "success" : undefined}
        trailing={good ? checkMark : null}
        value={control.draft.primaryEmail}
        variant="line"
      />
      <TextField
        control={control}
        hint="Must be different from your main email."
        keyboardType="email-address"
        label="Backup email"
        name="backupEmail"
      />
    </View>
  );
}

function AddressStep({ control }: { control: FormControl }) {
  const current = control.draft.province.trim();
  // A province typed before this became a picker still shows, rather than vanishing.
  const provinces =
    current && !PROVINCES.includes(current)
      ? [...PROVINCES, current]
      : PROVINCES;

  return (
    <View className="gap-6">
      <TextField
        control={control}
        label="Permanent address"
        name="permanentAddress"
        placeholder="Ward 5, Tinkune"
        required
      />
      <TextField
        control={control}
        label="City"
        name="city"
        placeholder="Kathmandu"
        required
      />
      <Select
        error={control.errors.province}
        label="Province *"
        onChange={(value) => control.set("province", value)}
        options={provinces.map((name) => ({ label: name, value: name }))}
        placeholder="Select"
        value={current || null}
        variant="line"
      />
    </View>
  );
}

function WorkStep({ control }: { control: FormControl }) {
  return (
    <View className="gap-6">
      <ChoiceChips
        label="Occupation"
        onToggle={(value) => control.set("occupation", value)}
        options={OCCUPATION_OPTIONS}
        value={control.draft.occupation}
      />
      <TextField
        control={control}
        label="Institution"
        name="institution"
        placeholder="College or company"
      />
      <TextField
        control={control}
        label="Course or designation"
        name="courseOrDesignation"
        placeholder="BSc. Computer Science"
      />
    </View>
  );
}

function GuardianStep({ control }: { control: FormControl }) {
  const { draft, errors } = control;
  const has = (...fields: IdentityTextField[]) =>
    fields.some((field) => draft[field].trim());
  const failing = (...fields: IdentityTextField[]) =>
    fields.some((field) => errors[field]);

  const second = [
    "secondGuardianName",
    "secondGuardianRelation",
    "secondGuardianPhone",
    "secondGuardianEmail",
  ] as const;
  const emergency = [
    "emergencyContactName",
    "emergencyContactRelation",
    "emergencyContactPhone",
  ] as const;

  return (
    <View>
      <Accordion
        caption="The hostel's first call about you"
        defaultOpen
        forceOpen={failing(
          "guardianName",
          "guardianRelation",
          "guardianPhone",
          "guardianEmail",
        )}
        title="Primary guardian *"
      >
        <TextField
          control={control}
          label="Name"
          name="guardianName"
          required
        />
        <TextField
          control={control}
          label="Relation"
          name="guardianRelation"
          placeholder="Father, mother…"
          required
        />
        <TextField
          control={control}
          keyboardType="phone-pad"
          label="Phone"
          name="guardianPhone"
          required
        />
        <TextField
          control={control}
          keyboardType="email-address"
          label="Email"
          name="guardianEmail"
        />
      </Accordion>

      <Accordion
        caption="Optional — another parent or relative"
        defaultOpen={has(...second)}
        forceOpen={failing(...second)}
        title="Second guardian"
      >
        <TextField control={control} label="Name" name="secondGuardianName" />
        <TextField
          control={control}
          label="Relation"
          name="secondGuardianRelation"
        />
        <TextField
          control={control}
          keyboardType="phone-pad"
          label="Phone"
          name="secondGuardianPhone"
        />
        <TextField
          control={control}
          keyboardType="email-address"
          label="Email"
          name="secondGuardianEmail"
        />
      </Accordion>

      <Accordion
        caption="Optional — only if someone other than your guardian should be called in an emergency. Left blank, we call your guardian."
        defaultOpen={has(...emergency)}
        forceOpen={failing(...emergency)}
        title="Emergency contact"
      >
        <TextField control={control} label="Name" name="emergencyContactName" />
        <TextField
          control={control}
          label="Relation"
          name="emergencyContactRelation"
        />
        <TextField
          control={control}
          keyboardType="phone-pad"
          label="Phone"
          name="emergencyContactPhone"
        />
      </Accordion>
    </View>
  );
}

/** Short chip labels; the long ones in `DIET_OPTIONS` still read out on Review. */
const DIET_CHIPS: { label: string; value: DietaryPreference }[] = [
  { label: "Any", value: "NO_PREFERENCE" },
  { label: "Veg", value: "VEG" },
  { label: "Non-veg", value: "NON_VEG" },
  { label: "Egg", value: "EGGETARIAN" },
  { label: "Vegan", value: "VEGAN" },
];

/** Budget is free text at the server; these are the ranges a hostel actually prices in. */
const BUDGET_CHIPS = [
  { label: "Under 8k", value: "0-8000" },
  { label: "8k – 12k", value: "8000-12000" },
  { label: "12k – 18k", value: "12000-18000" },
  { label: "18k +", value: "18000+" },
];

/** `""` is "Not now": the ID is optional, and saying so is a choice rather than a gap. */
const ID_TYPE_CHIPS: { label: string; value: GovernmentIdType | "" }[] = [
  { label: "Not now", value: "" },
  { label: "Citizenship", value: "CITIZENSHIP" },
  { label: "National ID", value: "NATIONAL_ID" },
  { label: "Passport", value: "PASSPORT" },
  { label: "License", value: "DRIVING_LICENSE" },
  { label: "Student ID", value: "STUDENT_ID" },
  { label: "Other", value: "OTHER" },
];

function PreferencesStep({
  control,
  interestsText,
  onInterestsChange,
}: {
  control: FormControl;
  interestsText: string;
  onInterestsChange: (value: string) => void;
}) {
  const { draft, errors, set } = control;
  const chosen = interestsText
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Values saved before these chips existed stay visible and removable.
  const interests = [...new Set([...INTEREST_PRESETS, ...chosen])].map(
    (name) => ({
      label: name,
      value: name,
    }),
  );
  const budget = draft.budgetRange.trim();
  const budgets =
    budget && !BUDGET_CHIPS.some((chip) => chip.value === budget)
      ? [...BUDGET_CHIPS, { label: budget, value: budget }]
      : BUDGET_CHIPS;

  return (
    <View className="gap-7">
      <StepSection title="Food and budget">
        <ChoiceChips
          label="Dietary preference"
          onToggle={(value) => set("dietaryPreference", value)}
          options={DIET_CHIPS}
          value={draft.dietaryPreference}
        />
        <ChoiceChips
          columns={2}
          label="Monthly budget (NPR)"
          // Tapping the chosen range again clears it — budget is optional.
          onToggle={(value) =>
            set("budgetRange", budget === value ? "" : value)
          }
          options={budgets}
          value={budget}
        />
      </StepSection>

      <StepSection caption="Pick any that fit" title="Interests">
        <ChoiceChips
          error={errors.interests}
          onToggle={(value) =>
            onInterestsChange(
              (chosen.includes(value)
                ? chosen.filter((entry) => entry !== value)
                : [...chosen, value]
              ).join(", "),
            )
          }
          options={interests}
          value={chosen}
        />
      </StepSection>

      <StepSection
        caption="Only staff see this, and only in an emergency"
        title="Health"
      >
        <TextField
          control={control}
          label="Allergies or medical notes"
          multiline
          name="medicalNotes"
        />
      </StepSection>

      <StepSection
        caption="Saves reading it out at the hostel desk"
        title="Government ID"
      >
        <ChoiceChips
          columns={2}
          onToggle={(value) => {
            const clearing = value === "" || draft.governmentIdType === value;

            set("governmentIdType", clearing ? "" : value);
            // A number with no type is a number nobody can check, so it goes with the type.
            if (clearing) {
              set("governmentIdNumber", "");
            }
          }}
          options={ID_TYPE_CHIPS}
          value={draft.governmentIdType}
        />
        {draft.governmentIdType ? (
          <TextField
            control={control}
            label="ID number"
            name="governmentIdNumber"
          />
        ) : null}
      </StepSection>
    </View>
  );
}

function PhotoStep({
  busy,
  onOpenCamera,
  onPickFromLibrary,
  source,
}: {
  busy: boolean;
  onOpenCamera: () => void;
  onPickFromLibrary: () => void;
  source: { uri: string } | null;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="gap-6">
      <View className="items-center py-2">
        <View
          className="items-center justify-center rounded-full border-2 border-primary p-1.5"
          style={{ height: 212, width: 212 }}
        >
          <View className="size-full items-center justify-center overflow-hidden rounded-full bg-muted">
            {source ? (
              <Image
                contentFit="cover"
                source={source}
                style={{ height: "100%", width: "100%" }}
              />
            ) : (
              <Ionicons
                color={colors.mutedForeground}
                name="person"
                size={84}
              />
            )}
          </View>
        </View>
      </View>

      <View className="gap-3">
        <Button
          disabled={busy}
          label={source ? "Take again" : "Take photo"}
          loading={busy}
          onPress={onOpenCamera}
        />
        <Button
          disabled={busy}
          label="Choose from gallery"
          onPress={onPickFromLibrary}
          variant="outline"
        />
      </View>

      <View className="flex-row items-center gap-2">
        <Ionicons
          color={colors.mutedForeground}
          name="information-circle-outline"
          size={18}
        />
        <Text className="flex-1" variant="caption">
          Make sure your face is well lit and clearly visible.
        </Text>
      </View>
    </View>
  );
}

function SignatureStep({
  busy,
  control,
  hasImage,
  onOpenCamera,
  onSigningChange,
  source,
}: {
  busy: boolean;
  control: FormControl;
  hasImage: boolean;
  onOpenCamera: () => void;
  onSigningChange: (active: boolean) => void;
  source: { uri: string } | null;
}) {
  const [mode, setMode] = useState<"draw" | "photo">(
    hasImage ? "photo" : "draw",
  );
  // Remounting the pad is how "Draw again" empties it — its strokes are its own state.
  const [padKey, setPadKey] = useState(0);
  const showImage =
    Boolean(control.draft.signatureImageUri) || (mode === "photo" && hasImage);

  return (
    <View className="gap-6">
      {showImage && source ? (
        <View
          className="overflow-hidden rounded-2xl border border-dashed border-muted-foreground/50"
          style={{ aspectRatio: 1.4 }}
        >
          <Image
            contentFit="contain"
            source={source}
            style={{ height: "100%", width: "100%" }}
          />
        </View>
      ) : (
        <SignaturePad
          error={control.errors.signature}
          key={padKey}
          onActiveChange={onSigningChange}
          onChange={(value) => {
            control.set("signature", value);
            control.set("signatureImageUri", "");
          }}
          value={control.draft.signature}
        />
      )}

      <View className="gap-3">
        <Button
          label="Draw again"
          onPress={() => {
            control.set("signature", "");
            control.set("signatureImageUri", "");
            setMode("draw");
            setPadKey((key) => key + 1);
            onSigningChange(false);
          }}
        />
        <Button
          disabled={busy}
          label={showImage ? "Photograph it again" : "Photograph it on paper"}
          loading={busy}
          onPress={() => {
            setMode("photo");
            onOpenCamera();
          }}
          variant="outline"
        />
      </View>

      {showImage && control.errors.signature ? (
        <Text className="text-destructive" variant="caption">
          {control.errors.signature}
        </Text>
      ) : null}
    </View>
  );
}

/** Every step as one {@link ReviewFold} row, then the verdict and consent. */
function ReviewStep({
  agreed,
  assets,
  cardNoun,
  draft,
  interestsText,
  onEdit,
  onAgreedChange,
  photoSource,
  signatureSource,
}: {
  /** `null` on an edit: the card already exists, so consent was given. */
  agreed: boolean | null;
  onAgreedChange: (value: boolean) => void;
  assets: { hasPhoto: boolean; hasSignatureImage: boolean };
  cardNoun: string;
  draft: IdentityDraft;
  interestsText: string;
  onEdit: (step: IdentityStep) => void;
  photoSource: { uri: string } | null;
  signatureSource: { uri: string } | null;
}) {
  const { colors } = useAppTheme();
  const [signatureWidth, setSignatureWidth] = useState(0);
  const [openStep, setOpenStep] = useState<IdentityStep | null>(null);
  const dash = (value: string | undefined) => value?.trim() || "—";

  const facts: Record<Exclude<IdentityStep, "review">, [string, string][]> = {
    about: [
      ["Full name", dash(draft.fullName)],
      ["Gender", dash(GENDER_LABELS.get(draft.gender as Gender))],
      ["Date of birth", formatDate(draft.dateOfBirth) ?? "—"],
      ["Blood group", draft.bloodGroup === "UNKNOWN" ? "—" : draft.bloodGroup],
    ],
    address: [
      ["Permanent address", dash(draft.permanentAddress)],
      ["City", dash(draft.city)],
      ["Province", dash(draft.province)],
    ],
    contact: [
      ["Main phone", dash(draft.primaryPhone)],
      ["Second phone", dash(draft.alternatePhone)],
      ["Main email", dash(draft.primaryEmail)],
      ["Backup email", dash(draft.backupEmail)],
    ],
    guardian: [
      ["Guardian", dash(draft.guardianName)],
      ["Relation", dash(draft.guardianRelation)],
      ["Phone", dash(draft.guardianPhone)],
      ["Email", dash(draft.guardianEmail)],
      ["Second guardian", dash(draft.secondGuardianName)],
      [
        "Emergency contact",
        draft.emergencyContactName.trim() || "Your guardian",
      ],
    ],
    photo: [["Photo", assets.hasPhoto ? "Added" : "Not added yet"]],
    preferences: [
      ["Food", dash(DIET_LABELS.get(draft.dietaryPreference))],
      ["Monthly budget", dash(draft.budgetRange)],
      ["Interests", dash(interestsText)],
      ["Medical notes", dash(draft.medicalNotes)],
      [
        "Government ID",
        draft.governmentIdType
          ? `${ID_TYPE_LABELS.get(draft.governmentIdType) ?? ""} ${draft.governmentIdNumber}`.trim()
          : "Not now",
      ],
    ],
    signature: [
      [
        "Signature",
        assets.hasSignatureImage || draft.signatureImageUri
          ? "Photographed"
          : draft.signature
            ? "Drawn"
            : "Not signed yet",
      ],
    ],
    work: [
      ["Occupation", dash(OCCUPATION_LABELS.get(draft.occupation))],
      ["Institution", dash(draft.institution)],
      ["Course or designation", dash(draft.courseOrDesignation)],
    ],
  };

  const steps = IDENTITY_STEPS.filter((entry) => entry.key !== "review");
  const incomplete = steps.find(
    (entry) => !identityStepComplete(entry.key, draft, assets),
  );

  return (
    <View className="gap-5">
      <View>
        {steps.map((entry, position) => {
          const open = openStep === entry.key;

          return (
            <ReviewFold
              complete={identityStepComplete(entry.key, draft, assets)}
              divider={position > 0}
              key={entry.key}
              onEdit={() => onEdit(entry.key)}
              onToggle={() => setOpenStep(open ? null : entry.key)}
              open={open}
              title={`${position + 1}. ${entry.title}`}
            >
                  {entry.key === "photo" && photoSource ? (
                    <Image
                      contentFit="cover"
                      source={photoSource}
                      style={{ borderRadius: 48, height: 96, width: 96 }}
                    />
                  ) : null}
                  {entry.key === "signature" ? (
                    assets.hasSignatureImage || draft.signatureImageUri ? (
                      signatureSource ? (
                        <Image
                          contentFit="contain"
                          source={signatureSource}
                          style={{ aspectRatio: 3, width: "100%" }}
                        />
                      ) : null
                    ) : draft.signature ? (
                      <View
                        onLayout={(event) =>
                          setSignatureWidth(event.nativeEvent.layout.width)
                        }
                        style={{ aspectRatio: 3, width: "100%" }}
                      >
                        {signatureWidth > 0 ? (
                          <SignatureInk
                            color={colors.foreground}
                            height={signatureWidth / 3}
                            strokes={signatureStrokes(draft.signature)}
                            width={signatureWidth}
                          />
                        ) : null}
                      </View>
                    ) : null
                  ) : null}
                  <FactRows
                    facts={facts[entry.key as Exclude<IdentityStep, "review">]}
                  />
            </ReviewFold>
          );
        })}
      </View>

      <ReviewVerdict
        incomplete={incomplete?.title ?? null}
        onFix={() => incomplete && onEdit(incomplete.key)}
      />

      {agreed === null ? null : (
        <TermsAgreement
          agreed={agreed}
          onChange={onAgreedChange}
          prefix={`By creating your ${cardNoun} ID you agree to`}
        />
      )}
    </View>
  );
}

/* ── field helpers ── */

function TextField({
  control,
  hint,
  keyboardType,
  label,
  multiline,
  name,
  placeholder,
  required,
}: {
  control: FormControl;
  hint?: string;
  keyboardType?: "email-address" | "phone-pad";
  label: string;
  multiline?: boolean;
  name: IdentityTextField;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <Input
      autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"}
      error={control.errors[name]}
      hint={hint}
      keyboardType={keyboardType}
      label={required ? `${label} *` : label}
      multiline={multiline}
      onChangeText={(value) => control.set(name, value)}
      placeholder={placeholder}
      value={control.draft[name]}
      variant="line"
    />
  );
}

function DatePickerField({
  control,
  name = "dateOfBirth",
}: {
  control: FormControl;
  name: IdentityTextField;
}) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);
  const rawValue = control.draft[name] || "";
  const [year, setYear] = useState(2000);
  const [month, setMonth] = useState(1);
  const [day, setDay] = useState(1);

  const days = new Date(year, month, 0).getDate();
  const years = Array.from(
    { length: 77 },
    (_, i) => new Date().getFullYear() - i,
  );
  const pad = (value: number) => String(value).padStart(2, "0");

  const openCalendar = () => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawValue);

    if (match) {
      setYear(Number(match[1]));
      setMonth(Number(match[2]));
      setDay(Number(match[3]));
    }

    setOpen(true);
  };

  return (
    <View className="gap-1">
      <View style={{ opacity: rawValue ? 1 : 0 }}>
        <FieldLabel>Date of birth *</FieldLabel>
      </View>
      <Pressable
        accessibilityLabel="Date of birth"
        accessibilityRole="button"
        className={`h-11 flex-row items-center border-b active:opacity-70 ${
          control.errors[name] ? "border-destructive" : "border-border"
        }`}
        onPress={openCalendar}
      >
        <Text
          className={`flex-1 text-base ${rawValue ? "text-foreground" : "text-muted-foreground"}`}
        >
          {formatDate(rawValue) ?? "Date of birth *"}
        </Text>
        <Ionicons color={colors.primary} name="calendar-outline" size={20} />
      </Pressable>
      {control.errors[name] ? (
        <Text className="text-destructive" variant="caption">
          {control.errors[name]}
        </Text>
      ) : null}

      <Sheet
        footer={
          <Button
            label={`Set ${day} ${MONTHS[month - 1]} ${year}`}
            onPress={() => {
              control.set(name, `${year}-${pad(month)}-${pad(day)}`);
              setOpen(false);
            }}
          />
        }
        onClose={() => setOpen(false)}
        open={open}
        tall
        title="Date of birth"
      >
        <View className="gap-6 pb-2">
          <View className="gap-2">
            <FieldLabel>Year</FieldLabel>
            <ScrollView
              contentContainerStyle={{ gap: 8 }}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, height: 40 }}
            >
              {years.map((value) => (
                <CalendarCell
                  key={value}
                  label={String(value)}
                  on={value === year}
                  onPress={() => {
                    setYear(value);
                    setDay((current) =>
                      Math.min(current, new Date(value, month, 0).getDate()),
                    );
                  }}
                  style={{ height: 40, paddingHorizontal: 14 }}
                />
              ))}
            </ScrollView>
          </View>

          <View className="gap-2">
            <FieldLabel>Month</FieldLabel>
            <View
              className="flex-row flex-wrap"
              style={{ marginHorizontal: -4 }}
            >
              {MONTHS.map((label, position) => (
                <View key={label} style={{ padding: 4, width: "25%" }}>
                  <CalendarCell
                    label={label.slice(0, 3)}
                    on={position + 1 === month}
                    onPress={() => {
                      setMonth(position + 1);
                      setDay((current) =>
                        Math.min(
                          current,
                          new Date(year, position + 1, 0).getDate(),
                        ),
                      );
                    }}
                    style={{ height: 40 }}
                  />
                </View>
              ))}
            </View>
          </View>

          <View className="gap-2">
            <FieldLabel>Day</FieldLabel>
            <View
              className="flex-row flex-wrap"
              style={{ marginHorizontal: -3 }}
            >
              {Array.from({ length: days }, (_, i) => i + 1).map((value) => (
                <View key={value} style={{ padding: 3, width: `${100 / 7}%` }}>
                  <CalendarCell
                    label={String(value)}
                    on={value === day}
                    onPress={() => setDay(value)}
                    style={{ aspectRatio: 1 }}
                  />
                </View>
              ))}
            </View>
          </View>
        </View>
      </Sheet>
    </View>
  );
}

/** One tappable year, month or day. Sized by explicit styles so nothing wraps into its neighbour. */
function CalendarCell({
  label,
  on,
  onPress,
  style,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  style: ViewStyle;
}) {
  return (
    <Pressable
      className={`items-center justify-center rounded-full active:opacity-70 ${on ? "bg-primary" : "bg-muted"}`}
      onPress={onPress}
      style={style}
    >
      <Text
        className={`text-sm ${on ? "font-semibold text-primary-foreground" : "text-foreground"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2001-09-17` → `17 September 2001`; `null` for anything that is not a date. */
function formatDate(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;

  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : null;
}
