import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { ApplicantForm } from "@/components/manage/applicant-form";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { type AdmissionFormPage, getAdmissionFormPage, sendAdmissionForm } from "@/lib/admission-form-api";
import { readApiError } from "@/lib/api-contract";
import {
  type ApplicantDocuments,
  type ApplicantDraft,
  type ApplicantField,
  type ApplicantPhoto,
  applicantProblem,
  cardProblem,
  type DocumentKind,
  detailsFromDraft,
  documentsPayload,
  documentsProblem,
  emptyApplicantDraft,
  photoPayload,
} from "@/lib/resident-details";
import { toastError } from "@/lib/toast";

/**
 * `/join/apply/{token}` — a hostel's admission form, filled by the person who
 * wants to live there. Opened by scanning the Form QR on the warden's scanner
 * screen (or the link they shared); the web page
 * `apps/web/src/app/(public)/join/apply/[token]` is the same form for anybody
 * without the app. No account needed — it is the paper form, on their phone.
 *
 * Under `/join/` on purpose: the app link the installed build already claims is
 * `/join/`, so this opens in the app with no new native build.
 */
export default function ApplyScreen() {
  const { colors } = useAppTheme();
  const { token = "" } = useLocalSearchParams<{ token: string }>();
  const page = useResource<AdmissionFormPage>(
    useCallback(() => getAdmissionFormPage(token), [token]),
    { cacheKey: `admission-form:${token}` },
  );
  const [draft, setDraft] = useState<ApplicantDraft>(emptyApplicantDraft);
  const [agreed, setAgreed] = useState(false);
  const [photo, setPhoto] = useState<ApplicantPhoto | null>(null);
  const [documents, setDocuments] = useState<ApplicantDocuments>({});
  const setDocument = useCallback(
    (kind: DocumentKind, document: ApplicantPhoto | null) =>
      setDocuments((current) => ({ ...current, [kind]: document ?? undefined })),
    [],
  );
  const [signing, setSigning] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const set = useCallback(
    (field: ApplicantField, value: string) => setDraft((current) => ({ ...current, [field]: value })),
    [],
  );

  const header = <AppBar showBack title="Admission form" />;

  if (page.loading) {
    return (
      <Screen header={header} scroll>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (page.error || !page.data) {
    return (
      <Screen header={header}>
        <ErrorState message={page.error ?? "This form could not be opened."} onRetry={page.reload} />
      </Screen>
    );
  }

  const hostel = page.data.hostel;
  const guardianDocRequired = Boolean(page.data.guardianDocRequired);

  async function send() {
    const ready = photoPayload(photo);
    const problem =
      (photo && !ready ? "Your photo is still uploading." : null) ??
      (ready ? null : "Add your photo — take one or upload one.") ??
      documentsProblem(documents, guardianDocRequired) ??
      applicantProblem(draft) ??
      cardProblem(draft) ??
      (agreed ? null : "Tick that you agree to the hostel's rules.");

    if (problem) {
      toastError("Check the form", problem);
      return;
    }

    setSending(true);

    try {
      await sendAdmissionForm(token, {
        agreed: true,
        details: detailsFromDraft(draft),
        email: draft.email.trim(),
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        phone: draft.phone.trim(),
        photo: ready!,
        documents: documentsPayload(documents),
        residentType: "STUDENT",
      });
      setSent(true);
    } catch (error) {
      toastError("Not sent", readApiError(error, "Your form could not be sent."));
    } finally {
      setSending(false);
    }
  }

  const banner = (
    <View className="-mt-1">
      <View className="gap-1 rounded-b-3xl bg-primary px-5 pb-6 pt-4">
        <Text className="text-xs font-bold uppercase tracking-wide text-primary-foreground/75">
          Filling form for
        </Text>
        <Text className="text-xl font-bold text-primary-foreground">{hostel.name}</Text>
        {hostel.city ? <Text className="text-sm text-primary-foreground/80">{hostel.city}</Text> : null}
      </View>
    </View>
  );

  if (sent || !page.data.open) {
    return (
      <Screen
        footer={sent ? <Button label="Done" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} /> : undefined}
        header={header}
        scroll
      >
        <View className="gap-5">
          {banner}
          <Card className="items-center gap-3 py-6">
            <Glyph
              color={sent ? colors.success : colors.warning}
              name={sent ? "checkmark-circle" : "alert-circle"}
              size={44}
            />
            <Text className="text-center" variant="subtitle">
              {sent ? `Sent to ${hostel.name}` : "Not taking forms right now"}
            </Text>
            <Text className="text-center" variant="muted">
              {sent
                ? `They have your form. They will choose your bed and call you on ${draft.phone.trim()}.`
                : `Ask ${hostel.name} at the desk.`}
            </Text>
          </Card>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={<Button label={`Send to ${hostel.name}`} loading={sending} onPress={() => void send()} />}
      header={header}
      scroll
      scrollEnabled={!signing}
    >
      <View className="gap-5">
        {banner}

        <ApplicantForm
          documents={documents}
          draft={draft}
          guardianDocRequired={guardianDocRequired}
          onChange={set}
          onDocument={setDocument}
          onPhoto={setPhoto}
          onSigning={setSigning}
          own
          photo={photo}
        />

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agreed }}
          className="flex-row items-start gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-70"
          onPress={() => setAgreed(!agreed)}
        >
          <Glyph
            color={agreed ? colors.primary : colors.mutedForeground}
            name={agreed ? "checkbox" : "square"} variant={agreed ? "solid" : "line"}
            size={22}
          />
          <Text className="flex-1 text-sm">
            {`I agree to the rules of ${hostel.name} and will follow them. If I break them, I accept the action the hostel takes.`}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
