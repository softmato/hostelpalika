import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { PhotoStrip } from "@/components/registration-form";
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
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Lottie } from "@/components/ui/lottie";
import { Screen } from "@/components/ui/screen";
import { EmptyState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDraftAutosave } from "@/hooks/use-draft-autosave";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { CITY_OPTIONS } from "@/lib/hostel-registration";
import { absoluteMediaUrl } from "@/lib/media";
import {
  buildProviderPayload,
  EMPTY_PROVIDER_FORM,
  firstIncompleteProviderStep,
  hasProviderErrors,
  isProviderStepComplete,
  PROVIDER_CATEGORIES,
  PROVIDER_STEPS,
  providerCategoryLabel,
  providerStepErrors,
  toggleProviderCategory,
  type ProviderErrors,
  type ProviderForm,
  type ProviderStepKey,
} from "@/lib/provider-registration";
import { PROVIDER_REVIEW_WINDOW } from "@/lib/provider-status";
import { uploadPublicFile } from "@/lib/public-uploads";
import { registerServiceProvider } from "@/lib/registration-api";
import {
  clearRegistrationDraft,
  readRegistrationDraft,
  type RegistrationDrafts,
  saveRegistrationDraft,
} from "@/lib/registration-draft";
import { toastError } from "@/lib/toast";

/**
 * "Become a service provider", filled in on the phone, in the same sequence,
 * fields, review and autosave as the ID card flow (`app/id-card/edit.tsx`).
 *
 * ## This used to open a browser
 *
 * The website signs a tradesperson in with Google *before* the form, so the
 * application is attached to a verified account that approval upgrades to
 * `SERVICE_PROVIDER`. This app already has that account: `registerServiceProvider`
 * posts through the authenticated client, so `requireApiPrincipal` gets the
 * same `userId` the web flow works to produce.
 *
 * ## The selfie
 *
 * The photo step opens the front camera and will not take a gallery pick.
 * Approval issues an ID card a resident is shown at their door before letting a
 * stranger in, and `PROFILE_PHOTO` is the portrait on it. A gallery pick can be
 * any image on the internet; a photo taken through this screen was taken by
 * whoever held the phone that filed the application.
 */

type StepCopy = { subtitle: string; title: string };

/* `require` paths are case-sensitive on the Linux build machines — `Location` keeps its capital. */
const STEP_ANIMATIONS: Partial<Record<ProviderStepKey, number>> = {
  area: require("../../../assets/lottie/Location.lottie"),
  trades: require("../../../assets/lottie/work.lottie"),
  you: require("../../../assets/lottie/about.lottie"),
};
const SENT_ANIMATION = require("../../../assets/lottie/success.lottie");

const REVIEW_INDEX = PROVIDER_STEPS.length - 1;

/** `availability` is free text at the server; these are how people describe it. */
const AVAILABILITY_PRESETS = [
  "Weekdays",
  "Weekends",
  "Evenings",
  "On call",
  "Emergencies",
];

/** The "Other" city chip; any typed city shows as it. */
const OTHER_CITY = "__other";

function stepCopy(step: ProviderStepKey, filedAs: string): StepCopy {
  switch (step) {
    case "you":
      return {
        subtitle: `Filed against ${filedAs} — approval turns it into your provider login.`,
        title: "About you",
      };
    case "trades":
      return {
        subtitle: "Every trade you work in — you are matched to jobs in all of them.",
        title: "Your work",
      };
    case "area":
      return {
        subtitle: "Hostels search providers by area, so this is how they find you.",
        title: "Where you work",
      };
    case "selfie":
      return {
        subtitle: "Taken now, on this phone. It becomes the portrait on your provider ID card.",
        title: "Your photo",
      };
    default:
      return {
        subtitle: `We verify your details in ${PROVIDER_REVIEW_WINDOW}, and email you either way.`,
        title: "Check it over",
      };
  }
}

