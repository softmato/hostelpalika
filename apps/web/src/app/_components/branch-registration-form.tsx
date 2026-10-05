"use client";

import {
  ArrowLeft,
  ArrowRight,
  BedDouble,
  Building2,
  CheckCircle2,
  MapPin,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";

import {
  EMPTY_PAYOUT_DRAFT,
  PayoutAccountFields,
  payoutAccountPayload,
} from "@/components/bookings/payout-account-fields";
import {
  LocationPicker,
  type LocationPickerValue,
} from "@/components/maps/location-picker";
import { browserApi } from "@/lib/browser-api";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadRegistrationDocument } from "@/lib/uploads/registration-document";
import { uploadFile } from "@/lib/uploads/uploader";
import { branchRequestSchema } from "@/modules/hostels/hostel-branch.validation";
import { toast } from "@/stores/toast-store";

import {
  BEDS_BY_ROOM_TYPE,
  cityOptions,
  editRoomRow,
  facilityOptions,
  FileUploadArea,
  submittedDocuments,
  type UploadedFile,
} from "./registration-fields";
import {
  EMPTY_SHORT_STAYS,
  RegistrationShortStays,
  shortStaysPayload,
} from "./registration-short-stays";

import { RegistrationRooms } from "./registration-rooms";
import { nextAvailableRoomType } from "./room-type-picker";
import { StepFlow, StepRail } from "./registration-step-shell";
import { DescriptionSuggestions } from "./description-suggestions";

const FIELD = "input-field mt-2 block w-full min-w-0";
const STEPS = [
  { title: "Your hostel", hint: "A familiar name, a fresh start", icon: Building2 },
  { title: "Location", hint: "Put this branch on the map", icon: MapPin },
  { title: "Rooms & capacity", hint: "Make room for your residents", icon: BedDouble },
  { title: "Life here", hint: "Show what makes it home", icon: Sparkles },
  { title: "Review & finish", hint: "One last look before we call", icon: CheckCircle2 },
];
type Room = {
  id: string;
  roomType: string;
  rooms: string;
  bedsPerRoom: string;
  vacantBeds: string;
  monthlyRent: string;
  securityDeposit: string;
  mealInclusion: "Included" | "Not Included" | "Optional";
};
const newRoom = (): Room => ({
  id: crypto.randomUUID(),
  roomType: "Single Room",
  rooms: "",
  bedsPerRoom: "1",
  vacantBeds: "",
  monthlyRent: "",
  securityDeposit: "",
  mealInclusion: "Included",
});
const optionalNumber = (value: string) => (value.trim() ? Number(value) : undefined);

function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block text-sm font-medium text-foreground">
      {label}
      {props.required ? <span className="text-brand-teal"> *</span> : null}
      <input {...props} className={FIELD} />
    </label>
  );
}

