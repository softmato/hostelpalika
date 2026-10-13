"use client";

import { AlertTriangle, Camera, CheckCircle2, FileText, ImagePlus, Smartphone, UserRound } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { PhotoCropper } from "@/components/photo-cropper";
import { SignaturePad } from "@/components/signature-pad";
import { Button } from "@/components/ui/button";
import { WebCameraModal } from "@/components/web-camera-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { PublicShell } from "@/app/_components/shared";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { uploadRegistrationDocument } from "@/lib/uploads/registration-document";

/**
 * `/join/apply/{token}` — a hostel's admission form, filled by the person who
 * wants to live there (the Form QR on the warden's scanner screen). The paper
 * "Student Application Form", one column, plain words. Only name and phone are
 * required; the hostel sees the rest when it picks their bed.
 */

type PageView = {
  /** The hostel's Settings → Form details: the guardian's ID document is required. */
  guardianDocRequired?: boolean;
  hostel: { city: string; name: string };
  open: boolean;
};

/** Citizenship / ID scans. Their own is always required; the guardian's per the hostel. */
const DOCUMENT_KINDS = [
  ["APPLICANT_ID", "Your citizenship or ID"],
  ["GUARDIAN_ID", "Guardian's citizenship or ID"],
] as const;

type DocumentKind = (typeof DOCUMENT_KINDS)[number][0];

type Scan = { claimToken?: string; fileAssetId?: string; name: string; preview: string | null };

