"use client";

import { type LucideIcon } from "lucide-react";

import { currency, EmptyState, Panel, StatusBadge } from "@/app/_components/shared-ui";

export type LoadState = "idle" | "loading" | "ready" | "error";
export type ReportRecord = Record<string, unknown>;

export type Hostel = {
  /** `HH-3F9A1C2E` — only on the hostel's own profile read. */
  hostelCode?: string;
  /** Present on the platform approval queue — see listPlatformHostels. */
  applicationStatus?: string;
  /** The business's PAN/VAT number, when one was given. */
  panNumber?: string | null;
  /** Set on a branch: the main hostel whose plan it runs on. */
  parentHostelId?: string | null;
  /** On the platform queue, a branch's main hostel — see listPlatformHostels. */
  branchOf?: { id: string; name: string; panNumber: string | null; slug: string } | null;
  /** The plan suspension running on this hostel, if any — see `hostel-suspension.ts`. */
  suspension?: {
    graceEndsAt: string;
    reason: string;
    stage: "PRE_SUSPENSION" | "SUSPENDED";
    startedAt: string;
  } | null;
  capacitySummary?: {
    totalBeds?: number;
    totalRooms?: number;
    vacantBeds?: number;
  };
  createdAt?: string;
  owner?: {
    email: string;
    name: string;
    phone: string;
  } | null;
  submittedAt?: string | null;
  contact?: {
    email?: string;
    phone?: string;
  };
  demoDataLabel?: string;
  description?: string;
  facilities: string[];
  food?: {
    hasNonVeg?: boolean;
    hasVeg?: boolean;
    mealsPerDay?: number;
    notes?: string;
  };
  hostelType: "BOYS" | "GIRLS" | "CO_LIVING";
  id: string;
  /** Archive state — only ever populated on the platform's own reads. */
  archivedAt?: string | null;
  archiveReason?: string;
  isArchived?: boolean;
  purgeScheduledAt?: string | null;
  isDemoData?: boolean;
  location: {
    address?: string;
    area: string;
    city?: string;
    lat?: number;
    lng?: number;
    /** MANUAL once an admin has dropped the pin themselves. */
    locationSource?: "MANUAL" | "GEOCODED";
    province?: string;
  };
  name: string;
  nameChangeCount?: number;
  ownerId: string;
  photos: Array<{
    alt?: string;
    id?: string;
    kind?: "EXTERIOR" | "INTERIOR" | "ROOM";
    /** Set only on ROOM photos — matches roomConfigurations[].roomType. */
    roomType?: string;
    url?: string;
  }>;
  pricing?: {
    monthlyRentMax?: number;
    monthlyRentMin?: number;
  };
  roomTypes: string[];
  rules: string[];
  slug: string;
  status: string;
  /** Descriptive building detail — rooms are not grouped by floor. */
  totalFloors?: number;
  verificationStatus: string;
};

export type UserRecord = {
  createdAt?: string;
  demoDataLabel?: string;
  email?: string;
  hostelIds: string[];
  id: string;
  isDemoData?: boolean;
  lastLoginAt?: string;
  name: string;
  phone?: string;
  role: string;
  status: string;
};

export type Inquiry = {
  budgetRange?: string;
  createdAt?: string;
  email?: string;
  gender?: string;
  id: string;
  message?: string;
  name: string;
  phone: string;
  preferredRoomType?: string;
  preferredVisitDate?: string;
  status: string;
};

export type RoomConfiguration = {
  bedsPerRoom: number;
  id?: string;
  mealInclusion?: string;
  monthlyRent: number;
  rooms: number;
  roomType: string;
  vacantBeds: number;
};

export function field(form: FormData, name: string) {
  const value = form.get(name);

  return typeof value === "string" ? value.trim() : "";
}

export function optionalField(form: FormData, name: string) {
  const value = field(form, name);

  return value.length > 0 ? value : undefined;
}

export function csvField(form: FormData, name: string) {
  return field(form, name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function numberField(form: FormData, name: string) {
  const value = Number(field(form, name));

  return Number.isFinite(value) ? value : 0;
}

export function Message({ value }: { value: string }) {
  return value ? (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">{value}</div>
  ) : null;
}

export function DemoDataBadge({ label }: { label?: string }) {
  return (
    <span
      className="inline-flex w-fit items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-700"
      title={label || "Seeded demo/test data"}
    >
      Mock/Test data
    </span>
  );
}

export function PageHeader({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="rounded-lg bg-muted p-3 text-foreground">
        <Icon className="size-5" />
      </span>
      <div>
        <h1 className="font-heading text-3xl font-bold text-foreground">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function ReportGrid({ report }: { report: ReportRecord | null }) {
  if (!report) {
    return <EmptyState label="Report data is not loaded." />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Object.entries(report).map(([key, value]) => (
        <Panel key={key}>
          <p className="text-xs font-semibold uppercase text-muted-foreground">
            {key.replace(/([A-Z])/g, " $1")}
          </p>
          <p className="mt-2 text-2xl font-bold text-foreground">
            {typeof value === "number"
              ? key.toLowerCase().includes("amount") || key.toLowerCase().includes("due")
                ? currency(value)
                : value.toLocaleString()
              : typeof value === "string"
                ? value
                : JSON.stringify(value)}
          </p>
        </Panel>
      ))}
    </div>
  );
}

export function HostelTable({
  hostels,
  onAction,
}: {
  hostels: Hostel[];
  onAction?: (hostelId: string, action: string) => void;
}) {
  if (hostels.length === 0) {
    return <EmptyState label="No hostels found." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">Hostel</th>
            <th>Location</th>
            <th>Rent</th>
            <th>Status</th>
            <th>Verification</th>
            {onAction ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {hostels.map((hostel) => (
            <tr key={hostel.id}>
              <td className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-foreground">{hostel.name}</p>
                  {hostel.isDemoData ? (
                    <DemoDataBadge label={hostel.demoDataLabel} />
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{hostel.slug}</p>
              </td>
              <td>
                {hostel.location.area}, {hostel.location.city ?? "Kathmandu"}
              </td>
              <td>
                {hostel.pricing?.monthlyRentMin
                  ? currency(hostel.pricing.monthlyRentMin)
                  : "-"}
              </td>
              <td>
                <StatusBadge>{hostel.status}</StatusBadge>
              </td>
              <td>
                <StatusBadge>{hostel.verificationStatus}</StatusBadge>
              </td>
              {onAction ? (
                <td>
                  <div className="flex flex-wrap gap-2">
                    {[
                      "approve",
                      "reject",
                      "request-documents",
                      "publish",
                      "unpublish",
                    ].map((action) => (
                      <button
                        className="rounded-md border border-border px-2 py-1 text-xs font-semibold text-foreground"
                        key={action}
                        onClick={() => onAction(hostel.id, action)}
                        type="button"
                      >
                        {action}
                      </button>
                    ))}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