export function BranchForm({
  main,
  onCancel,
  onFiled,
}: {
  main: { name: string; panNumber: string | null };
  onCancel: () => void;
  onFiled: () => void;
}) {
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [details, setDetails] = useState({
    name: main.name,
    phone: "",
    alternatePhone: "",
    email: "",
    description: "",
    yearEstablished: "",
    area: "",
    city: "Kathmandu",
    province: "",
    address: "",
    landmark: "",
    mapLink: "",
    totalFloors: "",
    totalCapacity: "",
    admissionFee: "",
    formFee: "",
    securityDeposit: "",
    cookCount: "",
    mealsPerDay: "3",
    rules: "",
    panNumber: "",
  });
  const [hostelType, setHostelType] = useState<"BOYS" | "GIRLS" | "CO_LIVING">("CO_LIVING");
  const [location, setLocation] = useState<LocationPickerValue>({
    coordinates: null,
    source: "GEOCODED",
  });
  const [rooms, setRooms] = useState<Room[]>([]);
  const [facilities, setFacilities] = useState<string[]>([]);
  const [foodAvailability, setFoodAvailability] = useState("included");
  const [hasVeg, setHasVeg] = useState(true);
  const [hasNonVeg, setHasNonVeg] = useState(true);
  const [shortStays, setShortStays] = useState(EMPTY_SHORT_STAYS);
  const [reuseDocuments, setReuseDocuments] = useState(true);
  const [files, setFiles] = useState<Record<string, UploadedFile[]>>({});
  const [uploading, setUploading] = useState(false);
  const [payout, setPayout] = useState(EMPTY_PAYOUT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const set = (key: keyof typeof details, value: string) =>
    setDetails((current) => ({ ...current, [key]: value }));
  const beds = rooms.reduce(
    (sum, room) => sum + Number(room.rooms) * Number(room.bedsPerRoom),
    0,
  );
  const roomCount = rooms.reduce((sum, room) => sum + Number(room.rooms), 0);
  const vacant = rooms.reduce((sum, room) => sum + Number(room.vacantBeds), 0);

  function move(next: number) {
    setError("");
    setStep(next);
    requestAnimationFrame(() => {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  function payload() {
    const rents = rooms
      .map((room) => optionalNumber(room.monthlyRent))
      .filter((rent): rent is number => rent !== undefined);
    return {
      name: details.name.trim(),
      hostelType,
      contact: { phone: details.phone.trim(), email: details.email.trim() || undefined },
      alternatePhone: details.alternatePhone.trim() || undefined,
      description: details.description.trim() || undefined,
      yearEstablished: details.yearEstablished.trim() || undefined,
      location: {
        area: details.area.trim(),
        city: details.city.trim(),
        address: details.address.trim() || undefined,
        province: details.province.trim() || undefined,
        ...(location.coordinates
          ? { ...location.coordinates, locationSource: location.source }
          : {}),
      },
      landmark: details.landmark.trim() || undefined,
      mapLink: details.mapLink.trim() || undefined,
      totalFloors: optionalNumber(details.totalFloors),
      totalCapacity: rooms.length ? beds : optionalNumber(details.totalCapacity),
      capacitySummary: rooms.length
        ? { totalBeds: beds, totalRooms: roomCount, vacantBeds: vacant }
        : { totalBeds: optionalNumber(details.totalCapacity) },
      roomConfigurations: rooms.map((room) => ({
        roomType: room.roomType,
        rooms: Number(room.rooms),
        bedsPerRoom: Number(room.bedsPerRoom),
        vacantBeds: Number(room.vacantBeds),
        monthlyRent: optionalNumber(room.monthlyRent),
        securityDeposit:
          optionalNumber(room.securityDeposit) ?? optionalNumber(details.securityDeposit),
        mealInclusion: room.mealInclusion,
      })),
      securityDeposit: optionalNumber(details.securityDeposit),
      roomTypes: rooms.map((room) => room.roomType),
      pricing: {
        currency: "NPR",
        admissionFee: optionalNumber(details.admissionFee),
        formFee: optionalNumber(details.formFee),
        monthlyRentMin: rents.length ? Math.min(...rents) : undefined,
        monthlyRentMax: rents.length ? Math.max(...rents) : undefined,
      },
      facilities,
      food: {
        hasVeg: foodAvailability !== "none" && hasVeg,
        hasNonVeg: foodAvailability !== "none" && hasNonVeg,
        mealsPerDay:
          foodAvailability === "none" ? 0 : optionalNumber(details.mealsPerDay),
        notes:
          foodAvailability === "extra" ? "Meals available at extra charge" : undefined,
      },
      cookCount: optionalNumber(details.cookCount),
      rules: details.rules
        .split(/\r?\n/)
        .map((rule) => rule.trim())
        .filter(Boolean),
      photos: ["EXTERIOR", "INTERIOR"].flatMap((kind) =>
        (files[kind] ?? []).map((file) => ({ kind, url: file.url })),
      ),
      documents: Object.entries(files)
        .filter(([kind]) => !["EXTERIOR", "INTERIOR"].includes(kind))
        .flatMap(([kind, uploaded]) => submittedDocuments(kind, uploaded)),
      reuseDocuments,
      panNumber: reuseDocuments ? undefined : details.panNumber.trim() || undefined,
      payoutAccount: payoutAccountPayload(payout),
      shortStays: shortStaysPayload(shortStays, rooms),
      notes: details.cookCount ? `Cooks: ${details.cookCount}` : undefined,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || uploading) return;
    const parsed = branchRequestSchema.safeParse(payload());
    const stepFor = (field: string) =>
      ["location", "landmark", "mapLink"].includes(field)
        ? 1
        : [
              "roomConfigurations",
              "totalCapacity",
              "totalFloors",
              "pricing",
              "shortStays",
              "capacitySummary",
            ].includes(field)
          ? 2
          : ["food", "cookCount", "facilities", "rules", "photos"].includes(field)
            ? 3
            : ["panNumber", "payoutAccount", "documents"].includes(field)
              ? 4
              : 0;
    const issue = !parsed.success
      ? parsed.error.issues.find((item) => stepFor(String(item.path[0])) <= step)
      : undefined;
    if (issue) {
      setStep(stepFor(String(issue.path[0])));
      const row =
        issue.path[0] === "roomConfigurations" ? Number(issue.path[1]) : undefined;
      const labels: Record<string, string> = {
        rooms: "Number of rooms",
        bedsPerRoom: "Beds per room",
        vacantBeds: "Vacant beds",
        monthlyRent: "Monthly rent",
        securityDeposit: "Security deposit",
        phone: "Phone",
        totalCapacity: "Total capacity",
        totalFloors: "Total floors",
        roomType: "Room type",
      };
      const field = String(issue.path.at(-1));
      setError(
        `${row !== undefined ? `Room type ${row + 1} (${rooms[row]?.roomType}): ` : ""}${labels[field] ?? field}: ${issue.message}`,
      );
      requestAnimationFrame(() =>
        document
          .getElementById("branch-form-error")
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
      return;
    }
    if (step < 4) {
      move(step + 1);
      return;
    }
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (!confirmed) {
      setError("Confirm the branch details before submitting.");
      return;
    }
    if (
      (payout.holderName.trim() || payout.bankName.trim() || payout.branch.trim()) &&
      !payout.number.trim()
    ) {
      setError(
        "Enter an account number, or clear the payment details to add them later.",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      await browserApi("/api/v1/hostel-admin/branches", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      toast.success({
        title: `${details.name} sent for approval`,
        description: "We will call this branch before it goes live.",
      });
      onFiled();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not submit the branch. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function upload(kind: string, selected: File[]) {
    if (uploading) return;
    const photo = ["EXTERIOR", "INTERIOR"].includes(kind);
    const available = (photo ? 10 : 1) - (files[kind]?.length ?? 0);
    setUploading(true);
    setError("");
    try {
      for (const file of selected.slice(0, available)) {
        let result: UploadedFile;
        if (photo) {
          const uploaded = await uploadFile(file, {
            kind: "image",
            label: "Branch photo",
            target: "public",
            visibility: "public",
            silent: true,
          });
          if (!uploaded?.url) throw new Error("Photo upload failed. Please retry.");
          result = { id: crypto.randomUUID(), name: file.name, url: uploaded.url };
        } else {
          const uploaded = await uploadRegistrationDocument(file, kind);
          result = { ...uploaded, id: crypto.randomUUID(), name: file.name, url: "" };
        }
        setFiles((current) => ({
          ...current,
          [kind]: [...(current[kind] ?? []), result],
        }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function uploader(kind: string, photo = false) {
    return (
      <FileUploadArea
        files={files[kind] ?? []}
        label={photo ? "Add branch photos" : "Upload document"}
        accept={acceptAttribute(photo ? "image" : "document")}
        maxFiles={photo ? 10 : 1}
        onFileSelect={async (event) => {
          const selected = Array.from(event.target.files ?? []);
          event.target.value = "";
          await upload(kind, selected);
        }}
        onFilesDropped={(selected) => upload(kind, selected)}
        onRemove={(id) =>
          setFiles((current) => ({
            ...current,
            [kind]: current[kind].filter((file) => file.id !== id),
          }))
        }
      />
    );
  }

  const Icon = STEPS[step].icon;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="border-b border-border bg-brand-teal/5 p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand-teal">
              A new place. The same family.
            </p>
            <h2 className="mt-2 text-2xl font-bold text-foreground">
              Set up your new branch
            </h2>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-background px-3 py-2 text-xs font-semibold text-brand-teal">
            <ShieldCheck className="size-4" /> Owner account ready
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Each branch is a complete hostel with its own location, residents and daily
          operations. Your name, owner account and plan come with you.
        </p>
        <div className="mt-5 flex justify-between text-xs font-semibold text-muted-foreground">
          <span>
            Step {step + 1} of {STEPS.length}
          </span>
          <span>{step === 4 ? "Almost there!" : `${step} steps completed`}</span>
        </div>
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-brand-teal/10"
          role="progressbar"
          aria-label="Branch setup progress"
          aria-valuemin={0}
          aria-valuemax={5}
          aria-valuenow={step}
        >
          <div
            className="h-full rounded-full bg-brand-teal transition-all duration-300 motion-reduce:transition-none"
            style={{ width: `${(step / 5) * 100}%` }}
          />
        </div>
      </div>
      <div className="grid min-w-0 items-start gap-6 p-4 sm:p-6 lg:grid-cols-[180px_minmax(0,1fr)]">
        <StepRail
          currentStep={step + 1}
          steps={STEPS.map((item, index) => ({
            key: index + 1,
            label: item.title,
            description: item.hint,
          }))}
          stepComplete={(key) => key <= step}
          onStepSelect={(key) => {
            if (!saving && !uploading && key <= step + 1) move(key - 1);
          }}
        />
        <StepFlow className="min-w-0" stepKey={step}>
          <form onSubmit={submit} className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6">
            <div className="mb-6 flex items-center gap-3">
              <span className="rounded-xl bg-brand-teal/10 p-3 text-brand-teal">
                <Icon className="size-5" />
              </span>
              <div>
                <h3
                  ref={heading}
                  tabIndex={-1}
                  className="scroll-mt-24 text-lg font-bold text-foreground outline-none"
                >
                  {STEPS[step].title}
                </h3>
                <p className="text-sm text-muted-foreground">{STEPS[step].hint}</p>
              </div>
            </div>
            <fieldset disabled={saving || uploading} className="min-w-0 space-y-5">
              {step === 0 && (
                <>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field
                      label="Hostel name"
                      required
                      minLength={2}
                      maxLength={160}
                      value={details.name}
                      onChange={(e) => set("name", e.target.value)}
                    />
                    <Field
                      label="Branch phone"
                      required
                      type="tel"
                      minLength={7}
                      maxLength={24}
                      value={details.phone}
                      onChange={(e) => set("phone", e.target.value)}
                    />
                    <Field
                      label="Alternate phone (optional)"
                      type="tel"
                      value={details.alternatePhone}
                      onChange={(e) => set("alternatePhone", e.target.value)}
                    />
                    <Field
                      label="Contact email (optional)"
                      type="email"
                      value={details.email}
                      onChange={(e) => set("email", e.target.value)}
                    />
                    <Field
                      label="Year established (optional)"
                      placeholder="e.g. 2026"
                      pattern="[0-9]{4}"
                      maxLength={4}
                      value={details.yearEstablished}
                      onChange={(e) => set("yearEstablished", e.target.value)}
                    />
                  </div>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium">
                      Who is this hostel for?
                    </legend>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        ["BOYS", "Boys"],
                        ["GIRLS", "Girls"],
                        ["CO_LIVING", "Co-living"],
                      ].map(([value, label]) => (
                        <label
                          key={value}
                          className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl border p-4 text-sm font-semibold ${hostelType === value ? "border-brand-teal bg-brand-teal/5 text-brand-teal" : "border-border"}`}
                        >
                          <input
                            type="radio"
                            name="hostelType"
                            checked={hostelType === value}
                            onChange={() => setHostelType(value as typeof hostelType)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="block text-sm font-medium">
                    About this branch (optional)
                    <textarea
                      rows={3}
                      maxLength={2000}
                      className={`${FIELD} h-auto min-h-32 resize-y py-3`}
                      placeholder="Tell future residents about the space, neighbourhood and atmosphere."
                      value={details.description}
                      onChange={(e) => set("description", e.target.value)}
                    />
                  </label>
                  <DescriptionSuggestions
                    facts={{ hostelName: details.name, hostelType, area: details.area, city: details.city, yearEstablished: details.yearEstablished }}
                    value={details.description}
                    onChange={(description) => set("description", description)}
                  />
                </>
              )}
              {step === 1 && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Area / neighbourhood"
                      required
                      minLength={2}
                      maxLength={120}
                      value={details.area}
                      onChange={(e) => set("area", e.target.value)}
                    />
                    <Field
                      label="City"
                      required
                      list="branch-cities"
                      minLength={2}
                      maxLength={120}
                      value={details.city}
                      onChange={(e) => set("city", e.target.value)}
                    />
                    <datalist id="branch-cities">
                      {cityOptions.map((city) => (
                        <option key={city} value={city} />
                      ))}
                    </datalist>
                    <Field
                      label="Street address"
                      maxLength={240}
                      value={details.address}
                      onChange={(e) => set("address", e.target.value)}
                    />
                    <Field
                      label="Nearby landmark"
                      maxLength={240}
                      value={details.landmark}
                      onChange={(e) => set("landmark", e.target.value)}
                    />
                    <Field
                      label="Province (optional)"
                      maxLength={120}
                      value={details.province}
                      onChange={(e) => set("province", e.target.value)}
                    />
                    <Field
                      label="Google Maps link (optional)"
                      maxLength={500}
                      value={details.mapLink}
                      onChange={(e) => set("mapLink", e.target.value)}
                    />
                  </div>
                  <div className="rounded-xl border border-border p-4">
                    <p className="mb-3 text-sm text-muted-foreground">
                      Search for this branch, use your current location, or drag the pin
                      to its entrance.
                    </p>
                    <LocationPicker
                      addressHint={[details.address, details.area, details.city, "Nepal"]
                        .filter(Boolean)
                        .join(", ")}
                      initialQuery={details.mapLink || undefined}
                      value={location}
                      onChange={setLocation}
                      onResolvedAddress={(parts) =>
                        setDetails((current) => ({
                          ...current,
                          address: parts.address || current.address,
                          area: parts.area || current.area,
                          city: parts.city || current.city,
                          province: parts.province || current.province,
                        }))
                      }
                    />
                  </div>
                </>
              )}
              {step === 2 && (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field
                      label="Total floors"
                      required
                      type="number"
                      min={0}
                      max={50}
                      value={details.totalFloors}
                      onChange={(e) => set("totalFloors", e.target.value)}
                    />
                    <Field
                      label="Total capacity (beds)"
                      required
                      type="number"
                      min={1}
                      max={10000}
                      readOnly={rooms.length > 0}
                      value={rooms.length ? beds : details.totalCapacity}
                      onChange={(e) => set("totalCapacity", e.target.value)}
                    />
                    <Field
                      label="Admission fee (NPR, optional)"
                      type="number"
                      min={0}
                      value={details.admissionFee}
                      onChange={(e) => set("admissionFee", e.target.value)}
                    />
                    <Field
                      label="Form fee (NPR, optional)"
                      type="number"
                      min={0}
                      value={details.formFee}
                      onChange={(e) => set("formFee", e.target.value)}
                    />
                  </div>
                  <p className="rounded-lg bg-brand-teal/5 p-3 text-sm text-brand-teal">
                    {roomCount} rooms × their beds per room = <strong>{beds} beds</strong>{" "}
                    · {vacant} vacant. Total capacity updates automatically as you edit
                    rooms.
                  </p>
                  <RegistrationRooms
                    rooms={rooms}
                    globalDeposit={details.securityDeposit}
                    onDepositChange={(value) => set("securityDeposit", value)}
                    updateRoom={(id, patch) =>
                      setRooms((current) =>
                        current.map((room) =>
                          room.id === id ? editRoomRow(room, patch) : room,
                        ),
                      )
                    }
                    onAdd={() => setRooms((current) => {
                      const roomType = nextAvailableRoomType(current.map((room) => room.roomType));
                      return roomType ? [...current, { ...newRoom(), roomType, bedsPerRoom: String(BEDS_BY_ROOM_TYPE[roomType] ?? "") }] : current;
                    })}
                    onRemove={(id) =>
                      setRooms((current) => current.filter((room) => room.id !== id))
                    }
                  />
                  <RegistrationShortStays
                    value={shortStays}
                    onChange={setShortStays}
                    rooms={rooms}
                  />
                </>
              )}
              {step === 3 && (
                <>
                  <fieldset>
                    <legend className="mb-3 text-sm font-semibold">
                      What is available at this branch?
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {facilityOptions.map((facility) => (
                        <label
                          key={facility}
                          className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition-colors ${facilities.includes(facility) ? "border-brand-teal bg-brand-teal/10 text-brand-teal" : "border-border"}`}
                        >
                          <input
                            type="checkbox"
                            checked={facilities.includes(facility)}
                            onChange={(e) =>
                              setFacilities((current) =>
                                e.target.checked
                                  ? [...current, facility]
                                  : current.filter((item) => item !== facility),
                              )
                            }
                          />
                          {facility}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <label className="text-sm font-medium">
                      Food availability
                      <select
                        className={FIELD}
                        value={foodAvailability}
                        onChange={(e) => setFoodAvailability(e.target.value)}
                      >
                        <option value="included">Included in rent</option>
                        <option value="extra">Available at extra charge</option>
                        <option value="none">No meals</option>
                      </select>
                    </label>
                    {foodAvailability !== "none" && (
                      <Field
                        label="Meals per day"
                        type="number"
                        min={0}
                        max={6}
                        value={details.mealsPerDay}
                        onChange={(e) => set("mealsPerDay", e.target.value)}
                      />
                    )}
                    <Field
                      label="Number of cooks (optional)"
                      type="number"
                      min={0}
                      max={100}
                      value={details.cookCount}
                      onChange={(e) => set("cookCount", e.target.value)}
                    />
                  </div>
                  {foodAvailability !== "none" && (
                    <div className="flex gap-6 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={hasVeg}
                          onChange={(e) => setHasVeg(e.target.checked)}
                        />
                        Vegetarian
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={hasNonVeg}
                          onChange={(e) => setHasNonVeg(e.target.checked)}
                        />
                        Non-vegetarian
                      </label>
                    </div>
                  )}
                  <label className="block text-sm font-medium">
                    House rules (optional, one per line)
                    <textarea
                      rows={4}
                      className={`${FIELD} h-auto min-h-32 resize-y py-3`}
                      value={details.rules}
                      onChange={(e) => set("rules", e.target.value)}
                      placeholder="Quiet hours, visitors, meal timings…"
                    />
                  </label>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <h4 className="mb-2 text-sm font-semibold">Exterior photos</h4>
                      {uploader("EXTERIOR", true)}
                    </div>
                    <div>
                      <h4 className="mb-2 text-sm font-semibold">
                        Rooms & interior photos
                      </h4>
                      {uploader("INTERIOR", true)}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Use photos of this location. You can add more photos after
                    registration.
                  </p>
                </>
              )}
              {step === 4 && (
                <>
                  <div className="rounded-xl border border-brand-teal/20 bg-brand-teal/5 p-5">
                    <h4 className="text-lg font-bold">{details.name}</h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {[details.address, details.area, details.city]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <span>
                        <strong className="block">{rooms.length ? beds : details.totalCapacity}</strong>Beds
                      </span>
                      <span>
                        <strong className="block">{details.totalFloors}</strong>Floors
                      </span>
                      <span>
                        <strong className="block">{roomCount || "Add later"}</strong>Rooms
                      </span>
                      <span>
                        <strong className="block">{facilities.length}</strong>Facilities
                      </span>
                    </div>
                    <p className="mt-4 text-sm">
                      We will call {details.phone} before this branch goes live.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      {STEPS.slice(0, 4).map((item, index) => (
                        <button
                          key={item.title}
                          type="button"
                          className="text-xs font-semibold text-brand-teal underline"
                          onClick={() => move(index)}
                        >
                          Edit {item.title.toLowerCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4 rounded-xl border border-border p-4">
                    <label className="flex items-start gap-3 text-sm font-semibold">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={reuseDocuments}
                        onChange={(e) => setReuseDocuments(e.target.checked)}
                      />
                      <span>
                        Use the same business documents
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          Reuse approved documents and PAN/VAT from {main.name}. Each
                          copied document will be reviewed for this location.
                        </span>
                      </span>
                    </label>
                    {reuseDocuments ? (
                      <p className="text-xs text-muted-foreground">
                        PAN/VAT: {main.panNumber ?? "Not added yet"}. Any missing or
                        location-specific proof can be added below or requested during
                        review.
                      </p>
                    ) : (
                      <Field
                        label="Branch PAN/VAT (optional)"
                        pattern="[0-9]{9}"
                        maxLength={9}
                        value={details.panNumber}
                        onChange={(e) => set("panNumber", e.target.value)}
                      />
                    )}
                    <details>
                      <summary className="cursor-pointer text-sm font-semibold text-brand-teal">
                        Add or replace documents (optional)
                      </summary>
                      <div className="mt-4 grid gap-5 sm:grid-cols-2">
                        {[
                          "Ownership proof",
                          "Owner ID proof",
                          "PAN / VAT document",
                          "Hostel license",
                          "Bank account details",
                          "Rules & policies",
                        ].map((kind) => (
                          <div key={kind}>
                            <h4 className="mb-2 text-sm font-medium">{kind}</h4>
                            {uploader(kind)}
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold">
                      Branch payout account (optional)
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Add the bank account or wallet that should receive this branch’s
                      payments. You can complete this later.
                    </p>
                    <PayoutAccountFields onChange={setPayout} value={payout} />
                  </div>
                  <label className="flex items-start gap-3 rounded-xl bg-muted/40 p-4 text-sm">
                    <input
                      type="checkbox"
                      required
                      className="mt-1"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I confirm these details and any reused documents apply to this branch.
                  </label>
                </>
              )}
            </fieldset>
            {uploading && (
              <p role="status" className="mt-4 text-sm text-brand-teal">
                Uploading your files…
              </p>
            )}
            {error && (
              <p
                id="branch-form-error"
                role="alert"
                className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-border pt-5">
              <button
                type="button"
                disabled={saving || uploading}
                onClick={onCancel}
                className="mr-auto rounded-xl px-3 py-2.5 text-sm text-muted-foreground"
              >
                Cancel
              </button>
              {step > 0 && (
                <button
                  type="button"
                  disabled={saving || uploading}
                  onClick={() => move(step - 1)}
                  className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-3 text-sm font-semibold"
                >
                  <ArrowLeft className="size-4" />
                  Back
                </button>
              )}
              <button
                type="submit"
                disabled={saving || uploading}
                className="inline-flex items-center gap-2 rounded-xl bg-brand-teal px-5 py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {saving
                  ? "Submitting…"
                  : step === 4
                    ? "Submit branch for review"
                    : "Continue"}
                {step === 4 ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <ArrowRight className="size-4" />
                )}
              </button>
            </div>
          </form>
        </StepFlow>
      </div>
    </section>
  );
}