/**
 * A phone camera's photo cut to 1600px, so it stays under the anonymous
 * upload's 5 MB cap. Small files and anything that will not decode go as they are.
 */
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= 1_500_000) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");

    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));

    return blob ? new File([blob], `${file.name.replace(/\.\w+$/, "")}.jpg`, { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

type Draft = Record<string, string>;

/** The face on the form; no `fileAssetId` yet means it is still uploading. */
type Photo = { claimToken?: string; fileAssetId?: string; preview: string };

type Field = { full?: boolean; key: string; label: string; type?: "date" | "tel" | "email"; placeholder?: string };

const SECTIONS: { fields: Field[]; title: string }[] = [
  {
    title: "About you",
    fields: [
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "phone", label: "Contact no.", type: "tel" },
      { key: "email", label: "Email — you log in with it", type: "email" },
      { key: "dateOfBirth", label: "Date of birth", type: "date" },
      { key: "bloodGroup", label: "Blood group", placeholder: "e.g. B+" },
    ],
  },
  {
    title: "Address",
    fields: [
      { key: "district", label: "District" },
      { key: "municipality", label: "Metro / Municipality / Rural" },
      { key: "wardNo", label: "Ward no." },
      { key: "tole", label: "Street / Tole / Chowk" },
    ],
  },
  {
    title: "Citizenship",
    fields: [
      { key: "citizenshipNo", label: "Citizenship no." },
      { key: "citizenshipIssuedOn", label: "Date of issue", placeholder: "e.g. 2078-04-12" },
      { key: "citizenshipIssuedAt", full: true, label: "Place of issue" },
    ],
  },
  {
    title: "Study",
    fields: [
      { full: true, key: "institution", label: "Name of the educational institute" },
      { key: "levelOfStudy", label: "Level of study", placeholder: "e.g. Bachelor" },
      { key: "classTime", label: "Class time", placeholder: "e.g. 6 AM – 11 AM" },
      { full: true, key: "stayDuration", label: "How long will you stay?", placeholder: "e.g. 1 year" },
    ],
  },
  {
    title: "Family — at least one contact no.",
    fields: [
      { key: "fatherName", label: "Father's name" },
      { key: "fatherPhone", label: "Contact no.", type: "tel" },
      { full: true, key: "fatherOccupation", label: "Occupation" },
      { key: "motherName", label: "Mother's name" },
      { key: "motherPhone", label: "Contact no.", type: "tel" },
      { full: true, key: "motherOccupation", label: "Occupation" },
      { key: "spouseName", label: "Spouse name" },
      { key: "spousePhone", label: "Contact no.", type: "tel" },
      { full: true, key: "spouseOccupation", label: "Occupation" },
    ],
  },
  {
    title: "Local guardian",
    fields: [
      { key: "localName", label: "Name" },
      { key: "localRelation", label: "Relation" },
      { key: "localPhone", label: "Contact no.", type: "tel" },
      { key: "localOccupation", label: "Occupation" },
      { full: true, key: "localAddress", label: "Address" },
    ],
  },
];

const GENDERS = [
  ["MALE", "Male"],
  ["FEMALE", "Female"],
  ["OTHER", "Other"],
] as const;

const FOOD = [
  ["VEG", "Vegetarian"],
  ["EGGETARIAN", "Only egg"],
  ["NON_VEG", "Non-vegetarian"],
] as const;

const BLOOD = new Set(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-teal";

/** The form as the server's `admissionFormInputSchema` reads it. */
function toPayload(
  draft: Draft,
  agreed: boolean,
  photo: { claimToken: string; fileAssetId: string },
  documents: { claimToken: string; fileAssetId: string; kind: DocumentKind }[],
) {
  const v = (key: string) => draft[key]?.trim() ?? "";
  const family = (["father", "mother", "spouse"] as const)
    .filter((who) => v(`${who}Name`).length >= 2)
    .map((who) => ({
      name: v(`${who}Name`),
      occupation: v(`${who}Occupation`),
      phone: v(`${who}Phone`),
      relation: who === "father" ? "Father" : who === "mother" ? "Mother" : "Spouse",
    }));
  const blood = v("bloodGroup").toUpperCase().replace(/\s+/g, "");

  return {
    agreed,
    details: {
      bloodGroup: BLOOD.has(blood) ? blood : "",
      citizenshipIssuedAt: v("citizenshipIssuedAt"),
      citizenshipIssuedOn: v("citizenshipIssuedOn"),
      citizenshipNo: v("citizenshipNo"),
      classTime: v("classTime"),
      dateOfBirth: v("dateOfBirth"),
      district: v("district"),
      family,
      food: v("food"),
      gender: v("gender"),
      institution: v("institution"),
      levelOfStudy: v("levelOfStudy"),
      localGuardian:
        v("localName").length >= 2
          ? {
              address: v("localAddress"),
              name: v("localName"),
              occupation: v("localOccupation"),
              phone: v("localPhone"),
              relation: v("localRelation").length >= 2 ? v("localRelation") : "Local guardian",
            }
          : undefined,
      medicalNotes: v("medicalNotes"),
      municipality: v("municipality"),
      signature: v("signature"),
      stayDuration: v("stayDuration"),
      tole: v("tole"),
      wardNo: v("wardNo"),
    },
    email: v("email"),
    firstName: v("firstName"),
    lastName: v("lastName"),
    phone: v("phone"),
    photo,
    documents,
  };
}

export function AdmissionFormPage({ token }: { token: string }) {
  const url = `/api/v1/public/admission-form/${encodeURIComponent(token)}`;
  const page = usePortalResource<PageView>(url, { errorMessage: "This form could not be opened." });
  const [draft, setDraft] = useState<Draft>({});
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [camera, setCamera] = useState(false);
  const [cropping, setCropping] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [scans, setScans] = useState<Partial<Record<DocumentKind, Scan>>>({});
  const view = page.data ?? null;
  const guardianDocRequired = Boolean(view?.guardianDocRequired);

  async function attachScan(kind: DocumentKind, picked: File) {
    const file = await shrinkImage(picked);

    setScans((current) => ({
      ...current,
      [kind]: { name: file.name, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null },
    }));

    try {
      const uploaded = await uploadRegistrationDocument(file, "Document");

      setScans((current) => (current[kind] ? { ...current, [kind]: { ...current[kind], ...uploaded } } : current));
    } catch {
      setScans((current) => ({ ...current, [kind]: undefined }));
      setError("That document could not be uploaded. Try another photo of it.");
    }
  }

  /** Up the moment it is chosen, privately — the hostel reads it through its own staff route. */
  async function attachPhoto(file: File) {
    setPhoto({ preview: URL.createObjectURL(file) });

    try {
      const uploaded = await uploadRegistrationDocument(file, "Your photo");

      setPhoto((current) => (current ? { ...current, ...uploaded } : current));
    } catch {
      setPhoto(null);
      setError("That photo could not be uploaded. Try another one.");
    }
  }

  async function send() {
    setError("");

    if (!draft.firstName?.trim() || !draft.lastName?.trim()) return setError("Write your first and last name.");
    if ((draft.phone ?? "").replace(/\D/g, "").length < 7) return setError("Write your contact number.");
    if (!photo) return setError("Add your photo — take one or upload one.");
    if (!photo.fileAssetId || !photo.claimToken) return setError("Your photo is still uploading.");
    if (Object.values(scans).some((scan) => scan && !scan.fileAssetId)) {
      return setError("A document is still uploading.");
    }
    if (!scans.APPLICANT_ID) return setError("Add a photo of your citizenship or ID.");
    if (guardianDocRequired && !scans.GUARDIAN_ID) {
      return setError("This hostel needs your guardian's citizenship or ID too.");
    }
    // The rest of what their ID card prints: registering them makes the card from this form.
    if (!/^\S+@\S+\.\S+$/.test(draft.email?.trim() ?? "")) return setError("Write your email — you log in with it.");
    if (!draft.dateOfBirth) return setError("Write your date of birth.");
    if (!draft.gender) return setError("Choose your gender.");
    if (!["fatherPhone", "motherPhone", "spousePhone"].some((key) => (draft[key] ?? "").replace(/\D/g, "").length >= 7)) {
      return setError("Write your father's or mother's contact number.");
    }
    if (!draft.signature) return setError("Sign the form.");
    if (!agreed) return setError("Tick that you agree to the hostel's rules.");

    setBusy(true);

    try {
      await browserApi(url, {
        body: JSON.stringify(
          toPayload(
            draft,
            agreed,
            { claimToken: photo.claimToken, fileAssetId: photo.fileAssetId },
            DOCUMENT_KINDS.flatMap(([kind]) => {
              const scan = scans[kind];

              return scan?.fileAssetId && scan.claimToken
                ? [{ claimToken: scan.claimToken, fileAssetId: scan.fileAssetId, kind }]
                : [];
            }),
          ),
        ),
        method: "POST",
      });
      setSent(true);
      window.scrollTo({ top: 0 });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your form could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  if (page.message && !view) {
    return (
      <Shell hostelName="Admission form">
        <Panel>
          <AlertTriangle className="size-8 text-warning" />
          <h2 className="text-lg font-bold">This form does not open</h2>
          <p className="text-sm text-muted-foreground">{page.message}</p>
          <Button asChild variant="outline">
            <Link href="/">Go to the home page</Link>
          </Button>
        </Panel>
      </Shell>
    );
  }

  if (!view) {
    return (
      <Shell hostelName="">
        <Skeleton className="h-96 w-full rounded-2xl" />
      </Shell>
    );
  }

  if (sent) {
    return (
      <Shell city={view.hostel.city} hostelName={view.hostel.name}>
        <Panel>
          <CheckCircle2 className="size-8 text-success" />
          <h2 className="text-lg font-bold">Sent to {view.hostel.name}</h2>
          <p className="text-sm text-muted-foreground">
            The hostel has your form. They will choose your bed and call you on {draft.phone}.
          </p>
        </Panel>
      </Shell>
    );
  }

  if (!view.open) {
    return (
      <Shell city={view.hostel.city} hostelName={view.hostel.name}>
        <Panel>
          <AlertTriangle className="size-8 text-warning" />
          <h2 className="text-lg font-bold">Not taking forms right now</h2>
          <p className="text-sm text-muted-foreground">Ask {view.hostel.name} at the desk.</p>
        </Panel>
      </Shell>
    );
  }

  const set = (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  const uploading = Boolean(photo && !photo.fileAssetId);

  return (
    <Shell city={view.hostel.city} hostelName={view.hostel.name}>
      {camera ? (
        <WebCameraModal
          aspectRatio={1}
          facingMode="user"
          onCapture={(file) => {
            setCamera(false);
            void attachPhoto(file);
          }}
          onClose={() => setCamera(false)}
          title="Take your photo"
        />
      ) : null}
      {cropping ? (
        <PhotoCropper
          file={cropping}
          onCancel={() => setCropping(null)}
          onCropped={(file) => {
            setCropping(null);
            void attachPhoto(file);
          }}
        />
      ) : null}

      <section className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Your photo *</h2>
        <div className="flex items-center gap-4">
          <div
            className={`flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-brand-teal bg-muted ${
              uploading ? "opacity-50" : ""
            }`}
          >
            {photo ? (
              // A local preview of the picked file, never a remote URL.
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="Your photo" className="size-full object-cover" src={photo.preview} />
            ) : (
              <UserRound className="size-10 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <Button className="h-10" disabled={uploading} onClick={() => setCamera(true)} type="button">
              <Camera className="size-4" />
              {photo ? "Take again" : "Take photo"}
            </Button>
            <Button
              className="h-10"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
              type="button"
              variant="outline"
            >
              <ImagePlus className="size-4" />
              Upload photo
            </Button>
            <input
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];

                event.target.value = "";
                if (file) setCropping(file);
              }}
              ref={fileInput}
              type="file"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {uploading ? "Uploading your photo…" : "Face clear and well lit. The hostel checks you against it."}
        </p>
      </section>

      <section className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Documents</h2>
        {DOCUMENT_KINDS.map(([kind, label]) => {
          const scan = scans[kind];
          const required = kind === "APPLICANT_ID" || guardianDocRequired;
          const waiting = Boolean(scan && !scan.fileAssetId);
          const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];

            event.target.value = "";
            if (file) void attachScan(kind, file);
          };
          const button =
            "inline-flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border text-sm font-medium hover:bg-muted";

          return (
            <div className="space-y-3 border-t border-border pt-4 first-of-type:border-t-0 first-of-type:pt-0" key={kind}>
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted ${
                    waiting ? "opacity-50" : ""
                  }`}
                >
                  {scan?.preview ? (
                    // A local preview of the picked file, never a remote URL.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt={label} className="size-full object-cover" src={scan.preview} />
                  ) : (
                    <FileText className="size-6 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {waiting ? "Uploading…" : scan ? scan.name : required ? "Required" : "Optional"}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <label className={button}>
                  <Camera className="size-4" />
                  {scan ? "Take again" : "Take photo"}
                  <input accept="image/*" capture="environment" className="hidden" disabled={waiting} onChange={pick} type="file" />
                </label>
                <label className={button}>
                  <ImagePlus className="size-4" />
                  Upload
                  <input
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    disabled={waiting}
                    onChange={pick}
                    type="file"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </section>

      {SECTIONS.map((section) => (
        <section className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm" key={section.title}>
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">{section.title}</h2>
          <div className="grid grid-cols-2 gap-3">
            {section.fields.map((field) => (
              <label className={`block space-y-1.5 ${field.full ? "col-span-2" : ""}`} key={field.key}>
                <span className="text-sm font-semibold">{field.label}</span>
                <input
                  className={inputClass}
                  max={field.type === "date" ? new Date().toISOString().slice(0, 10) : undefined}
                  onChange={(event) => set(field.key, event.target.value)}
                  placeholder={field.placeholder}
                  type={field.type ?? "text"}
                  value={draft[field.key] ?? ""}
                />
              </label>
            ))}
          </div>

          {section.title === "About you" ? (
            <fieldset className="space-y-2 pt-1">
              <legend className="mb-2 text-sm font-semibold">Gender</legend>
              <div className="flex flex-wrap gap-2">
                {GENDERS.map(([value, label]) => (
                  <button
                    aria-pressed={draft.gender === value}
                    className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                      draft.gender === value ? "border-brand-teal bg-brand-teal-soft" : "border-border"
                    }`}
                    key={value}
                    onClick={() => set("gender", draft.gender === value ? "" : value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {section.title === "About you" ? (
            <fieldset className="space-y-2 pt-1">
              <legend className="mb-2 text-sm font-semibold">Food</legend>
              <div className="flex flex-wrap gap-2">
                {FOOD.map(([value, label]) => (
                  <button
                    aria-pressed={draft.food === value}
                    className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                      draft.food === value ? "border-brand-teal bg-brand-teal-soft" : "border-border"
                    }`}
                    key={value}
                    onClick={() => set("food", draft.food === value ? "" : value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {section.title === "About you" ? (
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold">
                Any disease? <span className="font-normal text-muted-foreground">Optional</span>
              </span>
              <textarea
                className="min-h-20 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-brand-teal"
                maxLength={500}
                onChange={(event) => set("medicalNotes", event.target.value)}
                value={draft.medicalNotes ?? ""}
              />
            </label>
          ) : null}
        </section>
      ))}

      <section className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Signature</h2>
        <p className="text-sm text-muted-foreground">It goes on the back of your ID card.</p>
        <SignaturePad onChange={(value) => set("signature", value)} value={draft.signature ?? ""} />
      </section>

      <section className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
        <label className="flex items-start gap-3 text-sm">
          <input
            checked={agreed}
            className="mt-0.5 size-5 shrink-0 accent-brand-teal"
            onChange={(event) => setAgreed(event.target.checked)}
            type="checkbox"
          />
          <span>
            I agree to the rules of {view.hostel.name} and will follow them. If I break them, I accept the
            action the hostel takes.
          </span>
        </label>

        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

        <Button className="h-11 w-full" disabled={busy} onClick={send} type="button">
          {busy ? "Sending…" : `Send to ${view.hostel.name}`}
        </Button>
      </section>

      <a
        className="mx-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        href={`hostelpalika://join/apply/${token}`}
      >
        <Smartphone className="size-3.5" />
        Have the HostelPalika app? Open this in the app
      </a>
    </Shell>
  );
}

function Shell({ children, city, hostelName }: { children: React.ReactNode; city?: string; hostelName: string }) {
  return (
    <PublicShell footer={false}>
      <main className="mx-auto w-full max-w-xl pb-16">
        <div className="rounded-b-[2rem] bg-brand-teal px-5 pb-16 pt-8 text-white">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/75">Filling form for</p>
          <h1 className="mt-1 text-2xl font-bold leading-tight">{hostelName || " "}</h1>
          {city ? <p className="mt-0.5 text-sm text-white/80">{city}</p> : null}
        </div>
        <div className="-mt-10 space-y-4 px-4">{children}</div>
      </main>
    </PublicShell>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm">
      {children}
    </section>
  );
}
