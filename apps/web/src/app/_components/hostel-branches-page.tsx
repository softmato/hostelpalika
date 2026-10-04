"use client";

import Link from "next/link";

import { Building2, FileCheck2, Loader2, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  EMPTY_PAYOUT_DRAFT,
  PayoutAccountFields,
  payoutAccountPayload,
} from "@/components/bookings/payout-account-fields";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { uploadRegistrationDocument } from "@/lib/uploads/registration-document";
import { toast } from "@/stores/toast-store";

import { PortalPageHeader, SectionCard, SoftBadge } from "./portal-dashboard-ui";

const BRANCHES = "/api/v1/hostel-admin/branches";

type BranchesView = {
  allowance: { active: boolean; cap: number; planName: string | null; used: number };
  branches: Array<{
    area: string;
    city: string;
    id: string;
    name: string;
    slug: string;
    status: string;
  }>;
  main: {
    id: string;
    name: string;
    slug: string;
    status: string;
    area: string;
    city: string;
    panNumber: string | null;
  };
};

type RoomRow = {
  bedsPerRoom: string;
  monthlyRent: string;
  rooms: string;
  roomType: string;
};

const EMPTY_ROOM: RoomRow = { bedsPerRoom: "", monthlyRent: "", rooms: "", roomType: "" };
const FIELD =
  "mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-brand-teal";

const STATUS: Record<
  string,
  { label: string; tone: "amber" | "green" | "rose" | "slate" }
> = {
  PENDING_APPROVAL: { label: "Waiting for our call", tone: "amber" },
  PUBLISHED: { label: "Live", tone: "green" },
  REJECTED: { label: "Not approved", tone: "rose" },
};

function errorText(error: unknown) {
  return error instanceof ApiRequestError || error instanceof Error
    ? error.message
    : "Something went wrong.";
}

