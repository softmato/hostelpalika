"use client";

import { Check, FileText, Loader2, Plus, Trash2 } from "@/components/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { FloorsPanel } from "@/app/_components/hostel-admin-floors-panel";
import { HostelPayoutAccountPanel } from "@/app/_components/hostel-payout-account-panel";
import { facilityOptions } from "@/app/_components/registration-fields";
import { RoomTypesPanel } from "@/app/_components/room-types-panel";
import { FoodWeekEditor, type FoodRoutineView } from "@/components/food/food-week-editor";
import { LocationPicker, type LocationPickerValue } from "@/components/maps/location-picker";
import { API_WRITE_EVENT, browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import type { HostelPhoto } from "@/lib/hostel-photos";
import { usePortalResource } from "@/lib/portal-query";
import { uploadRegistrationDocument } from "@/lib/uploads/registration-document";
import { uploadFiles } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";

/**
 * Every Hostel KYC step, filled in place and showing what is already saved —
 * photos as photos, documents as previews, the menu as a menu. Nothing here
 * sends the owner to another page; the heavy editors (room types, floors, the
 * week's menu, the map) are the same components their own screens use.
 */

export const KYC_ENDPOINT = "/api/v1/hostel-admin/kyc";

export type Kyc = {
  /** What the details step pre-fills from. */
  details?: { address: string; area: string; city: string; hostelType: string };
  documents: {
    canRemove?: boolean;
    fileAssetId?: string | null;
    fileName: string | null;
    id: string;
    mimeType?: string | null;
    rejectionReason?: string | null;
    status: string;
    type: string;
  }[];
  facilities: string[];
  minPhotos: number;
  percent: number;
  photoCount: number;
  /** A quick sign-up's review (docs/QUICK_SIGNUP_KYC_TRIAL.md); null for every older hostel. */
  review?: {
    canSubmit: boolean;
    missing: string[];
    note: string | null;
    status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
    submittedAt: string | null;
  } | null;
  rules: string[];
  steps: { done: boolean; key: string; required?: boolean }[];
};

/** Steps whose editor needs the card's full width. */
export const WIDE_STEPS = new Set(["documents", "food", "location", "photos", "rates", "rooms"]);

const PRIMARY =
  "inline-flex h-11 w-full items-center justify-center rounded-xl bg-brand-teal px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50";
const INPUT =
  "h-11 w-full rounded-xl border border-border bg-background px-3 text-sm font-normal text-foreground outline-none transition focus:border-brand-teal";
const LABEL = "grid gap-1.5 text-sm font-semibold text-foreground";

const HOSTEL_TYPES = [
  { label: "Boys", value: "BOYS" },
  { label: "Girls", value: "GIRLS" },
  { label: "Co-living", value: "CO_LIVING" },
] as const;

const DOCUMENTS = [
  { hint: "Citizenship or passport of the owner", label: "Owner ID", match: (type: string) => !/pan|vat/i.test(type), type: "Owner ID proof" },
  { hint: "The business's PAN or VAT certificate", label: "PAN / VAT", match: (type: string) => /pan|vat/i.test(type), type: "PAN / VAT document" },
] as const;

function errorText(caught: unknown) {
  return caught instanceof Error ? caught.message : "That did not save.";
}

const fileUrl = (assetId: string) => `/api/v1/files/${assetId}/url`;

export function KycStepBody({
  kyc,
  onChange,
  onSaved,
  stepKey,
}: {
  kyc: Kyc;
  /** Re-read the KYC without moving on. */
  onChange: () => void;
  /** Re-read and go to the next open step. */
  onSaved: () => Promise<void>;
  stepKey: string;
}) {
  switch (stepKey) {
    case "details":
      return <DetailsStep initial={kyc.details} onSaved={onSaved} />;
    case "photos":
      return <PhotosStep kyc={kyc} onChange={onChange} />;
    case "rates":
      return (
        <div className="space-y-6">
          <RoomTypesPanel />
          <RentStep onChange={onChange} />
        </div>
      );
    case "rooms":
      return <FloorsPanel />;
    case "documents":
      return <DocumentsStep kyc={kyc} onChange={onChange} />;
    case "payout":
      return <HostelPayoutAccountPanel />;
    case "payments":
      return <PaymentsStep onSaved={onSaved} />;
    case "opening":
      return <OpeningStep onSaved={onSaved} />;
    case "food":
      return <FoodStep onChange={onChange} />;
    case "rules":
      return <RulesStep initial={kyc.rules} onSaved={onSaved} />;
    case "facilities":
      return <FacilitiesStep initial={kyc.facilities} onSaved={onSaved} />;
    case "location":
      return <LocationStep onSaved={onSaved} />;
    default:
      return null;
  }
}

/** Save button + inline error, shared by the small forms below. */
function SaveForm({
  children,
  disabled,
  label = "Save",
  onSave,
}: {
  children: ReactNode;
  disabled?: boolean;
  label?: string;
  onSave: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await onSave();
        } catch (caught) {
          setError(errorText(caught));
        } finally {
          setSaving(false);
        }
      }}
    >
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <button className={PRIMARY} disabled={disabled || saving} type="submit">
        {saving ? "Saving…" : label}
      </button>
    </form>
  );
}

