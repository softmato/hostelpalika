"use client";

import {
  AlarmClock,
  Check,
  ChevronRight,
  Camera,
  Clock,
  FileText,
  Minus,
  Pencil,
  Plus,
  ReceiptText,
  ShoppingBasket,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";

import {
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
} from "@/app/_components/portal-dashboard-ui";
import { mediaUrl } from "@/app/_components/community-post-card";
import { currency, EmptyState, Input, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { useUploader } from "@/components/uploads";
import type { PortalTone } from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

/**
 * Late fine and khata on the web — the same three portals as the app.
 *
 * Owner/warden: the Late fine panel (on Fee Schedule) and the Khata screen.
 * Cook: the asks to give. Resident: their khata. Every screen is numbers, rows
 * and buttons; the explaining lives in `late-fine.service` and `khata.service`.
 */

const LATE_FINE_URL = "/api/v1/hostel-admin/finance/late-fine";
const ADMIN_KHATA_URL = "/api/v1/hostel-admin/finance/khata";
const COOK_KHATA_URL = "/api/v1/cook/khata";
const RESIDENT_KHATA_URL = "/api/v1/resident/finance/khata";

type LateFineMode = "PER_DAY_AMOUNT" | "PER_DAY_PERCENT";
type LateFine = { enabled: boolean; graceDays: number; mode: LateFineMode; rate: number };

type KhataItem = {
  active: boolean;
  id: string;
  imageAssetId?: string | null;
  name: string;
  price: number;
};
type KhataEntry = {
  amount: number;
  billed: boolean;
  createdAt: string;
  id: string;
  name: string;
  note: string | null;
  quantity: number;
  resident: { id: string; name: string; roomNumber: string | null } | null;
  status: "REQUESTED" | "GIVEN" | "DECLINED" | "CANCELLED";
};
type KhataOrders = { recent: KhataEntry[]; waiting: KhataEntry[] };
type KhataAccount = { id: string; name: string; roomNumber: string | null; unbilled: number };
type KhataOverview = KhataOrders & {
  accounts: KhataAccount[];
  items: KhataItem[];
  requests: KhataAccount[];
};
type KhataBill = { amount: number; invoiceId: string; items: number; label: string; paid: boolean };
type ResidentKhata = {
  bills?: KhataBill[];
  entries: KhataEntry[];
  items: KhataItem[];
  status: "NONE" | "REQUESTED" | "ACTIVE" | "DECLINED" | "CLOSED";
  unbilled: number;
};

export type BillLine = { amount: number; basis: string; description: string };

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", weekday: "long" });
}

function who(entry: KhataEntry) {
  const resident = entry.resident;

  return resident ? `${resident.name}${resident.roomNumber ? ` · Room ${resident.roomNumber}` : ""}` : "";
}

/** A pill-shaped choice — the web's version of the app's chips. */
function ChoiceChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold transition",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "inline-block size-5 rounded-full bg-white shadow transition",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------------------- */
/* Bill extras — the fine and khata on one bill                               */
/* ------------------------------------------------------------------------- */

/** "+ Rs 150 fine" / "+ Rs 240 khata" under a bill's amount, with an optional Waive. */
export function BillExtraTags({
  lines,
  onWaive,
}: {
  lines?: BillLine[] | null;
  onWaive?: () => void;
}) {
  const fine = lines?.find((line) => line.basis === "FINE");
  const khata = lines?.find((line) => line.basis === "KHATA");

  if (!fine && !khata) {
    return null;
  }

  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      {fine ? (
        <SoftBadge tone="amber">
          <span title={fine.description}>{`+ ${currency(fine.amount)} fine`}</span>
        </SoftBadge>
      ) : null}
      {fine && onWaive ? (
        <button
          className="text-[11px] font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={(event) => {
            // The row it sits in opens the resident's track sheet.
            event.stopPropagation();
            onWaive();
          }}
          type="button"
        >
          Waive
        </button>
      ) : null}
      {khata ? (
        <SoftBadge tone="purple">
          <span title={khata.description}>{`+ ${currency(khata.amount)} khata`}</span>
        </SoftBadge>
      ) : null}
    </span>
  );
}

