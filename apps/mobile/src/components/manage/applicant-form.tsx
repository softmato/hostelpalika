import type { ReactNode } from "react";
import { View } from "react-native";

import { ApplicantDocumentsPicker } from "@/components/manage/applicant-documents";
import { ApplicantPhotoPicker } from "@/components/manage/applicant-photo";
import { SignaturePad } from "@/components/signature-pad";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { Text } from "@/components/ui/text";
import {
  type ApplicantDocuments,
  type ApplicantDraft,
  type ApplicantField,
  type ApplicantPhoto,
  type DocumentKind,
  BLOOD_GROUPS,
  FOOD_OPTIONS,
  GENDER_OPTIONS,
} from "@/lib/resident-details";

/**
 * The hostel's admission form — the paper "Student Application Form" — as
 * inputs. One component for both people who fill it: the warden typing it for
 * somebody with no ID card, and the person themself through the Form QR. So
 * the labels are the paper's, and say nobody's "your" or "their".
 *
 * Section headings sit outside their cards and the cards hold only boxes, the
 * required ones starred. The warden needs only the name and the number; the
 * person's own form (`own`) needs what their ID card prints too, because the
 * card is made from it when they are registered.
 */
export function ApplicantForm({
  documents,
  draft,
  extra,
  guardianDocRequired,
  onChange,
  onDocument,
  onPhoto,
  onSigning,
  own = false,
  photo,
}: {
  /** Citizenship / ID scans: their own always required, the guardian's per the hostel's setting. */
  documents: ApplicantDocuments;
  draft: ApplicantDraft;
  /** Rendered at the foot of the first card — the intake's "They are a" picker. */
  extra?: ReactNode;
  /** Settings → Form details. */
  guardianDocRequired: boolean;
  onChange: (field: ApplicantField, value: string) => void;
  onDocument: (kind: DocumentKind, document: ApplicantPhoto | null) => void;
  onPhoto: (photo: ApplicantPhoto | null) => void;
  /** The signature box is being drawn on: the screen stops scrolling under the pen. */
  onSigning: (active: boolean) => void;
  /** The person filling their own form: photo, email, birth date, gender, a parent's number and a signature. */
  own?: boolean;
  photo: ApplicantPhoto | null;
}) {
  const star = own ? " *" : "";
  const box = (
    field: ApplicantField,
    label: string,
    options: {
      keyboard?: "email-address" | "number-pad" | "numbers-and-punctuation" | "phone-pad";
      multiline?: boolean;
      placeholder?: string;
      words?: boolean;
    } = {},
  ) => (
    <Input
      autoCapitalize={options.keyboard === "email-address" ? "none" : options.words ? "words" : "sentences"}
      keyboardType={options.keyboard}
      label={label}
      multiline={options.multiline}
      onChangeText={(value: string) => onChange(field, value)}
      placeholder={options.placeholder}
      value={draft[field]}
    />
  );

  const pair = (left: ReactNode, right: ReactNode) => (
    <View className="flex-row gap-3">
      <View className="flex-1">{left}</View>
      <View className="flex-1">{right}</View>
    </View>
  );

  const toggle = (field: ApplicantField, value: string) => onChange(field, draft[field] === value ? "" : value);

  const family = (who: "father" | "mother" | "spouse", label: string) => (
    <View className="gap-3">
      {box(`${who}Name`, label, { words: true })}
      {pair(
        box(`${who}Phone`, "Contact no.", { keyboard: "phone-pad" }),
        box(`${who}Occupation`, "Occupation"),
      )}
    </View>
  );

  return (
    <View className="gap-5">
      <View>
        <SectionHeader
          subtitle={own ? "Take one now or upload one — face clear and well lit" : "Take one now or upload one"}
          title={`Photo${star}`}
        />
        <Card>
          <ApplicantPhotoPicker onChange={onPhoto} value={photo} />
        </Card>
      </View>

      <View>
        <SectionHeader subtitle="A clear photo of the front, or a scan" title="Documents" />
        <Card>
          <ApplicantDocumentsPicker
            guardianRequired={guardianDocRequired}
            onChange={onDocument}
            value={documents}
          />
        </Card>
      </View>

      <View>
        <SectionHeader title="Personal" />
        <Card className="gap-3">
          {pair(box("firstName", "First name *", { words: true }), box("lastName", "Last name *", { words: true }))}
          {box("phone", "Contact no. *", { keyboard: "phone-pad" })}
          {box("email", `Email${star}`, {
            keyboard: "email-address",
            placeholder: own ? "Gmail you will log in with" : "Optional — becomes their login",
          })}
          {box("dateOfBirth", `Date of birth${star}`, { keyboard: "numbers-and-punctuation", placeholder: "YYYY-MM-DD" })}

          <View className="gap-2">
            <Text variant="label">{`Gender${star}`}</Text>
            <View className="flex-row flex-wrap gap-2">
              {GENDER_OPTIONS.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  onPress={() => toggle("gender", option.value)}
                  tone={draft.gender === option.value ? "brand" : "neutral"}
                />
              ))}
            </View>
          </View>

          <View className="gap-2">
            <Text variant="label">Blood group</Text>
            <View className="flex-row flex-wrap gap-2">
              {BLOOD_GROUPS.map((group) => (
                <Chip
                  key={group}
                  label={group}
                  onPress={() => toggle("bloodGroup", group)}
                  tone={draft.bloodGroup === group ? "brand" : "neutral"}
                />
              ))}
            </View>
          </View>

          <View className="gap-2">
            <Text variant="label">Food</Text>
            <View className="flex-row flex-wrap gap-2">
              {FOOD_OPTIONS.map((option) => (
                <Chip
                  icon="restaurant-outline"
                  key={option.value}
                  label={option.label}
                  onPress={() => toggle("food", option.value)}
                  tone={draft.food === option.value ? "brand" : "neutral"}
                />
              ))}
            </View>
          </View>

          {extra}
        </Card>
      </View>

      <View>
        <SectionHeader title="Address" />
        <Card className="gap-3">
          {pair(box("district", "District", { words: true }), box("wardNo", "Ward no.", { keyboard: "number-pad" }))}
          {box("municipality", "Metro / Municipality / Rural", { words: true })}
          {box("tole", "Street / Tole / Chowk", { words: true })}
        </Card>
      </View>

      <View>
        <SectionHeader title="Citizenship" />
        <Card className="gap-3">
          {box("citizenshipNo", "Citizenship no.")}
          {pair(
            box("citizenshipIssuedOn", "Date of issue", { keyboard: "numbers-and-punctuation", placeholder: "2078-04-12" }),
            box("citizenshipIssuedAt", "Place of issue", { words: true }),
          )}
        </Card>
      </View>

      <View>
        <SectionHeader title="Study" />
        <Card className="gap-3">
          {box("institution", "Name of the educational institute", { words: true })}
          {pair(
            box("levelOfStudy", "Level of study", { placeholder: "Bachelor" }),
            box("classTime", "Class time", { placeholder: "6 – 11 AM" }),
          )}
          {box("stayDuration", "How long in the hostel", { placeholder: "1 year" })}
        </Card>
      </View>

      <View>
        <SectionHeader
          subtitle={own ? "At least one contact number" : "Fill in whoever applies"}
          title={`Family${star}`}
        />
        <Card className="gap-5">
          {family("father", "Father's name")}
          {family("mother", "Mother's name")}
          {family("spouse", "Spouse name")}
        </Card>
      </View>

      <View>
        <SectionHeader subtitle="Someone near the hostel" title="Local guardian" />
        <Card className="gap-3">
          {pair(box("localName", "Name", { words: true }), box("localRelation", "Relation", { placeholder: "Uncle" }))}
          {pair(box("localPhone", "Contact no.", { keyboard: "phone-pad" }), box("localOccupation", "Occupation"))}
          {box("localAddress", "Address", { words: true })}
        </Card>
      </View>

      <View>
        <SectionHeader title="Health" />
        <Card>{box("medicalNotes", "Any disease? (if any)", { multiline: true, placeholder: "Optional" })}</Card>
      </View>

      <View>
        <SectionHeader subtitle="It goes on the back of the ID card" title={`Signature${star}`} />
        <Card>
          <SignaturePad
            onActiveChange={onSigning}
            onChange={(value) => onChange("signature", value)}
            value={draft.signature}
          />
        </Card>
      </View>
    </View>
  );
}