/* Hostel details ---------------------------------------------------------- */

function DetailsStep({ initial, onSaved }: { initial: Kyc["details"]; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    address: initial?.address ?? "",
    area: initial?.area ?? "",
    city: initial?.city || "Kathmandu",
    hostelType: initial?.hostelType ?? "CO_LIVING",
  });
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <SaveForm
      disabled={!form.area.trim() || !form.city.trim()}
      onSave={async () => {
        await browserApi(hostelAdminEndpoints.profile, {
          body: JSON.stringify({
            hostelType: form.hostelType,
            location: { address: form.address.trim(), area: form.area.trim(), city: form.city.trim() },
          }),
          method: "PATCH",
        });
        await onSaved();
      }}
    >
      <div className={LABEL}>
        Who lives here
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
          {HOSTEL_TYPES.map((type) => (
            <button
              className={cn(
                "h-9 rounded-lg text-sm font-semibold transition",
                form.hostelType === type.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
              )}
              key={type.value}
              onClick={() => set({ hostelType: type.value })}
              type="button"
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>
      <label className={LABEL}>
        Area
        <input className={INPUT} onChange={(e) => set({ area: e.target.value })} placeholder="e.g. Balkumari" value={form.area} />
      </label>
      <label className={LABEL}>
        City
        <input className={INPUT} onChange={(e) => set({ city: e.target.value })} placeholder="e.g. Lalitpur" value={form.city} />
      </label>
      <label className={LABEL}>
        <span>
          Street or tole <span className="font-normal text-muted-foreground">(optional)</span>
        </span>
        <input className={INPUT} onChange={(e) => set({ address: e.target.value })} placeholder="e.g. Shanti Marg" value={form.address} />
      </label>
    </SaveForm>
  );
}

/* Photos ------------------------------------------------------------------ */

function PhotosStep({ kyc, onChange }: { kyc: Kyc; onChange: () => void }) {
  const profile = usePortalResource<{ hostel: { photos?: HostelPhoto[] } }>(hostelAdminEndpoints.profile);
  const photos = (profile.data?.hostel.photos ?? []).filter((photo) => photo.url && photo.kind !== "ROOM");
  const input = useRef<HTMLInputElement>(null);
  const kind = useRef<"EXTERIOR" | "INTERIOR">("EXTERIOR");
  const [busy, setBusy] = useState<"" | "EXTERIOR" | "INTERIOR">("");
  const [removing, setRemoving] = useState("");
  const { confirm, confirmDialog } = useConfirm();

  async function add(files: File[]) {
    setBusy(kind.current);

    try {
      for (const file of files) {
        const [outcome] = await uploadFiles([file], { accessLevel: "PUBLIC", kind: "image", label: "Hostel photo", silent: true });
        const assetId = outcome?.ok ? outcome.result.assetId : undefined;

        if (!assetId) continue;

        await browserApi(`${hostelAdminEndpoints.profile}/photos`, {
          body: JSON.stringify({ fileAssetId: assetId, kind: kind.current, url: fileUrl(assetId) }),
          method: "POST",
        });
        await profile.refreshAsync();
      }
    } finally {
      setBusy("");
      onChange();
    }
  }

  async function remove(photo: HostelPhoto) {
    if (!photo.id || !(await confirm({ actionLabel: "Remove", description: "It leaves your public gallery.", title: "Remove this photo?", tone: "destructive" }))) {
      return;
    }

    setRemoving(photo.id);

    try {
      await browserApi(`${hostelAdminEndpoints.profile}/photos/${photo.id}`, { method: "DELETE" });
      await profile.refreshAsync();
      onChange();
    } finally {
      setRemoving("");
    }
  }

  return (
    <div className="space-y-5">
      {confirmDialog}
      <input
        accept="image/*"
        className="hidden"
        multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) void add(files);
        }}
        ref={input}
        type="file"
      />
      <p className="text-center text-sm text-muted-foreground">
        <strong className="text-foreground">{Math.min(kyc.photoCount, kyc.minPhotos)} of {kyc.minPhotos}</strong> photos needed
      </p>
      {(
        [
          ["EXTERIOR", "Outside", "The gate and the building from the road"],
          ["INTERIOR", "Inside", "Rooms, kitchen, dining, bathroom"],
        ] as const
      ).map(([value, title, hint]) => {
        const ofKind = photos.filter((photo) => photo.kind === value);

        return (
          <div className="space-y-2" key={value}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                {title} <span className="font-normal text-muted-foreground">· {ofKind.length}</span>
              </p>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {ofKind.map((photo) => (
                <div className="group relative" key={photo.id ?? photo.url}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={photo.alt || title}
                    className={cn("aspect-[4/3] w-full rounded-xl object-cover", removing === photo.id && "opacity-40")}
                    src={photo.url}
                  />
                  <button
                    aria-label="Remove photo"
                    className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100"
                    onClick={() => void remove(photo)}
                    type="button"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border text-xs font-semibold text-muted-foreground transition hover:border-brand-teal hover:text-brand-teal disabled:opacity-60"
                disabled={Boolean(busy)}
                onClick={() => {
                  kind.current = value;
                  input.current?.click();
                }}
                type="button"
              >
                {busy === value ? <Loader2 className="size-5 animate-spin" /> : <Plus className="size-5" />}
                {busy === value ? "Uploading…" : "Add"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Rent -------------------------------------------------------------------- */

type Schedules = {
  roomTypes: { monthlyRent: number; roomType: string }[];
  schedules: {
    admissionFee?: number;
    depositAmount?: number;
    rates: { monthlyAmount: number; roomType?: string | null }[];
    standing?: "current" | "past" | "upcoming";
  }[];
};

/**
 * The monthly rent per room type, plus the two joining fees — typed here and
 * saved to the rate card without leaving KYC. A card that has billed nobody is
 * corrected in place; once it has, a changed price starts next month (the
 * server decides, see `saveKycRates`).
 */
function RentStep({ onChange }: { onChange: () => void }) {
  const resource = usePortalResource<Schedules>(hostelAdminEndpoints.feeSchedules);
  // The room-type cards above read their rent off the profile, which the save re-projects.
  const profile = usePortalResource(hostelAdminEndpoints.profile);
  const [rents, setRents] = useState<Record<string, string>>({});
  const [admission, setAdmission] = useState<string>();
  const [deposit, setDeposit] = useState<string>();
  const [note, setNote] = useState("");
  const { refresh } = resource;

  // A room type added in the panel above shows up here at once.
  useEffect(() => {
    window.addEventListener(API_WRITE_EVENT, refresh);
    return () => window.removeEventListener(API_WRITE_EVENT, refresh);
  }, [refresh]);

  const data = resource.data;

  if (!data) return <div className="h-24 animate-pulse rounded-2xl bg-muted" />;
  if (data.roomTypes.length === 0) return null;

  const card = data.schedules.find((item) => item.standing === "upcoming") ?? data.schedules.find((item) => item.standing === "current");
  const savedRent = (roomType: string) =>
    card?.rates.find((item) => (item.roomType ?? "").toLowerCase() === roomType.toLowerCase())?.monthlyAmount;
  const rentOf = (roomType: string) => rents[roomType] ?? String(savedRent(roomType) ?? "");
  const admissionValue = admission ?? (card?.admissionFee ? String(card.admissionFee) : "");
  const depositValue = deposit ?? (card?.depositAmount ? String(card.depositAmount) : "");
  const rates = data.roomTypes
    .filter((type) => Number(rentOf(type.roomType)) > 0)
    .map((type) => ({ monthlyAmount: Number(rentOf(type.roomType)), roomType: type.roomType }));
  const digits = (value: string) => value.replace(/\D/g, "");

  return (
    <section className="space-y-3">
      <h3 className="font-heading text-[15px] font-semibold text-foreground">Monthly rent</h3>
      <SaveForm
        disabled={rates.length === 0}
        label="Save rents"
        onSave={async () => {
          const saved = await browserApi<{ nextMonth: boolean }>(`${hostelAdminEndpoints.feeSchedules}/kyc`, {
            body: JSON.stringify({
              admissionFee: admissionValue ? Number(admissionValue) : undefined,
              depositAmount: depositValue ? Number(depositValue) : undefined,
              rates,
            }),
            method: "POST",
          });
          setNote(saved.nextMonth ? "Saved. Residents are already billed at the old price this month, so the new price starts next month." : "Saved.");
          setRents({});
          setAdmission(undefined);
          setDeposit(undefined);
          await Promise.all([resource.refreshAsync(), profile.refreshAsync()]);
          onChange();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {data.roomTypes.map((type) => (
            <label className={LABEL} key={type.roomType}>
              <span className="flex items-baseline justify-between gap-2">
                {type.roomType} (Rs / month)
                {savedRent(type.roomType) ? null : <span className="text-xs font-semibold text-warning">Not priced</span>}
              </span>
              <input
                className={INPUT}
                inputMode="numeric"
                onChange={(event) => setRents((current) => ({ ...current, [type.roomType]: digits(event.target.value) }))}
                placeholder="12000"
                value={rentOf(type.roomType)}
              />
            </label>
          ))}
          <label className={LABEL}>
            <span>
              Admission fee <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <input className={INPUT} inputMode="numeric" onChange={(e) => setAdmission(digits(e.target.value))} placeholder="0" value={admissionValue} />
          </label>
          <label className={LABEL}>
            <span>
              Security deposit <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <input className={INPUT} inputMode="numeric" onChange={(e) => setDeposit(digits(e.target.value))} placeholder="0" value={depositValue} />
          </label>
        </div>
      </SaveForm>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </section>
  );
}

/* Documents --------------------------------------------------------------- */

function DocumentsStep({ kyc, onChange }: { kyc: Kyc; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<string>(DOCUMENTS[0].type);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { confirm, confirmDialog } = useConfirm();

  async function remove(row: Kyc["documents"][number]) {
    const ok = await confirm({
      actionLabel: "Remove",
      description: "You can upload it again any time.",
      title: `Remove ${row.fileName ?? row.type}?`,
      tone: "destructive",
    });
    if (!ok) return;

    setBusy(row.id);
    setError("");

    try {
      await browserApi(`${KYC_ENDPOINT}?documentId=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      onChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove it.");
    } finally {
      setBusy("");
    }
  }

  async function upload(file: File) {
    const type = pending.current;

    setBusy(type);
    setError("");

    try {
      const uploaded = await uploadRegistrationDocument(file, type);

      await browserApi(KYC_ENDPOINT, {
        body: JSON.stringify({ documents: [{ ...uploaded, documentType: type }] }),
        method: "POST",
      });
      onChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-5">
      {confirmDialog}
      <input
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
        ref={input}
        type="file"
      />
      {DOCUMENTS.map((doc) => {
        const rows = kyc.documents.filter((row) => doc.match(row.type));

        return (
          <div className="space-y-2" key={doc.type}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">{doc.label}</p>
              <p className="text-xs text-muted-foreground">{doc.hint}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {rows.map((row) => {
                const image = row.fileAssetId && (row.mimeType ?? "").startsWith("image/");

                return (
                  <div className="group relative overflow-hidden rounded-xl border border-border" key={row.id}>
                    <a
                      className="block aspect-[4/3] bg-muted"
                      href={row.fileAssetId ? fileUrl(row.fileAssetId) : undefined}
                      rel="noreferrer"
                      target="_blank"
                      title="Open"
                    >
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img alt={row.fileName ?? doc.label} className="size-full object-cover" src={fileUrl(row.fileAssetId!)} />
                      ) : (
                        <span className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
                          <FileText className="size-7" />
                          <span className="text-[11px] font-semibold">PDF</span>
                        </span>
                      )}
                    </a>
                    <div className="flex items-center gap-1.5 px-2 py-1.5">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                          row.status === "APPROVED"
                            ? "bg-brand-teal/10 text-brand-teal"
                            : row.status === "REJECTED"
                              ? "bg-destructive/10 text-destructive"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {row.status === "APPROVED" ? "Approved" : row.status === "REJECTED" ? "Rejected" : "Checking"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{row.fileName}</span>
                      {row.canRemove ? (
                        <button
                          aria-label={`Remove ${row.fileName ?? row.type}`}
                          className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                          disabled={Boolean(busy)}
                          onClick={() => void remove(row)}
                          type="button"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                    {row.status === "REJECTED" && row.rejectionReason ? (
                      <p className="px-2 pb-2 text-[11px] text-destructive">{row.rejectionReason}</p>
                    ) : null}
                  </div>
                );
              })}
              <button
                className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border text-xs font-semibold text-muted-foreground transition hover:border-brand-teal hover:text-brand-teal disabled:opacity-60"
                disabled={Boolean(busy)}
                onClick={() => {
                  pending.current = doc.type;
                  input.current?.click();
                }}
                type="button"
              >
                {busy === doc.type ? <Loader2 className="size-5 animate-spin" /> : <Plus className="size-5" />}
                {busy === doc.type ? "Uploading…" : rows.length ? "Add another" : "Upload photo or PDF"}
              </button>
            </div>
          </div>
        );
      })}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/* Rent payments ----------------------------------------------------------- */

type PaymentProfile = {
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  esewaId: string | null;
  khaltiId: string | null;
};

const PAYMENT_FIELDS: [keyof PaymentProfile, string, string][] = [
  ["esewaId", "eSewa ID", "98XXXXXXXX"],
  ["khaltiId", "Khalti ID", "98XXXXXXXX"],
  ["bankName", "Bank name", "e.g. Nabil Bank"],
  ["bankAccountName", "Account name", "As the bank has it"],
  ["bankAccountNumber", "Account number", "0123456789"],
];

function PaymentsStep({ onSaved }: { onSaved: () => Promise<void> }) {
  const resource = usePortalResource<{ profile: PaymentProfile }>(hostelAdminEndpoints.paymentProfile);

  if (!resource.data) return <div className="h-40 animate-pulse rounded-2xl bg-muted" />;

  return <PaymentsForm key="loaded" onSaved={onSaved} saved={resource.data.profile} />;
}

function PaymentsForm({ onSaved, saved }: { onSaved: () => Promise<void>; saved: PaymentProfile }) {
  const [form, setForm] = useState<Record<keyof PaymentProfile, string>>(() => ({
    bankAccountName: saved.bankAccountName ?? "",
    bankAccountNumber: saved.bankAccountNumber ?? "",
    bankName: saved.bankName ?? "",
    esewaId: saved.esewaId ?? "",
    khaltiId: saved.khaltiId ?? "",
  }));
  const filled = Object.fromEntries(Object.entries(form).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));

  return (
    <SaveForm
      disabled={!form.esewaId.trim() && !form.khaltiId.trim() && !form.bankAccountNumber.trim()}
      onSave={async () => {
        await browserApi(hostelAdminEndpoints.paymentProfile, { body: JSON.stringify(filled), method: "PATCH" });
        await onSaved();
      }}
    >
      <p className="text-xs text-muted-foreground">Any one is enough. Residents see these when they pay rent.</p>
      <div className="grid gap-3">
        {PAYMENT_FIELDS.map(([key, label, placeholder]) => (
          <label className={LABEL} key={key}>
            {label}
            <input
              className={INPUT}
              inputMode={key === "bankName" || key === "bankAccountName" ? "text" : "numeric"}
              onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
              placeholder={placeholder}
              value={form[key]}
            />
          </label>
        ))}
      </div>
    </SaveForm>
  );
}

/* Opening balance --------------------------------------------------------- */

/**
 * The bank's closing balance the day they start with us, so the statement's
 * balance matches the bank (docs/FIELD_FIXES_2026_10.md §4).
 */
function OpeningStep({ onSaved }: { onSaved: () => Promise<void> }) {
  const resource = usePortalResource<{ rules: { openingBalance: { amount: number; asOf: string } | null } }>(
    "/api/v1/hostel-admin/finance/money-rules",
  );

  if (!resource.data) return <div className="h-40 animate-pulse rounded-2xl bg-muted" />;

  return <OpeningForm onSaved={onSaved} saved={resource.data.rules.openingBalance} />;
}

function OpeningForm({ onSaved, saved }: { onSaved: () => Promise<void>; saved: { amount: number; asOf: string } | null }) {
  const [amount, setAmount] = useState(saved ? String(saved.amount) : "");
  const [asOf, setAsOf] = useState(() => saved?.asOf ?? new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 10));

  return (
    <SaveForm
      disabled={amount.trim() === "" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)}
      onSave={async () => {
        await browserApi("/api/v1/hostel-admin/finance/money-rules", {
          body: JSON.stringify({ openingBalance: { amount: Number(amount), asOf } }),
          method: "PUT",
        });
        await onSaved();
      }}
    >
      <label className={LABEL}>
        Bank balance (Rs)
        <input
          className={INPUT}
          inputMode="numeric"
          onChange={(event) => setAmount(event.target.value.replace(/[^\d-]/g, ""))}
          placeholder="250000"
          value={amount}
        />
      </label>
      <label className={LABEL}>
        On the day
        <input className={INPUT} onChange={(event) => setAsOf(event.target.value)} type="date" value={asOf} />
      </label>
      <p className="text-xs text-muted-foreground">Your statement starts from this, so it matches your bank. Use minus for an overdraft.</p>
    </SaveForm>
  );
}

/* Food -------------------------------------------------------------------- */

function FoodStep({ onChange }: { onChange: () => void }) {
  const resource = usePortalResource<{ routine: FoodRoutineView | null }>(hostelAdminEndpoints.foodRoutine);

  if (!resource.data) return <div className="h-64 animate-pulse rounded-2xl bg-muted" />;

  return (
    <FoodWeekEditor
      onSaved={async () => {
        await resource.refreshAsync();
        onChange();
      }}
      routine={resource.data.routine}
    />
  );
}

/* Rules & facilities ------------------------------------------------------ */

function RulesStep({ initial, onSaved }: { initial: string[]; onSaved: () => Promise<void> }) {
  const [text, setText] = useState(initial.join("\n"));
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <SaveForm
      disabled={rules.length === 0}
      onSave={async () => {
        await browserApi(hostelAdminEndpoints.profile, { body: JSON.stringify({ rules }), method: "PATCH" });
        await onSaved();
      }}
    >
      <label className={LABEL}>
        <span>
          House rules <span className="font-normal text-muted-foreground">· one per line</span>
        </span>
        <textarea
          className={cn(INPUT, "h-auto min-h-40 resize-y py-2.5")}
          onChange={(event) => setText(event.target.value)}
          placeholder={"Gate closes at 10 PM\nNo smoking indoors"}
          value={text}
        />
      </label>
    </SaveForm>
  );
}

function FacilitiesStep({ initial, onSaved }: { initial: string[]; onSaved: () => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>(initial);
  const options = [...new Set([...facilityOptions, ...initial])];

  return (
    <SaveForm
      disabled={picked.length === 0}
      onSave={async () => {
        await browserApi(hostelAdminEndpoints.profile, { body: JSON.stringify({ facilities: picked }), method: "PATCH" });
        await onSaved();
      }}
    >
      <p className="text-sm font-semibold text-foreground">
        What you offer <span className="font-normal text-muted-foreground">· {picked.length} picked</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const on = picked.includes(option);

          return (
            <button
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition",
                on ? "border-brand-teal bg-brand-teal text-white" : "border-border text-foreground hover:bg-muted",
              )}
              key={option}
              onClick={() => setPicked((current) => (on ? current.filter((item) => item !== option) : [...current, option]))}
              type="button"
            >
              {on ? <Check className="size-3.5" /> : null}
              {option}
            </button>
          );
        })}
      </div>
    </SaveForm>
  );
}

/* Map pin ----------------------------------------------------------------- */

type ProfileLocation = {
  address?: string;
  area?: string;
  city?: string;
  lat?: number | null;
  lng?: number | null;
  locationSource?: string;
  province?: string;
};

function LocationStep({ onSaved }: { onSaved: () => Promise<void> }) {
  const resource = usePortalResource<{ hostel: { location?: ProfileLocation } }>(hostelAdminEndpoints.profile);

  if (!resource.data) return <div className="h-80 animate-pulse rounded-2xl bg-muted" />;

  return <LocationForm onSaved={onSaved} saved={resource.data.hostel.location ?? {}} />;
}

function LocationForm({ onSaved, saved }: { onSaved: () => Promise<void>; saved: ProfileLocation }) {
  const [value, setValue] = useState<LocationPickerValue>(() => ({
    coordinates: saved.lat != null && saved.lng != null ? { lat: saved.lat, lng: saved.lng } : null,
    source: saved.locationSource === "MANUAL" ? "MANUAL" : "GEOCODED",
  }));
  // Address parts the picker found, kept only where the hostel has none yet.
  const [found, setFound] = useState<Partial<ProfileLocation>>({});
  const addressHint = [saved.address, saved.area, saved.city].filter(Boolean).join(", ");

  return (
    <SaveForm
      disabled={!value.coordinates}
      label="Save the pin"
      onSave={async () => {
        if (!value.coordinates) return;
        await browserApi(hostelAdminEndpoints.profile, {
          body: JSON.stringify({
            location: {
              ...Object.fromEntries(Object.entries(found).filter(([key, part]) => part && !saved[key as keyof ProfileLocation])),
              lat: value.coordinates.lat,
              lng: value.coordinates.lng,
              locationSource: "MANUAL",
            },
          }),
          method: "PATCH",
        });
        await onSaved();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {addressHint || "Your hostel"}
        {saved.locationSource === "MANUAL" ? " · pin placed by you" : " · pin is an estimate — move it onto your gate"}
      </p>
      <LocationPicker
        addressHint={addressHint}
        onChange={(next) => setValue({ ...next, source: "MANUAL" })}
        onResolvedAddress={(parts) => setFound(parts)}
        value={value}
      />
    </SaveForm>
  );
}