export default function ServiceProviderApplyScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const accountId = account?.id ?? "";
  /** `undefined` while the phone is still being asked for a saved draft. */
  const [stored, setStored] = useState<
    RegistrationDrafts["provider"] | null | undefined
  >(accountId ? undefined : null);

  useEffect(() => {
    if (!accountId) {
      return;
    }

    let live = true;

    void readRegistrationDraft("provider", accountId).then((snapshot) => {
      if (live) {
        setStored(snapshot);
      }
    });

    return () => {
      live = false;
    };
  }, [accountId]);

  /*
   * No session, no application: the account is what an approval upgrades, and
   * it is checkable before someone fills in five steps.
   */
  if (!account) {
    return (
      <Screen
        header={<AppBar showBack title="Become a service provider" />}
        scroll
      >
        <EmptyState
          action={
            <Button
              label="Sign in"
              onPress={() => router.push("/(auth)/login")}
            />
          }
          description="Your application is attached to your account — approval turns that same account into your provider login, and jobs are sent to it."
          title="Sign in to apply"
        />
      </Screen>
    );
  }

  const filedAs = account.email || account.name || "your account";

  if (stored === undefined) {
    const first = stepCopy("you", filedAs);

    return (
      <StepSkeleton
        subtitle={first.subtitle}
        title={first.title}
        total={PROVIDER_STEPS.length}
      />
    );
  }

  return (
    <ProviderWizard
      accountId={accountId}
      defaults={{ fullName: account.name ?? "", phone: account.phone ?? "" }}
      email={account.email ?? null}
      filedAs={filedAs}
      stored={stored}
    />
  );
}

