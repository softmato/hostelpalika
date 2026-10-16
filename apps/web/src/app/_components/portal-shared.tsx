"use client";

import { type IconComponent } from "@/components/icons";

import { currency, EmptyState, Panel } from "@/app/_components/shared-ui";

type LoadState = "idle" | "loading" | "ready" | "error";

type ServiceProvider = {
  area: string;
  availability: string;
  /** Every trade the provider works in; absent on pre-multi-trade records. */
  categories?: string[];
  /** Headline trade — always `categories[0]` where the list exists. */
  category: string;
  city?: string;
  createdAt?: string;
  description: string;
  email?: string;
  experience: string;
  fullName: string;
  id: string;
  phone: string;
  status: string;
};

type MaintenanceRequest = {
  category: string;
  comments?: Array<{ id: string; message: string }>;
  costNote: string;
  description: string;
  id: string;
  priority: string;
  providerId?: string;
  status: string;
  title: string;
};

type Referral = {
  converted?: boolean;
  id: string;
  name: string;
  phone: string;
  reward?: { amount: number; status: string } | null;
  status: string;
};

type ListingFlag = {
  hostelId: string;
  id: string;
  matchedHostelIds: string[];
  reason: string;
  riskLevel: string;
  signals: string[];
  status: string;
};

type ReportRecord = Record<string, unknown>;

function field(form: FormData, name: string) {
  const value = form.get(name);

  return typeof value === "string" ? value.trim() : "";
}

function optionalField(form: FormData, name: string) {
  const value = field(form, name);

  return value.length > 0 ? value : undefined;
}

function optionalNumber(form: FormData, name: string) {
  const value = field(form, name);

  return value ? Number(value) : 0;
}

function Message({ value }: { value: string }) {
  return value ? (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">{value}</div>
  ) : null;
}

function PageHeader({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: IconComponent;
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

function isCountMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "number")
  );
}

function ReportGrid({ report }: { report: ReportRecord | null }) {
  if (!report) {
    return <EmptyState label="Report data is not loaded." />;
  }

  return (
    <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
      {Object.entries(report).map(([key, value]) => (
        <Panel key={key}>
          <p className="text-xs font-semibold uppercase text-muted-foreground">
            {key.replace(/([A-Z])/g, " $1")}
          </p>
          {/* A breakdown ({ PAID: 3, UNPAID: 1 }) is a list, not a headline
              number — stringifying it renders a useless "{}". */}
          {isCountMap(value) ? (
            Object.keys(value).length === 0 ? (
              <p className="mt-2 text-2xl font-bold text-muted-foreground">—</p>
            ) : (
              <dl className="mt-2 grid gap-1">
                {Object.entries(value).map(([label, count]) => (
                  <div className="flex items-baseline justify-between gap-2" key={label}>
                    <dt className="truncate text-xs text-muted-foreground">
                      {label.replaceAll("_", " ")}
                    </dt>
                    <dd className="text-base font-bold text-foreground">
                      {count.toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
            )
          ) : (
            <p className="mt-2 break-words text-2xl font-bold text-foreground">
              {typeof value === "number"
                ? key.toLowerCase().includes("amount") ||
                  key.toLowerCase().includes("dues")
                  ? currency(value)
                  : value.toLocaleString()
                : value === null || value === undefined || value === ""
                  ? "—"
                  : String(value)}
            </p>
          )}
        </Panel>
      ))}
    </div>
  );
}

export type {
  LoadState,
  ServiceProvider,
  MaintenanceRequest,
  Referral,
  ListingFlag,
  ReportRecord,
};

export { field, optionalField, optionalNumber, Message, PageHeader, ReportGrid };