export function HostelBranchesPageContent() {
  const resource = usePortalResource<BranchesView>(BRANCHES);
  const invalidate = useInvalidateResources();
  const view = resource.data;
  const [open, setOpen] = useState(false);

  const room = view ? view.allowance.cap - view.allowance.used : 0;
  const blocked = !view
    ? null
    : view.allowance.cap === 0
      ? `${view.allowance.planName ?? "Your plan"} does not include branches. Max does.`
      : !view.allowance.active
        ? "Your plan has to be active — clear any due first."
        : room <= 0
          ? `${view.allowance.planName} includes ${view.allowance.cap} ${view.allowance.cap === 1 ? "branch" : "branches"}, and all are in use.`
          : null;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader
        breadcrumb={["Home", "Branches"]}
        description="One owner account, all your branches. Each has its own residents, rooms, payments and settings."
        title="Branches"
      />

      <SectionCard
        actions={
          view && !blocked && !open ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white hover:brightness-110"
              onClick={() => setOpen(true)}
              type="button"
            >
              <Plus className="size-4" />
              Add a branch
            </button>
          ) : null
        }
        description={
          view
            ? `${view.allowance.used} of ${view.allowance.cap} on ${view.allowance.planName ?? "your plan"}. Branches cost nothing extra.`
            : undefined
        }
        title="Your branches"
      >
        {resource.state === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading branches
          </p>
        ) : null}
        {resource.state === "error" ? (
          <div role="alert">
            <p className="text-sm text-destructive">{resource.message}</p>
            <button
              className="mt-2 text-sm font-semibold text-brand-teal"
              onClick={resource.refresh}
            >
              Try again
            </button>
          </div>
        ) : null}
        {blocked ? <p className="text-sm text-muted-foreground">{blocked}</p> : null}
        {view ? (
          <ul className="mt-2 divide-y divide-border">
            {[view.main, ...view.branches].map((branch) => {
              const status = STATUS[branch.status] ?? {
                label: branch.status,
                tone: "slate" as const,
              };

              return (
                <li
                  className="flex items-center justify-between gap-3 py-3"
                  key={branch.id}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Building2 className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {branch.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[branch.area, branch.city].filter(Boolean).join(", ")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <SoftBadge tone={status.tone}>{status.label}</SoftBadge>
                    {branch.status === "PUBLISHED" ? (
                      <Link
                        className="text-xs font-semibold text-brand-teal underline"
                        href={`/${encodeURIComponent(branch.slug)}/admin/dashboard`}
                      >
                        Open
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </SectionCard>

      {open && view ? (
        <BranchForm
          onCancel={() => setOpen(false)}
          onFiled={() => {
            setOpen(false);
            invalidate(BRANCHES);
          }}
        />
      ) : null}
    </div>
  );
}

function BranchForm({
  onCancel,
  onFiled,
}: {
  onCancel: () => void;
  onFiled: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [city, setCity] = useState("Kathmandu");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [phone, setPhone] = useState("");
  const [hostelType, setHostelType] = useState<"BOYS" | "CO_LIVING" | "GIRLS">(
    "CO_LIVING",
  );
  const [rooms, setRooms] = useState<RoomRow[]>([{ ...EMPTY_ROOM }]);
  const [panNumber, setPanNumber] = useState("");
  const [certificate, setCertificate] = useState<{
    claimToken: string;
    fileAssetId: string;
    name: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [payout, setPayout] = useState(EMPTY_PAYOUT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setRoom(index: number, patch: Partial<RoomRow>) {
    setRooms((current) =>
      current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  }

  async function upload(file: File) {
    setUploading(true);
    setError("");

    try {
      const uploaded = await uploadRegistrationDocument(file, "PAN / VAT document");

      setCertificate({ ...uploaded, name: file.name });
    } catch (uploadError) {
      setError(errorText(uploadError));
    } finally {
      setUploading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError("");

    if (
      step === 0 &&
      (name.trim().length < 2 ||
        area.trim().length < 2 ||
        city.trim().length < 2 ||
        phone.trim().length < 7)
    ) {
      setError("Add a name, area, city and valid contact number.");
      return;
    }
    if (
      step === 1 &&
      rooms.some(
        (row) =>
          Object.values(row).some((value) => value.trim()) &&
          (!row.roomType.trim() ||
            !Number.isInteger(Number(row.rooms)) ||
            Number(row.rooms) < 1 ||
            !Number.isInteger(Number(row.bedsPerRoom)) ||
            Number(row.bedsPerRoom) < 1 ||
            !Number.isFinite(Number(row.monthlyRent)) ||
            Number(row.monthlyRent) < 0),
      )
    ) {
      setError(
        "Complete each room type with a positive room and bed count, and a valid rent, or leave it blank.",
      );
      return;
    }
    if (step < 2) {
      setStep(step + 1);
      return;
    }

    const roomConfigurations = rooms
      .filter((row) => row.roomType.trim() && Number(row.rooms) > 0)
      .map((row) => {
        const count = Number(row.rooms);
        const beds = Number(row.bedsPerRoom) || 1;

        return {
          bedsPerRoom: beds,
          mealInclusion: "Included" as const,
          monthlyRent: Number(row.monthlyRent) || undefined,
          rooms: count,
          roomType: row.roomType.trim(),
          vacantBeds: count * beds,
        };
      });

    if (
      (payout.holderName.trim() || payout.bankName.trim() || payout.branch.trim()) &&
      !payout.number.trim()
    ) {
      setError(
        "Enter an account number, or leave the payment section blank to add it later.",
      );
      return;
    }

    setSaving(true);

    try {
      await browserApi(BRANCHES, {
        body: JSON.stringify({
          contact: { phone: phone.trim() || undefined },
          documents: certificate
            ? [
                {
                  claimToken: certificate.claimToken,
                  documentType: "PAN / VAT document",
                  fileAssetId: certificate.fileAssetId,
                },
              ]
            : [],
          hostelType,
          landmark: landmark.trim() || undefined,
          location: {
            address: address.trim() || undefined,
            area: area.trim(),
            city: city.trim(),
          },
          name: name.trim(),
          panNumber: panNumber.replace(/\s/g, "") || undefined,
          payoutAccount: payoutAccountPayload(payout),
          roomConfigurations,
          roomTypes: roomConfigurations.map((row) => row.roomType),
        }),
        method: "POST",
      });
      toast.success({
        description: "We will call the branch before it goes live.",
        title: `${name.trim()} sent for approval`,
      });
      onFiled();
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      description="Use your existing owner account. Add the branch details now; optional business and payment details can be completed later. We review the branch before it goes live."
      title="Add a branch"
    >
      <form className="space-y-5" onSubmit={submit}>
        <ol className="grid grid-cols-3 gap-2" aria-label="Branch setup progress">
          {["Branch details", "Rooms", "Business & payments"].map((label, index) => (
            <li
              key={label}
              aria-current={step === index ? "step" : undefined}
              className={`rounded-xl border p-3 text-xs font-semibold ${step === index ? "border-brand-teal bg-brand-teal/10 text-brand-teal" : "border-border text-muted-foreground"}`}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        <fieldset hidden={step !== 0} disabled={step !== 0 || saving}>
          <div hidden={step !== 0}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-foreground">
                Branch name
                <input
                  className={FIELD}
                  onChange={(event) => setName(event.target.value)}
                  required
                  value={name}
                />
              </label>
              <label className="text-xs font-semibold text-foreground">
                Phone at the branch (we call it)
                <input
                  className={FIELD}
                  inputMode="tel"
                  onChange={(event) => setPhone(event.target.value)}
                  required
                  value={phone}
                />
              </label>
              <label className="text-xs font-semibold text-foreground">
                Area
                <input
                  className={FIELD}
                  onChange={(event) => setArea(event.target.value)}
                  required
                  value={area}
                />
              </label>
              <label className="text-xs font-semibold text-foreground">
                City
                <input
                  className={FIELD}
                  onChange={(event) => setCity(event.target.value)}
                  required
                  value={city}
                />
              </label>
              <label className="text-xs font-semibold text-foreground">
                Address
                <input
                  className={FIELD}
                  onChange={(event) => setAddress(event.target.value)}
                  value={address}
                />
              </label>
              <label className="text-xs font-semibold text-foreground">
                Landmark
                <input
                  className={FIELD}
                  onChange={(event) => setLandmark(event.target.value)}
                  value={landmark}
                />
              </label>
              <label className="text-xs font-semibold text-foreground">
                Type
                <select
                  className={FIELD}
                  onChange={(event) =>
                    setHostelType(event.target.value as typeof hostelType)
                  }
                  value={hostelType}
                >
                  <option value="CO_LIVING">Co-living</option>
                  <option value="BOYS">Boys</option>
                  <option value="GIRLS">Girls</option>
                </select>
              </label>
            </div>
          </div>
        </fieldset>
        <fieldset hidden={step !== 1} disabled={step !== 1 || saving}>
          <div hidden={step !== 1}>
            <p className="mb-3 text-sm text-muted-foreground">
              Add the room types for this branch, or continue and set them up later.
            </p>
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold text-foreground">Rooms</legend>
              {rooms.map((row, index) => (
                <div
                  className="grid grid-cols-2 sm:grid-cols-[1fr_5rem_5rem_7rem_2rem] items-end gap-2"
                  key={index}
                >
                  <input
                    aria-label="Room type"
                    className={FIELD}
                    onChange={(event) => setRoom(index, { roomType: event.target.value })}
                    placeholder="e.g. 2 seater"
                    value={row.roomType}
                  />
                  <input
                    aria-label="Rooms"
                    className={FIELD}
                    inputMode="numeric"
                    onChange={(event) => setRoom(index, { rooms: event.target.value })}
                    placeholder="Rooms"
                    value={row.rooms}
                  />
                  <input
                    aria-label="Beds per room"
                    className={FIELD}
                    inputMode="numeric"
                    onChange={(event) =>
                      setRoom(index, { bedsPerRoom: event.target.value })
                    }
                    placeholder="Beds"
                    value={row.bedsPerRoom}
                  />
                  <input
                    aria-label="Monthly rent"
                    className={FIELD}
                    inputMode="numeric"
                    onChange={(event) =>
                      setRoom(index, { monthlyRent: event.target.value })
                    }
                    placeholder="Rent / month"
                    value={row.monthlyRent}
                  />
                  <button
                    aria-label="Remove room type"
                    className="mb-2 text-muted-foreground hover:text-destructive disabled:opacity-30"
                    disabled={rooms.length === 1}
                    onClick={() =>
                      setRooms((current) => current.filter((_, at) => at !== index))
                    }
                    type="button"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
              <button
                className="text-xs font-semibold text-brand-teal"
                onClick={() => setRooms((current) => [...current, { ...EMPTY_ROOM }])}
                type="button"
              >
                + Another room type
              </button>
            </fieldset>
          </div>
        </fieldset>
        <fieldset hidden={step !== 2} disabled={step !== 2 || saving}>
          <div hidden={step !== 2} className="space-y-5">
            <div className="rounded-xl bg-muted p-4 text-sm">
              <p className="font-semibold">{name}</p>
              <p className="text-muted-foreground">
                {[area, city].filter(Boolean).join(", ")} / {phone}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                This branch uses your existing owner account and plan. Manage its
                residents, rooms, fees, staff and settings separately.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-foreground">
                Branch PAN/VAT number (optional)
                <input
                  className={`${FIELD} font-mono`}
                  inputMode="numeric"
                  onChange={(event) => setPanNumber(event.target.value)}
                  pattern="[0-9]{9}"
                  maxLength={9}
                  value={panNumber}
                />
              </label>
              <label className="text-xs font-semibold text-foreground">
                PAN/VAT certificate (optional)
                <span className="mt-1 flex h-10 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm font-normal text-muted-foreground">
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FileCheck2 className="size-4" />
                  )}
                  <span className="truncate">
                    {certificate ? certificate.name : "Choose a photo or PDF"}
                  </span>
                  <input
                    accept="image/*,application/pdf"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void upload(file);
                    }}
                    type="file"
                  />
                </span>
              </label>
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold text-foreground">
                Branch payout account (optional)
              </p>
              <p className="mb-3 text-sm text-muted-foreground">
                Use a separate bank account or wallet for this branch. Its PAN and account
                holder do not need to match another branch.
              </p>
              <PayoutAccountFields onChange={setPayout} value={payout} />
            </div>
          </div>
        </fieldset>
        {error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {step > 0 ? (
            <button
              className="rounded-lg border border-border px-4 py-2.5 text-sm font-semibold"
              disabled={saving}
              onClick={() => setStep(step - 1)}
              type="button"
            >
              Back
            </button>
          ) : null}
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-4 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-60"
            disabled={saving || uploading}
            type="submit"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {step < 2 ? "Continue" : "Submit branch for review"}
          </button>
          <button
            className="rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-foreground"
            disabled={saving}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </form>
    </SectionCard>
  );
}