/** The same lines spelled out — the resident's pay panel. */
export function BillExtraRows({ lines }: { lines?: BillLine[] | null }) {
  const extras = (lines ?? []).filter((line) => line.basis === "FINE" || line.basis === "KHATA");

  if (extras.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {extras.map((line) => {
        const fine = line.basis === "FINE";
        const Icon = fine ? AlarmClock : ReceiptText;

        return (
          <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5" key={line.basis}>
            <span
              className={cn(
                "flex size-9 items-center justify-center rounded-lg",
                fine ? "bg-amber-500/15 text-amber-600" : "bg-primary/10 text-primary",
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-foreground">{fine ? "Late fine" : "Khata"}</span>
              <span className="block truncate text-[11.5px] text-muted-foreground">
                {line.description.replace(/^(Late fine|Khata) — /, "")}
              </span>
            </span>
            <span className="text-[13px] font-semibold text-foreground">{currency(line.amount)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Late fine — owner/warden                                                   */
/* ------------------------------------------------------------------------- */

const QUICK = { PER_DAY_AMOUNT: [20, 50, 100], PER_DAY_PERCENT: [0.5, 1, 2] } as const;
const FREE_DAYS = [3, 5, 7, 10];

/** Sits on the Fee Schedule page, under the festival discounts. */
export function LateFinePanel() {
  const resource = usePortalResource<{ lateFine: LateFine }>(LATE_FINE_URL, {
    errorMessage: "Could not load the late fine.",
  });

  if (!resource.data) {
    return (
      <Panel title="Late fine">
        {resource.state === "error" ? <EmptyState label={resource.message || "Could not load."} /> : <LoadingRows />}
      </Panel>
    );
  }

  return <LateFineForm initial={resource.data.lateFine} onSaved={() => void resource.refreshAsync()} />;
}

function LateFineForm({ initial, onSaved }: { initial: LateFine; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<LateFineMode>(initial.mode);
  const [rate, setRate] = useState(initial.rate > 0 ? String(initial.rate) : "");
  const [graceDays, setGraceDays] = useState(initial.graceDays);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const rateNumber = Number(rate);
  const perDay = mode === "PER_DAY_AMOUNT" ? Math.round(rateNumber) : Math.round((8000 * rateNumber) / 100);

  async function save() {
    if (enabled && !(rateNumber > 0)) {
      setMessage(mode === "PER_DAY_AMOUNT" ? "Add the rupees a day." : "Add the percent a day.");
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      await browserApi(LATE_FINE_URL, {
        body: JSON.stringify({ enabled, graceDays, mode, rate: enabled ? rateNumber : initial.rate }),
        method: "PUT",
      });
      setMessage(enabled ? "Late fine is on." : "Late fine is off.");
      onSaved();
    } catch (error) {
      setMessage(errorText(error, "Could not save."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      action={
        <Switch checked={enabled} label="Charge a late fine" onChange={setEnabled} />
      }
      title="Late fine"
    >
      <div className="space-y-5">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlarmClock aria-hidden="true" className="size-4" />
          {enabled ? "Unpaid bills get a fine every day after the free days." : "Off — no fine for paying late."}
        </p>

        {enabled ? (
          <div className="grid gap-5 md:grid-cols-[1fr_1fr_minmax(0,280px)]">
            <div className="space-y-3">
              <p className="text-[11.5px] font-bold uppercase tracking-wide text-muted-foreground">Fine</p>
              <div className="flex gap-2">
                <ChoiceChip active={mode === "PER_DAY_AMOUNT"} onClick={() => { setMode("PER_DAY_AMOUNT"); setRate(""); }}>
                  Rs a day
                </ChoiceChip>
                <ChoiceChip active={mode === "PER_DAY_PERCENT"} onClick={() => { setMode("PER_DAY_PERCENT"); setRate(""); }}>
                  % a day
                </ChoiceChip>
              </div>
              <Input
                label={mode === "PER_DAY_AMOUNT" ? "Rupees a day" : "Percent of the bill a day"}
                min="0"
                name="rate"
                onChange={(event) => setRate(event.target.value)}
                step={mode === "PER_DAY_AMOUNT" ? "1" : "0.1"}
                type="number"
                value={rate}
              />
              <div className="flex flex-wrap gap-2">
                {QUICK[mode].map((value) => (
                  <ChoiceChip active={rate === String(value)} key={value} onClick={() => setRate(String(value))}>
                    {mode === "PER_DAY_AMOUNT" ? currency(value) : `${value}%`}
                  </ChoiceChip>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-[11.5px] font-bold uppercase tracking-wide text-muted-foreground">Free days</p>
              <div className="flex flex-wrap gap-2">
                {FREE_DAYS.map((days) => (
                  <ChoiceChip active={graceDays === days} key={days} onClick={() => setGraceDays(days)}>
                    {`${days} days`}
                  </ChoiceChip>
                ))}
              </div>
            </div>

            <dl className="grid gap-1.5 rounded-xl border border-border bg-muted/40 p-4 text-[13px]">
              <div className="flex justify-between"><dt className="text-muted-foreground">Bill</dt><dd className="font-semibold">{currency(8000)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Pay without fine</dt><dd className="font-semibold">{`Day 1 – ${graceDays}`}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Fine starts</dt><dd className="font-semibold">{`Day ${graceDays + 1}`}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Paid 3 days late</dt><dd className="font-semibold text-amber-600">{perDay > 0 ? `+ ${currency(perDay * 3)}` : "—"}</dd></div>
            </dl>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <RoleButton disabled={saving} onClick={() => void save()} tone="admin">
            {saving ? "Saving…" : "Save"}
          </RoleButton>
          {message ? <span className="text-[12.5px] text-muted-foreground">{message}</span> : null}
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */
/* Khata asks — cook and staff                                               */
/* ------------------------------------------------------------------------- */

function KhataAsksList({
  onChanged,
  orders,
  showRecent,
  tone,
}: {
  onChanged: () => void;
  orders: KhataOrders;
  showRecent: boolean;
  tone: PortalTone;
}) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function decide(entry: KhataEntry, action: "GIVE" | "DECLINE") {
    setBusy(entry.id + action);
    setMessage("");

    try {
      await browserApi(`${COOK_KHATA_URL}/${entry.id}`, { body: JSON.stringify({ action }), method: "POST" });
      setMessage(action === "GIVE" ? `${currency(entry.amount)} on ${entry.resident?.name ?? "their"} khata.` : "Marked not available.");
    } catch (error) {
      setMessage(errorText(error, "Could not save."));
    } finally {
      setBusy("");
      onChanged();
    }
  }

  return (
    <div className="space-y-5">
      <SectionCard icon={Clock} title={`Waiting · ${orders.waiting.length}`}>
        {message ? <p className="mb-3 text-[12.5px] text-muted-foreground">{message}</p> : null}
        {orders.waiting.length === 0 ? (
          <EmptyState label="Nothing waiting." />
        ) : (
          <ul className="divide-y divide-border">
            {orders.waiting.map((entry) => (
              <li className="flex flex-wrap items-center gap-3 py-3" key={entry.id}>
                <span className="flex size-10 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
                  <ShoppingBasket className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-foreground">{`${entry.name} ×${entry.quantity}`}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    {`${who(entry)} · ${time(entry.createdAt)}${entry.note ? ` · “${entry.note}”` : ""}`}
                  </span>
                </span>
                <span className="font-semibold text-foreground">{currency(entry.amount)}</span>
                <span className="flex gap-2">
                  <RoleButton disabled={Boolean(busy)} onClick={() => void decide(entry, "DECLINE")} tone={tone} variant="outline">
                    <X className="size-3.5" />
                    Not available
                  </RoleButton>
                  <RoleButton disabled={Boolean(busy)} onClick={() => void decide(entry, "GIVE")} tone={tone}>
                    <Check className="size-3.5" />
                    Give
                  </RoleButton>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {showRecent && orders.recent.length > 0 ? (
        <SectionCard title="Last 24 hours">
          <ul className="divide-y divide-border">
            {orders.recent.map((entry) => (
              <li className="flex items-center gap-3 py-2.5" key={entry.id}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{`${entry.name} ×${entry.quantity}`}</span>
                  <span className="block text-[12px] text-muted-foreground">{who(entry)}</span>
                </span>
                <SoftBadge tone={entry.status === "GIVEN" ? "green" : "slate"}>
                  {entry.status === "GIVEN" ? currency(entry.amount) : "Not available"}
                </SoftBadge>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

export function CookKhataPage() {
  const orders = usePortalResource<KhataOrders>(COOK_KHATA_URL, {
    errorMessage: "Khata asks could not be loaded.",
  });

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PortalPageHeader description="Residents' asks on khata. Give, or mark not available." title="Khata asks" />
      {!orders.data ? (
        orders.state === "error" ? <EmptyState label={orders.message || "Could not load."} /> : <LoadingRows />
      ) : (
        <KhataAsksList onChanged={orders.refresh} orders={orders.data} showRecent tone="admin" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Khata — owner/warden                                                       */
/* ------------------------------------------------------------------------- */

type ItemDraft = { id?: string; imageAssetId?: string | null; name: string; price: string };

export function HostelAdminKhataPageContent() {
  const khata = usePortalResource<KhataOverview>(ADMIN_KHATA_URL, {
    errorMessage: "Khata could not be loaded.",
  });
  const [draft, setDraft] = useState<ItemDraft>({ name: "", price: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // PUBLIC: residents see the photo on their item tiles.
  const photo = useUploader({ accessLevel: "PUBLIC", kind: "media", label: "Item photo", optimizeImage: true });

  async function pickPhoto(file: File | undefined) {
    const uploaded = file ? await photo.upload(file) : null;

    photo.clear();
    if (uploaded?.assetId) {
      setDraft((prev) => ({ ...prev, imageAssetId: uploaded.assetId }));
    }
  }

  const data = khata.data;
  const totalOnBills = useMemo(
    () => (data?.accounts ?? []).reduce((sum, row) => sum + row.unbilled, 0),
    [data],
  );

  async function saveItems(items: (Omit<KhataItem, "id"> & { id?: string })[], done: string) {
    setBusy(true);
    setMessage("");

    try {
      await browserApi(ADMIN_KHATA_URL, { body: JSON.stringify({ items }), method: "PUT" });
      setMessage(done);
      setDraft({ name: "", price: "" });
      await khata.refreshAsync();
    } catch (error) {
      setMessage(errorText(error, "Could not save."));
    } finally {
      setBusy(false);
    }
  }

  function submitItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const price = Number(draft.price);

    if (!data || !draft.name.trim() || !Number.isInteger(price) || price < 1) {
      setMessage("Add a name and a price in whole rupees.");
      return;
    }

    const item = { active: true, imageAssetId: draft.imageAssetId ?? null, name: draft.name.trim(), price };
    const items = draft.id
      ? data.items.map((row) =>
          row.id === draft.id ? { ...row, imageAssetId: item.imageAssetId, name: item.name, price } : row,
        )
      : [...data.items, item];

    void saveItems(items, draft.id ? "Item saved." : `${item.name} added.`);
  }

  async function decideAccount(row: KhataAccount, action: "APPROVE" | "DECLINE" | "CLOSE") {
    if (action === "CLOSE" && !window.confirm(`Close ${row.name}'s khata? What they already took stays on their next bill.`)) {
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      await browserApi(`${ADMIN_KHATA_URL}/residents/${row.id}`, { body: JSON.stringify({ action }), method: "POST" });
      setMessage(action === "APPROVE" ? `${row.name}'s khata is open.` : action === "CLOSE" ? "Khata closed." : "Request declined.");
      await khata.refreshAsync();
    } catch (error) {
      setMessage(errorText(error, "Could not save."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PortalPageHeader description="Residents take items now; it goes on next month's bill." title="Khata" />

      {!data ? (
        khata.state === "error" ? <EmptyState label={khata.message || "Could not load."} /> : <LoadingRows />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard icon={Clock} label="Waiting asks" tone="amber" value={data.waiting.length + data.requests.length} />
            <MetricCard icon={Users} label="Open khatas" tone="green" value={data.accounts.length} />
            <MetricCard icon={ReceiptText} label="On next bills" tone="purple" value={currency(totalOnBills)} />
          </div>

          {message ? <p className="text-[12.5px] text-muted-foreground">{message}</p> : null}

          {data.requests.length > 0 ? (
            <SectionCard icon={UserPlus} title={`Want a khata · ${data.requests.length}`}>
              <ul className="divide-y divide-border">
                {data.requests.map((row) => (
                  <li className="flex flex-wrap items-center gap-3 py-3" key={row.id}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-foreground">{row.name}</span>
                      {row.roomNumber ? <span className="block text-[12px] text-muted-foreground">{`Room ${row.roomNumber}`}</span> : null}
                    </span>
                    <RoleButton disabled={busy} onClick={() => void decideAccount(row, "DECLINE")} tone="admin" variant="outline">
                      Don&rsquo;t open
                    </RoleButton>
                    <RoleButton disabled={busy} onClick={() => void decideAccount(row, "APPROVE")} tone="admin">
                      Open khata
                    </RoleButton>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {data.waiting.length > 0 ? (
            <KhataAsksList onChanged={khata.refresh} orders={data} showRecent={false} tone="admin" />
          ) : null}

          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard icon={Users} title={`Open khatas · ${data.accounts.length}`}>
              {data.accounts.length === 0 ? (
                <EmptyState label="No open khatas. Residents ask from their app." />
              ) : (
                <ul className="divide-y divide-border">
                  {data.accounts.map((row) => (
                    <li className="flex items-center gap-3 py-2.5" key={row.id}>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-foreground">{row.name}</span>
                        {row.roomNumber ? <span className="block text-[12px] text-muted-foreground">{`Room ${row.roomNumber}`}</span> : null}
                      </span>
                      <span className="font-semibold text-foreground">{row.unbilled > 0 ? currency(row.unbilled) : "—"}</span>
                      <button
                        className="rounded-md px-2 py-1 text-[12px] font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                        disabled={busy}
                        onClick={() => void decideAccount(row, "CLOSE")}
                        type="button"
                      >
                        Close
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard icon={ShoppingBasket} title="Items">
              <form className="mb-4 grid grid-cols-[auto_1fr_120px_auto] items-end gap-2" onSubmit={submitItem}>
                <span className="relative">
                  <label
                    className="flex size-9 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted text-muted-foreground hover:text-foreground"
                    title={draft.imageAssetId ? "Change photo (optional)" : "Add a photo (optional)"}
                  >
                    {draft.imageAssetId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="" className="size-full object-cover" src={mediaUrl(draft.imageAssetId, "THUMBNAIL")} />
                    ) : (
                      <Camera className="size-4" />
                    )}
                    <input
                      accept="image/*"
                      className="sr-only"
                      disabled={photo.isUploading}
                      onChange={(event) => {
                        void pickPhoto(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                      type="file"
                    />
                  </label>
                  {draft.imageAssetId ? (
                    <button
                      aria-label="Remove photo"
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-card p-0.5 text-muted-foreground shadow hover:text-destructive"
                      onClick={() => setDraft((prev) => ({ ...prev, imageAssetId: null }))}
                      type="button"
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                </span>
                <Input
                  label={draft.id ? "Edit item" : "New item"}
                  name="name"
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Egg"
                  value={draft.name}
                />
                <Input
                  label="Price (Rs)"
                  min="1"
                  name="price"
                  onChange={(event) => setDraft((prev) => ({ ...prev, price: event.target.value.replace(/\D/g, "") }))}
                  type="number"
                  value={draft.price}
                />
                <span className="flex gap-1.5">
                  <RoleButton className="h-9" disabled={busy || photo.isUploading} tone="admin" type="submit">
                    {draft.id ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
                    {draft.id ? "Save" : "Add"}
                  </RoleButton>
                  {draft.id ? (
                    <RoleButton className="h-9" onClick={() => setDraft({ name: "", price: "" })} tone="admin" type="button" variant="outline">
                      Cancel
                    </RoleButton>
                  ) : null}
                </span>
              </form>

              {data.items.length === 0 ? (
                <EmptyState label="No items yet — egg, extra meal, laundry…" />
              ) : (
                <ul className="divide-y divide-border">
                  {data.items.map((item) => (
                    <li className="flex items-center gap-3 py-2.5" key={item.id}>
                      {item.imageAssetId ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img alt="" className="size-8 rounded-md object-cover" src={mediaUrl(item.imageAssetId, "THUMBNAIL")} />
                      ) : null}
                      <span className={cn("min-w-0 flex-1 font-medium", item.active ? "text-foreground" : "text-muted-foreground line-through")}>
                        {item.name}
                      </span>
                      <span className="font-semibold text-foreground">{currency(item.price)}</span>
                      <Switch
                        checked={item.active}
                        label={`Residents can ask for ${item.name}`}
                        onChange={(active) =>
                          void saveItems(
                            data.items.map((row) => (row.id === item.id ? { ...row, active } : row)),
                            active ? `${item.name} is on.` : `${item.name} is off.`,
                          )
                        }
                      />
                      <button
                        aria-label={`Edit ${item.name}`}
                        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        onClick={() => setDraft({ id: item.id, imageAssetId: item.imageAssetId, name: item.name, price: String(item.price) })}
                        type="button"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        aria-label={`Remove ${item.name}`}
                        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Remove ${item.name}? What was already taken stays on the bill.`)) {
                            void saveItems(data.items.filter((row) => row.id !== item.id), `${item.name} removed.`);
                          }
                        }}
                        type="button"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Khata — resident                                                           */
/* ------------------------------------------------------------------------- */

const STATUS: Record<KhataEntry["status"], { label: string; tone: "green" | "amber" | "slate" }> = {
  CANCELLED: { label: "Taken back", tone: "slate" },
  DECLINED: { label: "Not available", tone: "slate" },
  GIVEN: { label: "Given", tone: "green" },
  REQUESTED: { label: "Waiting", tone: "amber" },
};

export function ResidentKhataPage() {
  const khata = usePortalResource<ResidentKhata>(RESIDENT_KHATA_URL, {
    errorMessage: "Khata could not be loaded.",
  });
  const [asking, setAsking] = useState<KhataItem | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const days = useMemo(() => {
    const groups = new Map<string, KhataEntry[]>();

    for (const row of khata.data?.entries ?? []) {
      groups.set(day(row.createdAt), [...(groups.get(day(row.createdAt)) ?? []), row]);
    }

    return [...groups];
  }, [khata.data]);

  async function run(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage("");

    try {
      await browserApi(RESIDENT_KHATA_URL, { body: JSON.stringify(body), method: "POST" });
      setMessage(done);
      setAsking(null);
      await khata.refreshAsync();
    } catch (error) {
      setMessage(errorText(error, "Could not send."));
    } finally {
      setBusy(false);
    }
  }

  const data = khata.data;

  const tiles = (onPick?: (item: KhataItem) => void) => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {data?.items.map((item) => (
        <button
          className={cn(
            "flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left transition",
            asking?.id === item.id ? "border-primary ring-2 ring-primary/20" : "border-border",
            onPick ? "hover:border-primary/50" : "cursor-default",
          )}
          disabled={!onPick}
          key={item.id}
          onClick={() => {
            if (onPick) onPick(item);
          }}
          type="button"
        >
          {item.imageAssetId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="" className="size-9 rounded-lg object-cover" src={mediaUrl(item.imageAssetId, "THUMBNAIL")} />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShoppingBasket className="size-4" />
            </span>
          )}
          <span className="font-semibold text-foreground">{item.name}</span>
          <span className="text-[12.5px] text-muted-foreground">{currency(item.price)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PortalPageHeader description="Take now, pay with next month's rent." title="Khata" />

      {message ? <p className="text-[12.5px] text-muted-foreground">{message}</p> : null}

      {!data ? (
        khata.state === "error" ? <EmptyState label={khata.message || "Could not load."} /> : <LoadingRows />
      ) : data.status !== "ACTIVE" ? (
        <>
          <SectionCard>
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                {data.status === "REQUESTED" ? <Clock className="size-6" /> : <ReceiptText className="size-6" />}
              </span>
              <p className="font-heading text-lg font-bold text-foreground">
                {data.status === "REQUESTED" ? "Waiting for the warden" : "Your khata"}
              </p>
              <p className="text-sm text-muted-foreground">
                {data.status === "REQUESTED"
                  ? "You'll get a notification when it opens."
                  : data.items.length === 0
                    ? "Your hostel hasn't listed anything yet."
                    : data.status === "DECLINED"
                      ? "Not opened last time — you can ask again."
                      : "Egg, meals, laundry — on next month's bill."}
              </p>
              {data.status !== "REQUESTED" ? (
                <RoleButton
                  disabled={busy || data.items.length === 0}
                  onClick={() => void run({ action: "OPEN" }, "Asked the warden.")}
                  tone="resident"
                >
                  Open my khata
                </RoleButton>
              ) : null}
            </div>
          </SectionCard>
          {data.items.length > 0 ? <SectionCard title="On the list">{tiles()}</SectionCard> : null}
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard icon={ReceiptText} label="On next bill" tone="green" value={currency(data.unbilled)} />
            <MetricCard
              icon={Clock}
              label="Waiting"
              tone="amber"
              value={data.entries.filter((row) => row.status === "REQUESTED").length}
            />
            <MetricCard icon={FileText} label="Bills" tone="purple" value={data.bills?.length ?? 0} />
          </div>

          <SectionCard title="Ask for">
            {data.items.length === 0 ? (
              <EmptyState label="Nothing on the list right now." />
            ) : (
              <div className="space-y-4">
                {tiles((item) => {
                  setAsking(item);
                  setQuantity(1);
                  setNote("");
                })}
                {asking ? (
                  <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-muted/40 p-4">
                    <div>
                      <p className="mb-1.5 text-[12px] font-semibold text-muted-foreground">{asking.name}</p>
                      <div className="flex items-center gap-3">
                        <button
                          aria-label="Fewer"
                          className="flex size-9 items-center justify-center rounded-full border border-border bg-card disabled:opacity-40"
                          disabled={quantity <= 1}
                          onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                          type="button"
                        >
                          <Minus className="size-4" />
                        </button>
                        <span className="w-6 text-center font-heading text-xl font-bold">{quantity}</span>
                        <button
                          aria-label="More"
                          className="flex size-9 items-center justify-center rounded-full border border-border bg-card disabled:opacity-40"
                          disabled={quantity >= 20}
                          onClick={() => setQuantity((value) => Math.min(20, value + 1))}
                          type="button"
                        >
                          <Plus className="size-4" />
                        </button>
                      </div>
                    </div>
                    <div className="min-w-[200px] flex-1">
                      <Input
                        label="Note"
                        name="note"
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Boiled, after 7 pm…"
                        value={note}
                      />
                    </div>
                    <RoleButton
                      className="h-9"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          { action: "ASK", itemId: asking.id, note: note.trim() || undefined, quantity },
                          "Sent to the kitchen.",
                        )
                      }
                      tone="resident"
                    >
                      {`Ask · ${currency(asking.price * quantity)}`}
                    </RoleButton>
                  </div>
                ) : null}
              </div>
            )}
          </SectionCard>

          {data.bills && data.bills.length > 0 ? (
            <SectionCard icon={FileText} title="Bills">
              <ul className="divide-y divide-border">
                {data.bills.map((bill) => (
                  <li key={bill.invoiceId}>
                    <Link className="flex items-center gap-3 py-2.5 hover:opacity-80" href="/resident/payments">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-foreground">{bill.label}</span>
                        <span className="block text-[12px] text-muted-foreground">
                          {`${bill.items} ${bill.items === 1 ? "item" : "items"} · ${currency(bill.amount)}`}
                        </span>
                      </span>
                      <SoftBadge tone={bill.paid ? "green" : "amber"}>{bill.paid ? "Paid" : "Due"}</SoftBadge>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {days.map(([label, rows]) => (
            <section className="space-y-2" key={label}>
              <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-muted-foreground">{label}</h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-card px-4">
                {rows.map((row) => (
                  <li className="flex items-center gap-3 py-2.5" key={row.id}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">{`${row.name} ×${row.quantity}`}</span>
                      <span className="block text-[12px] text-muted-foreground">
                        {`${currency(row.amount)}${row.billed ? " · on bill" : ""}`}
                      </span>
                    </span>
                    <SoftBadge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</SoftBadge>
                    {row.status === "REQUESTED" ? (
                      <button
                        className="text-[12px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
                        disabled={busy}
                        onClick={() => void run({ action: "CANCEL", entryId: row.id }, "Taken back.")}
                        type="button"
                      >
                        Take back
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

/** The resident dashboard's khata card: three numbers and one link. */
export function ResidentKhataCard() {
  const khata = usePortalResource<ResidentKhata>(RESIDENT_KHATA_URL, {
    errorMessage: "Khata could not be loaded.",
  });
  const data = khata.data;

  if (!data || (data.status === "NONE" && data.items.length === 0)) {
    return null;
  }

  const stats: [string, string][] = [
    ["On next bill", currency(data.unbilled)],
    ["Waiting", String(data.entries.filter((row) => row.status === "REQUESTED").length)],
    ["Bills", String(data.bills?.length ?? 0)],
  ];

  return (
    <SectionCard>
      <Link className="block space-y-3" href="/resident/khata">
        <span className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ReceiptText className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-heading text-[15px] font-bold text-foreground">Khata</span>
            <span className="block text-[12px] text-muted-foreground">Egg, meals, laundry — on next month&rsquo;s bill</span>
          </span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </span>
        {data.status === "ACTIVE" ? (
          <span className="grid grid-cols-3 gap-2">
            {stats.map(([label, value]) => (
              <span className="rounded-xl bg-muted/60 px-3 py-2" key={label}>
                <span className="block text-[14px] font-bold text-foreground">{value}</span>
                <span className="block text-[11px] text-muted-foreground">{label}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="block rounded-lg bg-primary/10 px-3 py-2 text-center text-[12.5px] font-semibold text-primary">
            {data.status === "REQUESTED" ? "Waiting for the warden" : "Open my khata"}
          </span>
        )}
      </Link>
    </SectionCard>
  );
}