function ProviderWizard({
  accountId,
  defaults,
  email,
  filedAs,
  stored,
}: {
  accountId: string;
  defaults: Pick<ProviderForm, "fullName" | "phone">;
  email: string | null;
  filedAs: string;
  stored: RegistrationDrafts["provider"] | null;
}) {
  const { colors } = useAppTheme();

  // Prefilled, not locked: a trading name is routinely not the account's name.
  const [form, setForm] = useState<ProviderForm>(
    () => stored?.form ?? { ...EMPTY_PROVIDER_FORM, ...defaults },
  );
  const [index, setIndex] = useState(
    Math.min(stored?.index ?? 0, REVIEW_INDEX),
  );
  const [forward, setForward] = useState(true);
  const [errors, setErrors] = useState<ProviderErrors>({});
  const [busy, setBusy] = useState<"document" | "selfie" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  /** Not saved with the draft: consent is for the form on screen now. */
  const [agreed, setAgreed] = useState(false);

  const snapshot = useMemo(() => ({ form, index }), [form, index]);
  const persist = useCallback(
    (value: RegistrationDrafts["provider"]) =>
      saveRegistrationDraft("provider", accountId, value),
    [accountId],
  );
  const markSaved = useDraftAutosave(snapshot, Boolean(stored), persist);

  const step = PROVIDER_STEPS[index]!.key;

  const patch = useCallback((next: Partial<ProviderForm>) => {
    setForm((current) => ({ ...current, ...next }));
    // Only the touched fields lose their message.
    setErrors((current) => {
      const touched = Object.keys(next) as (keyof ProviderForm)[];

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
    const found = providerStepErrors(step, form);

    setErrors(found);

    if (!hasProviderErrors(found)) {
      goTo(Math.min(REVIEW_INDEX, index + 1), true);
    }
  }, [form, goTo, index, step]);

  /**
   * The front camera, square, cropped by the applicant — the portrait is drawn
   * in a circle on the ID card. `quality: 0.6` keeps it under the public upload
   * route's 5 MB cap without a resize step.
   */
  const takeSelfie = useCallback(async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();

    if (!permission.granted) {
      toastError(
        "Camera access needed",
        "Your application needs a photo of you, taken now.",
      );

      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      cameraType: ImagePicker.CameraType.front,
      quality: 0.6,
    });
    const asset = result.canceled ? null : result.assets[0];

    if (!asset) {
      return;
    }

    setBusy("selfie");

    try {
      const uploaded = await uploadPublicFile(asset, { label: "Your photo" });

      patch({
        selfie: {
          claimToken: uploaded.claimToken,
          fileAssetId: uploaded.fileAssetId,
          fileName: "Your photo",
          url: uploaded.url,
        },
      });
    } catch (caught) {
      toastError("That photo didn't upload", readApiError(caught));
    } finally {
      setBusy(null);
    }
  }, [patch]);

  const pickDocument = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError(
        "Photo access needed",
        "Allow access to attach your documents.",
      );

      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.7,
    });
    const asset = result.canceled ? null : result.assets[0];

    if (!asset) {
      return;
    }

    setBusy("document");

    try {
      const uploaded = await uploadPublicFile(asset, {
        label: "Supporting document",
      });

      setForm((current) => ({
        ...current,
        // Eight is the schema's cap for `documents` and the selfie takes one.
        documents: [
          ...current.documents,
          {
            claimToken: uploaded.claimToken,
            fileAssetId: uploaded.fileAssetId,
            fileName: uploaded.fileName,
            url: uploaded.url,
          },
        ].slice(0, 7),
      }));
    } catch (caught) {
      toastError("That file didn't upload", readApiError(caught));
    } finally {
      setBusy(null);
    }
  }, []);

  const submit = useCallback(async () => {
    if (busy) {
      toastError("Something is still uploading", "Try again in a moment.");

      return;
    }

    const incomplete = firstIncompleteProviderStep(form);

    if (incomplete) {
      setErrors(providerStepErrors(incomplete, form));
      toastError("Some details need fixing", "The ones in red.");
      goTo(
        PROVIDER_STEPS.findIndex((entry) => entry.key === incomplete),
        false,
      );

      return;
    }

    setSubmitting(true);

    try {
      await registerServiceProvider(buildProviderPayload(form, email));
      markSaved();
      void clearRegistrationDraft("provider", accountId);
      setSubmitted(true);
    } catch (caught) {
      toastError(
        "Your application could not be submitted",
        readApiError(caught),
      );
    } finally {
      setSubmitting(false);
    }
  }, [accountId, busy, email, form, goTo, markSaved]);

  if (submitted) {
    return <SubmittedView email={email} />;
  }

  const onReview = step === "review";
  const copy = stepCopy(step, filedAs);
  const animation = STEP_ANIMATIONS[step];
  const customCity = !(CITY_OPTIONS as readonly string[]).includes(form.city);
  const availability = form.availability
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selfieUri = form.selfie
    ? (absoluteMediaUrl(form.selfie.url, API_BASE_URL) ?? form.selfie.url)
    : null;

  return (
    <StepFrame
      footer={
        <Button
          // Looks off until the terms are ticked, but still answers a tap with why.
          className={onReview && !agreed ? "opacity-50" : undefined}
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
                  if (!agreed) {
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
      forward={forward}
      onBack={back}
      position={index + 1}
      stepKey={step}
      subtitle={copy.subtitle}
      title={copy.title}
      total={PROVIDER_STEPS.length}
    >
      {animation ? (
        <View className="items-center">
          <Lottie size={140} source={animation} />
        </View>
      ) : null}

      {step === "you" ? (
        <>
          <Input
            autoCapitalize="words"
            error={errors.fullName}
            label="Full name *"
            onChangeText={(value) => patch({ fullName: value })}
            placeholder="The name hostels should ask for"
            value={form.fullName}
            variant="line"
          />
          <Input
            error={errors.phone}
            keyboardType="phone-pad"
            label="Phone *"
            onChangeText={(value) => patch({ phone: value })}
            placeholder="98XXXXXXXX"
            value={form.phone}
            variant="line"
          />
        </>
      ) : null}

      {step === "trades" ? (
        <>
          <View className="gap-2">
            <ChoiceChips
              error={errors.categories}
              label="Trades *"
              onToggle={(category) =>
                patch({
                  categories: toggleProviderCategory(form.categories, category),
                })
              }
              options={PROVIDER_CATEGORIES.map((category) => ({
                label: providerCategoryLabel(category),
                value: category,
              }))}
              value={form.categories}
            />
            <Text variant="caption">
              {form.categories[0]
                ? `Main trade: ${providerCategoryLabel(form.categories[0])} — the first one you tapped.`
                : "The first one you tap is shown as your main trade."}
            </Text>
          </View>

          <Accordion
            caption="Optional — experience and what you offer"
            defaultOpen={Boolean(form.experience || form.description)}
            title="More about your work"
          >
            <Input
              label="Experience"
              multiline
              onChangeText={(value) => patch({ experience: value })}
              placeholder="5 years fixing residential plumbing"
              value={form.experience}
              variant="line"
            />
            <Input
              label="About your service"
              multiline
              onChangeText={(value) => patch({ description: value })}
              placeholder="Coverage, tools, how quickly you can get there."
              value={form.description}
              variant="line"
            />
          </Accordion>
        </>
      ) : null}

      {step === "area" ? (
        <>
          <Input
            autoCapitalize="words"
            error={errors.area}
            label="Area *"
            onChangeText={(value) => patch({ area: value })}
            placeholder="Neighbourhood or tole"
            value={form.area}
            variant="line"
          />
          <ChoiceChips
            error={customCity ? undefined : errors.city}
            label="City *"
            // "Other" empties the city, which is what opens the box below.
            onToggle={(value) =>
              patch({ city: value === OTHER_CITY ? "" : value })
            }
            options={[
              ...CITY_OPTIONS.map((city) => ({ label: city, value: city })),
              { label: "Other", value: OTHER_CITY },
            ]}
            value={customCity ? OTHER_CITY : form.city}
          />
          {customCity ? (
            <Input
              autoCapitalize="words"
              error={errors.city}
              label="Your city *"
              onChangeText={(value) => patch({ city: value })}
              value={form.city}
              variant="line"
            />
          ) : null}

          <StepSection caption="Optional — pick any that fit" title="Availability">
            <ChoiceChips
              onToggle={(value) =>
                patch({
                  availability: (availability.includes(value)
                    ? availability.filter((entry) => entry !== value)
                    : [...availability, value]
                  ).join(", "),
                })
              }
              // Values typed before these chips existed stay visible and removable.
              options={[
                ...new Set([...AVAILABILITY_PRESETS, ...availability]),
              ].map((entry) => ({ label: entry, value: entry }))}
              value={availability}
            />
          </StepSection>
        </>
      ) : null}

      {step === "selfie" ? (
        <>
          <View className="items-center py-2">
            <View
              className="items-center justify-center rounded-full border-2 border-primary p-1.5"
              style={{ height: 212, width: 212 }}
            >
              <View className="size-full items-center justify-center overflow-hidden rounded-full bg-muted">
                {selfieUri ? (
                  // Resolved, never raw: without R2 the upload route answers a relative `/uploads/…` path.
                  <Image
                    accessibilityLabel="Your photo"
                    contentFit="cover"
                    source={{ uri: selfieUri }}
                    style={{ height: "100%", width: "100%" }}
                    transition={150}
                  />
                ) : (
                  <Glyph
                    color={colors.mutedForeground}
                    name="person"
                    size={84}
                  />
                )}
              </View>
            </View>
          </View>

          <View className="gap-2">
            <Button
              disabled={busy !== null}
              icon="camera"
              label={form.selfie ? "Take it again" : "Take your photo"}
              loading={busy === "selfie"}
              onPress={() => void takeSelfie()}
            />
            {errors.selfie ? (
              <Text className="text-center text-destructive" variant="caption">
                {errors.selfie}
              </Text>
            ) : null}
          </View>

          <Accordion
            caption="Optional — citizenship, a trade licence, certificates. Proof of trade clears review faster."
            defaultOpen={form.documents.length > 0}
            title="Supporting documents"
          >
            <PhotoStrip
              onRemove={(url) =>
                setForm((current) => ({
                  ...current,
                  documents: current.documents.filter(
                    (item) => item.url !== url,
                  ),
                }))
              }
              photos={form.documents}
            />
            <Button
              disabled={busy !== null || form.documents.length >= 7}
              icon="document-add"
              label="Add a document"
              loading={busy === "document"}
              onPress={() => void pickDocument()}
              variant="outline"
            />
          </Accordion>
        </>
      ) : null}

      {onReview ? (
        <ProviderReview
          agreed={agreed}
          email={email}
          filedAs={filedAs}
          form={form}
          onAgreedChange={setAgreed}
          onEdit={(key) =>
            goTo(
              PROVIDER_STEPS.findIndex((entry) => entry.key === key),
              false,
            )
          }
        />
      ) : null}
    </StepFrame>
  );
}

function ProviderReview({
  agreed,
  email,
  filedAs,
  form,
  onAgreedChange,
  onEdit,
}: {
  agreed: boolean;
  email: string | null;
  filedAs: string;
  form: ProviderForm;
  onAgreedChange: (value: boolean) => void;
  onEdit: (step: ProviderStepKey) => void;
}) {
  const [openStep, setOpenStep] = useState<ProviderStepKey | null>(null);
  const dash = (value: string) => value.trim() || "—";

  const facts: Record<Exclude<ProviderStepKey, "review">, [string, string][]> = {
    area: [
      ["Area", dash(form.area)],
      ["City", dash(form.city)],
      ["Availability", dash(form.availability)],
    ],
    selfie: [
      ["Photo", form.selfie ? "Taken" : "Not taken yet"],
      [
        "Documents",
        form.documents.length === 1
          ? "1 file"
          : `${form.documents.length} files`,
      ],
    ],
    trades: [
      [
        form.categories.length > 1 ? "Trades" : "Trade",
        dash(form.categories.map(providerCategoryLabel).join(", ")),
      ],
      ["Experience", dash(form.experience)],
      ["About", dash(form.description)],
    ],
    you: [
      ["Name", dash(form.fullName)],
      ["Phone", dash(form.phone)],
      ["Email", email ?? "—"],
    ],
  };

  const steps = PROVIDER_STEPS.filter((entry) => entry.key !== "review");
  const incomplete = steps.find(
    (entry) => !isProviderStepComplete(entry.key, form),
  );

  return (
    <View className="gap-5">
      <View>
        {steps.map((entry, position) => (
          <ReviewFold
            complete={isProviderStepComplete(entry.key, form)}
            divider={position > 0}
            key={entry.key}
            onEdit={() => onEdit(entry.key)}
            onToggle={() =>
              setOpenStep(openStep === entry.key ? null : entry.key)
            }
            open={openStep === entry.key}
            title={`${position + 1}. ${stepCopy(entry.key, filedAs).title}`}
          >
            <FactRows
              facts={facts[entry.key as Exclude<ProviderStepKey, "review">]}
            />
          </ReviewFold>
        ))}
      </View>

      <ReviewVerdict
        incomplete={
          incomplete ? stepCopy(incomplete.key, filedAs).title : null
        }
        onFix={() => incomplete && onEdit(incomplete.key)}
      />

      <TermsAgreement
        agreed={agreed}
        onChange={onAgreedChange}
        prefix="Jobs hostels assign me arrive on this account, and I agree to"
      />
    </View>
  );
}

/**
 * The end of the journey: nothing to poll until a human has looked at the
 * application, so this says what happens next and offers leaving.
 */
function SubmittedView({ email }: { email: string | null }) {
  return (
    <Screen
      footer={
        <Button
          label="Done"
          onPress={() => router.replace("/service-providers")}
        />
      }
      header={<AppBar title="" />}
    >
      <View className="flex-1 items-center justify-center gap-3 px-4 pt-16">
        <Lottie loop={false} size={180} source={SENT_ANIMATION} />
        <Text className="text-center" variant="title">
          You&apos;re in the queue
        </Text>
        <Text className="text-center" variant="muted">
          {email
            ? `We verify your details in ${PROVIDER_REVIEW_WINDOW} and email ${email} the moment there's a decision.`
            : `We verify your details in ${PROVIDER_REVIEW_WINDOW}, and you'll be notified the moment there's a decision.`}
        </Text>
        <Text className="text-center" variant="muted">
          After approval this app becomes your provider app — a Jobs tab and a
          provider ID card with the photo you just took.
        </Text>
      </View>
    </Screen>
  );
}
