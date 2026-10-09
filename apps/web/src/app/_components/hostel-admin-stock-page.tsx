"use client";

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Package,
  PackagePlus,
  Plus,
  Send,
  Store,
  Trash2,
  Truck,
  Users,
  UtensilsCrossed,
  Wallet,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { addBsMonths, formatBsDate, formatBsPeriod } from "@/lib/hostel-day";
import { usePortalResource } from "@/lib/portal-query";
import { uploadFile } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";
import {
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  type ExpensePaidBy,
} from "@hostel/shared/expenses/categories";
import { parseAmountInput, parseBsDayInput, toBsDayInput, todayKey } from "@hostel/shared/expenses/input";
import {
  formatPackQty,
  formatQty,
  STOCK_BILL_STATUS_LABELS,
  STOCK_ENTRY_LABELS,
  STOCK_ITEM_NAME_MAX,
  STOCK_UNIT_LABELS,
  STOCK_UNITS,
  STOCK_USE_FOR,
  STOCK_USE_FOR_LABELS,
  STOCK_WASTE_LABELS,
  STOCK_WASTE_REASONS,
  type StockEntryKind,
  type StockKind,
  type StockUnit,
  type StockUseFor,
  type StockWasteReason,
} from "@hostel/shared/expenses/stock";

import type { StockEntryRow, StockHome, StockItemRow } from "@/modules/stock/stock.service";

import { EmptyState, LoadingRows, currency } from "./shared-ui";
import { MetricCard, PortalPageHeader, SectionCard } from "./portal-dashboard-ui";

/**
 * Stock on the web (docs/INVENTORY_PLAN.md) — the owner's desk view of the
 * app's Stock screen. Same API, so a warden here sees only their own building.
 *
 * Every movement — Bought, Used, Wasted, Send, Count, Opening — shares one
 * dialog: pick the building, write a number beside each item that moved, save.
 * A Bought is a bill: supplier, prices, what was paid; the rest is owed to the
 * supplier and shows under Suppliers. Dates are Bikram Sambat.
 */

const ENDPOINT = "/api/v1/hostel-admin/stock";

const KIND_LABEL: Record<StockEntryKind, string> = STOCK_ENTRY_LABELS;

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function newRequestId() {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function placeName(home: StockHome, id: string | null) {
  return home.places.find((place) => place.id === id)?.name ?? "Hostel";
}

function summary(entry: StockEntryRow) {
  if (entry.kind === "COUNT") {
    return entry.lines
      .map((line) => {
        const gap = line.systemQty === null ? 0 : line.qty - line.systemQty;

        return gap === 0
          ? `${line.name} ${formatQty(line.qty, line.unit)}`
          : `${line.name} ${formatQty(Math.abs(gap), line.unit)} ${gap < 0 ? "missing" : "extra"}`;
      })
      .join(", ");
  }

  return entry.lines.map((line) => `${line.name} ${formatPackQty(line.qty, line.unit, line)}`).join(", ");
}

function entryTitle(entry: StockEntryRow) {
  if (entry.kind === "SEND") return `${entry.hostelName} → ${entry.toHostelName ?? ""}`;
  if (entry.kind === "BUY" && entry.supplier) {
    return `Bought · ${entry.supplier}${entry.bill?.billNo ? ` · bill ${entry.bill.billNo}` : ""}`;
  }
  if (entry.kind === "USE" && entry.useFor) return `Used · ${STOCK_USE_FOR_LABELS[entry.useFor]} · ${entry.hostelName}`;
  if (entry.kind === "WASTE" && entry.wasteReason) {
    return `Wasted · ${STOCK_WASTE_LABELS[entry.wasteReason]} · ${entry.hostelName}`;
  }

  return `${KIND_LABEL[entry.kind]} · ${entry.hostelName}`;
}

/** The items table as a CSV download — opens in Excel or Sheets. */
function downloadCsv(home: StockHome) {
  const rows = [
    ["Item", "Category", "Unit", "Opening", "In", "Used", "Wasted", "Sent", "Count +/-", "Closing", "Avg cost", "Value now"],
    ...home.items
      .filter((item) => item.active && item.kind === "STORE")
      .map((item) => {
        const sum = (pick: (at: StockItemRow["at"][number]) => number) => item.at.reduce((total, at) => total + pick(at), 0);

        return [
          item.name,
          item.category,
          item.unit.toLowerCase(),
          sum((at) => at.opening),
          sum((at) => at.in),
          sum((at) => at.used),
          sum((at) => at.wasted),
          sum((at) => at.out),
          sum((at) => at.adjusted),
          sum((at) => at.closing),
          item.avgCost ?? "",
          item.value ?? "",
        ].map(String);
      }),
  ];
  const csv = rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n");
  const link = document.createElement("a");

  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `stock-${home.period}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function shortText(entry: StockEntryRow) {
  return entry.lines
    .filter((line) => line.receivedQty !== null && line.receivedQty < line.qty)
    .map((line) => `${line.name} ${formatQty(line.qty - (line.receivedQty ?? 0), line.unit)} short`)
    .join(", ");
}

function StatusPill({ entry }: { entry: StockEntryRow }) {
  const [label, tone] =
    entry.status === "CANCELLED"
      ? ["Cancelled", "bg-muted text-muted-foreground"]
      : entry.status === "PENDING"
        ? [
            entry.kind === "COUNT" ? "To approve" : "On the way",
            "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
          ]
        : entry.bill?.status === "DUE" || entry.bill?.status === "PARTIAL"
          ? [STOCK_BILL_STATUS_LABELS[entry.bill.status], "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"]
        : entry.kind === "SEND"
          ? shortText(entry)
            ? ["Short", "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"]
            : ["Got it", "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"]
          : [null, ""];

  return label ? <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", tone)}>{label}</span> : null;
}

export const HostelAdminStockPageContent = memo(function HostelAdminStockPageContent() {
  const [period, setPeriod] = useState<string | null>(null);
  const url = period ? `${ENDPOINT}?period=${period}` : ENDPOINT;
  const resource = usePortalResource<StockHome>(url, { errorMessage: "Could not load stock." });
  const home = resource.data ?? null;

  const [entryMode, setEntryMode] = useState<StockEntryKind | null>(null);
  const [itemDialog, setItemDialog] = useState<StockItemRow | "new" | null>(null);
  const [receiving, setReceiving] = useState<StockEntryRow | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [message, setMessage] = useState("");

  const atCurrent = !home || home.period === home.currentPeriod;
  const step = (delta: number) => {
    if (!home) return;

    const next = addBsMonths(home.period, delta);

    setPeriod(next === home.currentPeriod ? null : next);
  };

  const items = useMemo(() => (home?.items ?? []).filter((item) => item.active), [home]);
  const places = useMemo(() => (home?.places ?? []).filter((place) => place.mine), [home]);
  const low = items.filter((item) => item.at.some((at) => at.low)).length;
  const days = useMemo(() => {
    const map = new Map<string, StockEntryRow[]>();

    for (const entry of home?.entries ?? []) map.set(entry.on, [...(map.get(entry.on) ?? []), entry]);

    return [...map.entries()];
  }, [home]);

  const refresh = useCallback(async () => {
    await resource.refreshAsync();
  }, [resource]);

  const approve = async (id: string) => {
    try {
      await browserApi(`${ENDPOINT}/entries/${id}/approve`, { body: "{}", method: "POST" });
      setMessage("Count approved. The book now matches the shelf.");
      await refresh();
    } catch (error) {
      setMessage(errorText(error, "Could not approve it."));
    }
  };

  const cancel = async (id: string) => {
    if (cancelReason.trim().length < 3) {
      setMessage("Write why you are cancelling it — a few words.");
      return;
    }

    try {
      await browserApi(`${ENDPOINT}/entries/${id}/cancel`, {
        body: JSON.stringify({ reason: cancelReason.trim() }),
        method: "POST",
      });
      setCancelId(null);
      setCancelReason("");
      setMessage("Cancelled.");
      await refresh();
    } catch (error) {
      setMessage(errorText(error, "Could not cancel it."));
    }
  };

  const monthSwitcher = (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
      <Button aria-label="Previous month" onClick={() => step(-1)} size="icon-sm" variant="ghost">
        <ChevronLeft />
      </Button>
      <span className="min-w-28 text-center text-sm font-semibold">{home ? formatBsPeriod(home.period) : "…"}</span>
      <Button aria-label="Next month" disabled={atCurrent} onClick={() => step(1)} size="icon-sm" variant="ghost">
        <ChevronRight />
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <PortalPageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {monthSwitcher}
            <Button disabled={!home} onClick={() => setEntryMode("USE")}>
              <UtensilsCrossed />
              Use
            </Button>
            <Button disabled={!home} onClick={() => setEntryMode("BUY")} variant="outline">
              <PackagePlus />
              Bought
            </Button>
            <Button disabled={!home} onClick={() => setEntryMode("WASTE")} variant="outline">
              <Trash2 />
              Waste
            </Button>
            {(home?.places.length ?? 0) > 1 ? (
              <Button disabled={!home} onClick={() => setEntryMode("SEND")} variant="outline">
                <Send />
                Send
              </Button>
            ) : null}
            <Button disabled={!home} onClick={() => setEntryMode("COUNT")} variant="outline">
              <ClipboardList />
              Count
            </Button>
            <Button disabled={!home} onClick={() => setItemDialog("new")} variant="ghost">
              <Plus />
              New item
            </Button>
            <Button disabled={!home} onClick={() => home && downloadCsv(home)} variant="ghost">
              <Download />
              Export
            </Button>
          </div>
        }
        breadcrumb={["Operations", "Stock"]}
        description="Every bill, every use and every count — what is left, what it is worth, and what you owe."
        title="Stock"
      />

      {message ? <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">{message}</div> : null}

      {resource.state === "error" ? (
        <SectionCard>
          <p className="text-sm text-muted-foreground">{resource.message}</p>
        </SectionCard>
      ) : null}

      {!home && resource.state !== "error" ? <LoadingRows /> : null}

      {home ? (
        <>
          <div className={cn("grid gap-3", home.money ? "sm:grid-cols-4" : "sm:grid-cols-2")}>
            {home.money ? (
              <>
                <MetricCard
                  icon={Wallet}
                  label="Stock value"
                  note="What is left, at average cost"
                  tone="green"
                  value={currency(home.summary.stockValue ?? 0)}
                />
                <MetricCard
                  icon={Users}
                  label="Per student per day"
                  note={`Used, wasted and missing · ${home.summary.residents} students`}
                  tone="amber"
                  value={home.summary.costPerResidentDay === null ? "—" : currency(home.summary.costPerResidentDay)}
                />
                <MetricCard
                  icon={Store}
                  label="You owe suppliers"
                  tone={(home.summary.dueTotal ?? 0) > 0 ? "rose" : "green"}
                  value={currency(home.summary.dueTotal ?? 0)}
                />
              </>
            ) : (
              <MetricCard
                icon={Truck}
                label="On the way"
                note="Waiting for Got it"
                tone="amber"
                value={home.waiting.length + home.sentWaiting.length}
              />
            )}
            <MetricCard icon={AlertTriangle} label="Running low" tone={low > 0 ? "rose" : "green"} value={low} />
          </div>

          {home.toApprove.length > 0 ? (
            <SectionCard description="The book changes only when you approve." icon={ClipboardList} title="Counts to approve">
              <ul className="divide-y divide-border">
                {home.toApprove.map((entry) => (
                  <li className="space-y-2 py-3" key={entry.id}>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {entry.recordedByName} · {entry.hostelName}
                        </p>
                        <p className="text-sm text-muted-foreground">{summary(entry)}</p>
                        {entry.note ? <p className="text-xs text-muted-foreground">Why: {entry.note}</p> : null}
                      </div>
                      <Button onClick={() => void approve(entry.id)} size="sm">
                        Approve
                      </Button>
                      <Button onClick={() => setCancelId(entry.id)} size="sm" variant="ghost">
                        Turn down
                      </Button>
                    </div>
                    {cancelId === entry.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className="h-9 min-w-56 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                          onChange={(event) => setCancelReason(event.target.value)}
                          placeholder="Why turn it down?"
                          value={cancelReason}
                        />
                        <Button onClick={() => void cancel(entry.id)} size="sm" variant="destructive">
                          Turn down
                        </Button>
                        <Button onClick={() => setCancelId(null)} size="sm" variant="ghost">
                          Back
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {home.waiting.length > 0 ? (
            <SectionCard description="Check it came, then tap Got it." icon={Truck} title="Coming to you">
              <ul className="divide-y divide-border">
                {home.waiting.map((entry) => (
                  <li className="flex items-center gap-3 py-3" key={entry.id}>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">From {entry.hostelName}</p>
                      <p className="truncate text-sm text-muted-foreground">{summary(entry)}</p>
                    </div>
                    <Button onClick={() => setReceiving(entry)} size="sm">
                      Got it
                    </Button>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <SectionCard
            description="Store items show what is left; daily items show what came in this month."
            icon={Package}
            title="Items"
          >
            {items.length === 0 ? (
              <EmptyState label="No items yet. Add Rice, Daal, Vegetables…" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Item</th>
                      {places.map((place) => (
                        <th className="py-2 pr-3 text-right font-medium" key={place.id}>
                          {place.name}
                        </th>
                      ))}
                      <th className="py-2 pr-3 text-right font-medium">Used this month</th>
                      {home.money ? <th className="py-2 text-right font-medium">Value</th> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {items.map((item) => (
                      <tr
                        className={cn("align-top", home.owner && "cursor-pointer hover:bg-muted/40")}
                        key={item.id}
                        onClick={home.owner ? () => setItemDialog(item) : undefined}
                      >
                        <td className="py-2.5 pr-3">
                          <p className="font-medium">{item.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {item.kind === "DAILY" ? "Daily" : "Store"}
                            {item.avgCost !== null ? ` · ${currency(item.avgCost)}/${STOCK_UNIT_LABELS[item.unit].one}` : ""}
                          </p>
                        </td>
                        {places.map((place) => {
                          const at = item.at.find((row) => row.hostelId === place.id);

                          if (!at) return <td key={place.id} />;

                          return (
                            <td className="py-2.5 pr-3 text-right" key={place.id}>
                              <p className={cn("font-semibold", at.low && "text-destructive")}>
                                {formatQty(item.kind === "DAILY" ? at.in : at.left, item.unit)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {item.kind === "DAILY"
                                  ? "came in"
                                  : at.onWay > 0
                                    ? `+${formatQty(at.onWay, item.unit)} on the way`
                                    : at.countedAt
                                      ? `counted ${formatBsDate(new Date(at.countedAt))}`
                                      : "not counted"}
                              </p>
                            </td>
                          );
                        })}
                        <td className="py-2.5 pr-3 text-right">
                          {formatQty(item.at.reduce((sum, at) => sum + at.used, 0), item.unit)}
                          {item.at.some((at) => at.wasted > 0) ? (
                            <p className="text-xs text-destructive">
                              {formatQty(item.at.reduce((sum, at) => sum + at.wasted, 0), item.unit)} wasted
                            </p>
                          ) : null}
                          {item.at.some((at) => at.short > 0) ? (
                            <p className="text-xs text-destructive">
                              {formatQty(item.at.reduce((sum, at) => sum + at.short, 0), item.unit)} short
                            </p>
                          ) : null}
                        </td>
                        {home.money ? (
                          <td className="py-2.5 text-right font-medium">{item.value ? currency(item.value) : "—"}</td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title="This month">
            {days.length === 0 ? (
              <EmptyState label={atCurrent ? "Nothing yet. Click Bought when goods come in." : "Nothing was entered in this month."} />
            ) : (
              <div className="space-y-5">
                {days.map(([day, entries]) => (
                  <div className="space-y-2" key={day}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {formatBsDate(new Date(`${day}T00:00:00Z`))}
                    </p>
                    <ul className="divide-y divide-border rounded-xl border border-border">
                      {entries.map((entry) => (
                        <li className="space-y-2 px-4 py-3" key={entry.id}>
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="min-w-0 flex-1">
                              <p className={cn("font-medium", entry.status === "CANCELLED" && "line-through opacity-60")}>
                                {entryTitle(entry)}
                              </p>
                              <p className="text-sm text-muted-foreground">{summary(entry)}</p>
                              <p className="text-xs text-muted-foreground">
                                {entry.mine ? "You" : entry.recordedByName}
                                {entry.receivedByName ? ` · Got it: ${entry.receivedByName}` : ""}
                                {shortText(entry) ? ` · ${shortText(entry)}` : ""}
                                {entry.cancelReason ? ` · ${entry.cancelReason}` : ""}
                              </p>
                            </div>
                            <StatusPill entry={entry} />
                            {entry.bill?.total ? <span className="font-semibold">{currency(entry.bill.total)}</span> : null}
                            {entry.canCancel && cancelId !== entry.id ? (
                              <Button onClick={() => setCancelId(entry.id)} size="sm" variant="ghost">
                                Cancel
                              </Button>
                            ) : null}
                          </div>
                          {cancelId === entry.id ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                className="h-9 min-w-56 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                                onChange={(event) => setCancelReason(event.target.value)}
                                placeholder="Why cancel it?"
                                value={cancelReason}
                              />
                              <Button onClick={() => void cancel(entry.id)} size="sm" variant="destructive">
                                Cancel entry
                              </Button>
                              <Button onClick={() => setCancelId(null)} size="sm" variant="ghost">
                                Back
                              </Button>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SuppliersCard home={home} onChanged={refresh} onMessage={setMessage} />

          <EntryDialog
            home={home}
            mode={entryMode}
            onClose={() => setEntryMode(null)}
            onSaved={async (text) => {
              setEntryMode(null);
              setMessage(text);
              await refresh();
            }}
          />
          <ItemDialog
            item={itemDialog}
            onClose={() => setItemDialog(null)}
            onSaved={async (text) => {
              setItemDialog(null);
              setMessage(text);
              await refresh();
            }}
          />
          <ReceiveDialog
            entry={receiving}
            onClose={() => setReceiving(null)}
            onSaved={async () => {
              setReceiving(null);
              setMessage("Got it — added to your store.");
              await refresh();
            }}
          />
        </>
      ) : null}
    </div>
  );
});

/* ----------------------------------------------------- Bought · Send · Count */

function EntryDialog({
  home,
  mode,
  onClose,
  onSaved,
}: {
  home: StockHome;
  mode: StockEntryKind | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const mine = home.places.filter((place) => place.mine);
  const main = mine.find((place) => place.isMain);
  const [kind, setKind] = useState<StockEntryKind>("BUY");
  const [hostelId, setHostelId] = useState<string>("");
  const [toHostelId, setToHostelId] = useState<string>("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [price, setPrice] = useState<Record<string, string>>({});
  const [supplierId, setSupplierId] = useState("");
  const [billNo, setBillNo] = useState("");
  const [discountText, setDiscountText] = useState("");
  const [taxText, setTaxText] = useState("");
  const [paidText, setPaidText] = useState("");
  const [useFor, setUseFor] = useState<StockUseFor>("KITCHEN");
  const [wasteReason, setWasteReason] = useState<StockWasteReason>("SPOILED");
  const [paidBy, setPaidBy] = useState<ExpensePaidBy>("CASH");
  const [bsDate, setBsDate] = useState(() => toBsDayInput(todayKey()));
  const [note, setNote] = useState("");
  const [photoAssetId, setPhotoAssetId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [requestId, setRequestId] = useState(newRequestId);
  const [openedFor, setOpenedFor] = useState<StockEntryKind | null>(null);

  // A fresh form each time it opens, set during render rather than in an effect.
  if (mode !== openedFor) {
    setOpenedFor(mode);

    if (mode) {
      const from = (mode === "BUY" && main ? main : mine[0])?.id ?? "";

      setKind(mode);
      setHostelId(from);
      setToHostelId(home.places.find((place) => place.id !== from)?.id ?? "");
      setQty({});
      setPrice({});
      setSupplierId("");
      setBillNo("");
      setDiscountText("");
      setTaxText("");
      setPaidText("");
      setUseFor("KITCHEN");
      setWasteReason("SPOILED");
      setBsDate(toBsDayInput(todayKey()));
      setNote("");
      setPhotoAssetId(null);
      setError("");
      setRequestId(newRequestId());
    }
  }

  const storeOnly = kind === "COUNT" || kind === "USE" || kind === "WASTE";
  const items = home.items.filter((item) => item.active && (!storeOnly || item.kind === "STORE"));
  const showMoney = (kind === "BUY" || kind === "OPENING") && home.canSpend;
  const isBill = kind === "BUY" && home.canSpend;
  const rupees = (text: string) => (text.trim() ? parseAmountInput(text) : 0);
  const subtotal = showMoney ? items.reduce((sum, item) => sum + (rupees(price[item.id] ?? "") ?? 0), 0) : 0;
  const discount = rupees(discountText);
  const tax = rupees(taxText);
  const total = Math.max(0, subtotal - (discount ?? 0) + (tax ?? 0));
  const paid = paidText.trim() ? parseAmountInput(paidText) : total;
  const amount = isBill && total > 0 ? Math.min(paid ?? 0, total) : 0;
  const kinds: StockEntryKind[] = [
    "USE",
    "BUY",
    "WASTE",
    ...(home.places.length > 1 ? (["SEND"] as const) : []),
    "COUNT",
    ...(home.owner ? (["OPENING"] as const) : []),
  ];

  const save = async () => {
    const lines = items
      .filter((item) => (qty[item.id] ?? "").trim() !== "")
      .map((item) => {
        const count = Number((qty[item.id] ?? "").replace(",", "."));
        const value = showMoney ? (rupees(price[item.id] ?? "") ?? 0) : 0;

        return {
          itemId: item.id,
          qty: count,
          ...(value > 0 && kind === "BUY" ? { amount: value } : {}),
          ...(value > 0 && kind === "OPENING" && count > 0 ? { rate: value / count } : {}),
        };
      });
    const day = parseBsDayInput(bsDate);

    if (lines.length === 0) return setError("Write how much of at least one item.");
    if (lines.some((line) => !Number.isFinite(line.qty) || line.qty < 0 || (kind !== "COUNT" && line.qty === 0))) {
      return setError("Check the numbers.");
    }
    if (!day) return setError("Write the Nepali date like 2083-06-15.");
    if (kind === "SEND" && (!toHostelId || toHostelId === hostelId)) return setError("Pick where it goes.");
    if (showMoney && items.some((item) => rupees(price[item.id] ?? "") === null)) return setError("Prices are whole rupees.");
    if (discount === null || tax === null || paid === null) return setError("Check the discount, VAT and paid amounts.");
    if (isBill && total > 0 && amount < total && !supplierId) return setError("Pick the supplier who is owed the rest.");
    if (isBill && amount > 0 && home.proofRequired && !photoAssetId) return setError("Add a photo of the bill.");

    setSaving(true);
    setError("");

    try {
      await browserApi(ENDPOINT, {
        body: JSON.stringify({
          billNo: kind === "BUY" ? billNo.trim() || undefined : undefined,
          clientRequestId: requestId,
          discount: isBill && discount ? discount : undefined,
          hostelId,
          kind,
          lines,
          note: note.trim() || undefined,
          on: day,
          paid: isBill && total > 0 ? amount : undefined,
          paidBy: isBill && amount ? paidBy : undefined,
          photoAssetId: kind === "BUY" ? (photoAssetId ?? undefined) : undefined,
          supplierId: kind === "BUY" && supplierId ? supplierId : undefined,
          tax: isBill && tax ? tax : undefined,
          toHostelId: kind === "SEND" ? toHostelId : undefined,
          useFor: kind === "USE" ? useFor : undefined,
          wasteReason: kind === "WASTE" ? wasteReason : undefined,
        }),
        method: "POST",
      });
      await onSaved(
        kind === "SEND"
          ? `Sent to ${placeName(home, toHostelId)}. They click Got it when it comes.`
          : kind === "COUNT"
            ? home.canApprove
              ? "Count saved."
              : "Count saved. If it differs from the book, the owner approves it."
            : kind === "BUY" && total > amount
              ? `Bill saved. ${currency(total - amount)} owed to the supplier.`
              : kind === "BUY" && amount
                ? "Bill saved, and the paid amount added to Expenses."
                : `${KIND_LABEL[kind]} saved.`,
      );
    } catch (saveError) {
      setError(errorText(saveError, "Not saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const select = "h-9 rounded-md border border-border bg-background px-3 text-sm";

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={mode !== null}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{KIND_LABEL[kind]}</DialogTitle>
          <DialogDescription>
            {kind === "BUY"
              ? "A bill: goods that came in, what they cost, and what was paid."
              : kind === "USE"
                ? "Goods taken out of the store — for the kitchen, staff or a student."
                : kind === "WASTE"
                  ? "Goods thrown away. Say why."
                  : kind === "SEND"
                    ? "Goods going to another building. They click Got it when it arrives."
                    : kind === "OPENING"
                      ? "What was already on the shelf when you started, with its value."
                      : "What is left in the store now. A different number needs a reason."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
            {kinds.map((option) => (
              <button
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium",
                  kind === option ? "bg-background shadow-sm" : "text-muted-foreground",
                )}
                key={option}
                onClick={() => setKind(option)}
                type="button"
              >
                {KIND_LABEL[option]}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">
                {kind === "BUY" || kind === "OPENING" ? "Where did it come?" : kind === "SEND" ? "From" : "Where?"}
              </span>
              <select className={cn(select, "w-full")} onChange={(event) => setHostelId(event.target.value)} value={hostelId}>
                {mine.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </select>
            </label>
            {kind === "SEND" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">To</span>
                <select className={cn(select, "w-full")} onChange={(event) => setToHostelId(event.target.value)} value={toHostelId}>
                  {home.places
                    .filter((place) => place.id !== hostelId)
                    .map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : kind === "USE" || kind === "WASTE" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">{kind === "USE" ? "For" : "Why?"}</span>
                {kind === "USE" ? (
                  <select className={cn(select, "w-full")} onChange={(event) => setUseFor(event.target.value as StockUseFor)} value={useFor}>
                    {STOCK_USE_FOR.map((value) => (
                      <option key={value} value={value}>
                        {STOCK_USE_FOR_LABELS[value]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    className={cn(select, "w-full")}
                    onChange={(event) => setWasteReason(event.target.value as StockWasteReason)}
                    value={wasteReason}
                  >
                    {STOCK_WASTE_REASONS.map((value) => (
                      <option key={value} value={value}>
                        {STOCK_WASTE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            ) : kind === "BUY" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">Supplier</span>
                <select className={cn(select, "w-full")} onChange={(event) => setSupplierId(event.target.value)} value={supplierId}>
                  <option value="">No supplier</option>
                  {home.suppliers
                    .filter((supplier) => supplier.active)
                    .map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>

          {items.length === 0 ? (
            <EmptyState label={kind === "COUNT" ? "No store items to count." : "Add an item first."} />
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {items.map((item) => {
                const at = item.at.find((row) => row.hostelId === hostelId);

                return (
                  <li className="flex items-center gap-3 px-3 py-2" key={item.id}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.kind === "STORE" && at && kind !== "BUY"
                          ? `${kind === "COUNT" ? "Book says" : "Left"} ${formatQty(at.left, item.unit)}`
                          : item.kind === "DAILY"
                            ? "Daily"
                            : "Store"}
                      </p>
                    </div>
                    <input
                      aria-label={`${item.name} quantity`}
                      className="h-9 w-24 rounded-md border border-border bg-background px-3 text-right text-sm font-semibold"
                      inputMode="decimal"
                      onChange={(event) => setQty((prev) => ({ ...prev, [item.id]: event.target.value }))}
                      placeholder="0"
                      value={qty[item.id] ?? ""}
                    />
                    <span className="w-14 text-xs text-muted-foreground">{STOCK_UNIT_LABELS[item.unit].many}</span>
                    {showMoney ? (
                      <input
                        aria-label={`${item.name} ${kind === "OPENING" ? "value" : "price"}`}
                        className="h-9 w-28 rounded-md border border-border bg-background px-3 text-right text-sm"
                        inputMode="numeric"
                        onChange={(event) => setPrice((prev) => ({ ...prev, [item.id]: event.target.value }))}
                        placeholder={kind === "OPENING" ? "Value Rs" : "Price Rs"}
                        value={price[item.id] ?? ""}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {kind === "BUY" ? (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Bill no.</span>
                  <input
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                    maxLength={40}
                    onChange={(event) => setBillNo(event.target.value)}
                    value={billNo}
                  />
                </label>
                {isBill ? (
                  <>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Discount</span>
                      <input
                        className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                        inputMode="numeric"
                        onChange={(event) => setDiscountText(event.target.value)}
                        placeholder="Rs 0"
                        value={discountText}
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">VAT / tax</span>
                      <input
                        className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                        inputMode="numeric"
                        onChange={(event) => setTaxText(event.target.value)}
                        placeholder="Rs 0"
                        value={taxText}
                      />
                    </label>
                  </>
                ) : null}
              </div>
              {isBill && total > 0 ? (
                <div className="flex flex-wrap items-end gap-3">
                  <p className="text-sm">
                    Bill total <span className="font-semibold">{currency(total)}</span>
                  </p>
                  <label className="space-y-1 text-sm">
                    <span className="block font-medium">Paid now</span>
                    <input
                      className="h-9 w-32 rounded-md border border-border bg-background px-3 text-sm"
                      inputMode="numeric"
                      onChange={(event) => setPaidText(event.target.value)}
                      placeholder={`${total} (all)`}
                      value={paidText}
                    />
                  </label>
                  {amount > 0 ? (
                    <select className={select} onChange={(event) => setPaidBy(event.target.value as ExpensePaidBy)} value={paidBy}>
                      {EXPENSE_PAID_BY.map((value) => (
                        <option key={value} value={value}>
                          {EXPENSE_PAID_BY_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {total > amount ? <p className="text-sm text-amber-700 dark:text-amber-400">{currency(total - amount)} owed</p> : null}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-sm">
                  <span className="sr-only">Bill photo</span>
                  <input
                    accept="image/*"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];

                      if (!file) return;

                      setUploading(true);
                      setPhotoAssetId(null);

                      try {
                        const result = await uploadFile(file, {
                          assetKind: "EXPENSE_RECEIPT",
                          kind: "image",
                          label: "Bill photo",
                          silent: true,
                        });

                        setPhotoAssetId(result?.assetId ?? null);
                      } finally {
                        setUploading(false);
                      }
                    }}
                    type="file"
                  />
                </label>
                <span className="text-xs text-muted-foreground">
                  {uploading ? "Adding photo…" : photoAssetId ? "Photo added" : home.proofRequired && amount > 0 ? "Photo needed" : "Photo optional"}
                </span>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Nepali date</span>
              <input
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                onChange={(event) => setBsDate(event.target.value)}
                placeholder="2083-06-15"
                value={bsDate}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">{kind === "COUNT" ? "Why different? (needed if it is)" : "Note (optional)"}</span>
              <input
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                maxLength={200}
                onChange={(event) => setNote(event.target.value)}
                value={note}
              />
            </label>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
          <Button disabled={saving || uploading} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Got it */

function ReceiveDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: StockEntryRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [got, setGot] = useState<Record<string, string>>({});
  const [seen, setSeen] = useState<StockEntryRow | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  if (entry !== seen) {
    setSeen(entry);
    setGot(Object.fromEntries((entry?.lines ?? []).map((line) => [line.itemId, String(line.qty)])));
    setError("");
  }

  const save = async () => {
    if (!entry) return;

    const lines = entry.lines.map((line) => ({
      itemId: line.itemId,
      receivedQty: Number((got[line.itemId] ?? "").replace(",", ".")),
    }));

    if (lines.some((line) => !Number.isFinite(line.receivedQty) || line.receivedQty < 0)) {
      return setError("Write how much came of each, 0 if nothing.");
    }

    setSaving(true);

    try {
      await browserApi(`${ENDPOINT}/entries/${entry.id}/receive`, { body: JSON.stringify({ lines }), method: "POST" });
      await onSaved();
    } catch (saveError) {
      setError(errorText(saveError, "Not saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={entry !== null}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>From {entry?.hostelName}</DialogTitle>
          <DialogDescription>Change a number if less came.</DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {entry?.lines.map((line) => (
            <li className="flex items-center gap-3 px-3 py-2" key={line.itemId}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{line.name}</p>
                <p className="text-xs text-muted-foreground">Sent {formatQty(line.qty, line.unit)}</p>
              </div>
              <input
                aria-label={`${line.name} that came`}
                className="h-9 w-24 rounded-md border border-border bg-background px-3 text-right text-sm font-semibold"
                inputMode="decimal"
                onChange={(event) => setGot((prev) => ({ ...prev, [line.itemId]: event.target.value }))}
                value={got[line.itemId] ?? ""}
              />
            </li>
          ))}
        </ul>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Got it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------- items */

function ItemDialog({
  item,
  onClose,
  onSaved,
}: {
  item: StockItemRow | "new" | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const editing = item && item !== "new" ? item : null;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StockKind>("STORE");
  const [unit, setUnit] = useState<StockUnit>("KG");
  const [lowAt, setLowAt] = useState("");
  const [active, setActive] = useState(true);
  const [seen, setSeen] = useState<typeof item>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  if (item !== seen) {
    setSeen(item);
    setName(editing?.name ?? "");
    setKind(editing?.kind ?? "STORE");
    setUnit(editing?.unit ?? "KG");
    setLowAt(editing?.lowAt != null ? String(editing.lowAt) : "");
    setActive(editing?.active ?? true);
    setError("");
  }

  const save = async () => {
    const low = lowAt.trim() ? Number(lowAt) : null;

    if (!name.trim()) return setError("Name it, like Rice.");
    if (low !== null && (!Number.isFinite(low) || low < 0)) return setError("Check the low mark.");

    setSaving(true);

    try {
      const body = { kind, lowAt: kind === "STORE" ? low : null, name: name.trim(), unit };

      await browserApi(editing ? `${ENDPOINT}/items/${editing.id}` : `${ENDPOINT}/items`, {
        body: JSON.stringify(editing ? { ...body, active } : body),
        method: editing ? "PATCH" : "POST",
      });
      await onSaved(editing ? "Item saved." : `${name.trim()} added.`);
    } catch (saveError) {
      setError(errorText(saveError, "Not saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const select = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm";

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={item !== null}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit item" : "New item"}</DialogTitle>
          <DialogDescription>Store items are counted; daily items are used the day they come.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Item</span>
            <input className={select} maxLength={STOCK_ITEM_NAME_MAX} onChange={(event) => setName(event.target.value)} placeholder="e.g. Rice" value={name} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Kind</span>
              <select className={select} onChange={(event) => setKind(event.target.value as StockKind)} value={kind}>
                <option value="STORE">Store · long use</option>
                <option value="DAILY">Daily · used same day</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Counted in</span>
              <select className={select} onChange={(event) => setUnit(event.target.value as StockUnit)} value={unit}>
                {STOCK_UNITS.map((value) => (
                  <option key={value} value={value}>
                    {STOCK_UNIT_LABELS[value].many}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {kind === "STORE" ? (
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Running low below (optional)</span>
              <input className={select} inputMode="decimal" onChange={(event) => setLowAt(event.target.value)} placeholder="e.g. 10" value={lowAt} />
            </label>
          ) : null}
          {editing ? (
            <label className="flex items-center gap-2 text-sm">
              <input checked={active} onChange={(event) => setActive(event.target.checked)} type="checkbox" />
              Still buying it
            </label>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : editing ? "Save" : "Add item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- Suppliers */

/**
 * Who the hostel buys from and what it owes each — bills (credit) against
 * payments (debit). Pay writes one expense; the balance drops by the same.
 * Without money rights it is a list of names and numbers.
 */
function SuppliersCard({
  home,
  onChanged,
  onMessage,
}: {
  home: StockHome;
  onChanged: () => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [owedText, setOwedText] = useState("");
  const [paying, setPaying] = useState<StockHome["suppliers"][number] | null>(null);
  const [payText, setPayText] = useState("");
  const [payBy, setPayBy] = useState<ExpensePaidBy>("CASH");
  const [payNote, setPayNote] = useState("");
  const [payPhoto, setPayPhoto] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [requestId, setRequestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const suppliers = home.suppliers
    .filter((supplier) => supplier.active)
    .sort((a, b) => (b.due ?? 0) - (a.due ?? 0) || a.name.localeCompare(b.name));
  const input = "h-9 rounded-md border border-border bg-background px-3 text-sm";

  const add = async () => {
    const owed = owedText.trim() ? parseAmountInput(owedText) : 0;

    if (!name.trim()) return setError("Name the shop.");
    if (owed === null) return setError("Already owed is whole rupees.");

    setBusy(true);
    setError("");

    try {
      await browserApi(`${ENDPOINT}/suppliers`, {
        body: JSON.stringify({
          name: name.trim(),
          openingDue: home.owner && owed ? owed : undefined,
          phone: phone.trim() || undefined,
        }),
        method: "POST",
      });
      setAdding(false);
      setName("");
      setPhone("");
      setOwedText("");
      onMessage("Supplier added.");
      await onChanged();
    } catch (saveError) {
      setError(errorText(saveError, "Not saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    const amount = parseAmountInput(payText);

    if (!paying || !amount) return setError("Write the amount in whole rupees.");
    if (home.proofRequired && !payPhoto) return setError("Add a photo of the receipt.");

    setBusy(true);
    setError("");

    try {
      await browserApi(`${ENDPOINT}/payments`, {
        body: JSON.stringify({
          amount,
          clientRequestId: requestId,
          note: payNote.trim() || undefined,
          paidBy: payBy,
          photoAssetId: payPhoto ?? undefined,
          supplierId: paying.id,
        }),
        method: "POST",
      });
      onMessage(`Paid ${paying.name} ${currency(amount)}. Added to Expenses.`);
      setPaying(null);
      await onChanged();
    } catch (saveError) {
      setError(errorText(saveError, "Not saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      actions={
        <Button onClick={() => setAdding((value) => !value)} size="sm" variant="outline">
          <Plus />
          New supplier
        </Button>
      }
      description={home.money ? "Bills not fully paid stay here until you pay them." : "The shops you buy from."}
      icon={Store}
      title="Suppliers"
    >
      {adding ? (
        <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border p-3">
          <input className={cn(input, "min-w-48 flex-1")} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Shop or person" value={name} />
          <input className={cn(input, "w-40")} maxLength={20} onChange={(event) => setPhone(event.target.value)} placeholder="Phone" value={phone} />
          {home.owner ? (
            <input
              className={cn(input, "w-40")}
              inputMode="numeric"
              onChange={(event) => setOwedText(event.target.value)}
              placeholder="Already owed Rs"
              value={owedText}
            />
          ) : null}
          <Button disabled={busy} onClick={() => void add()} size="sm">
            Add
          </Button>
        </div>
      ) : null}

      {error && !paying ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}

      {suppliers.length === 0 ? (
        <EmptyState label="No suppliers yet. Add the shops you buy from, then pick one on a bill." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Supplier</th>
                <th className="py-2 pr-3 font-medium">Last bill</th>
                {home.money ? <th className="py-2 pr-3 text-right font-medium">All bills</th> : null}
                {home.money ? <th className="py-2 pr-3 text-right font-medium">Owed now</th> : null}
                {home.canSpend ? <th className="py-2" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {suppliers.map((supplier) => (
                <tr key={supplier.id}>
                  <td className="py-2.5 pr-3">
                    <p className="font-medium">{supplier.name}</p>
                    {supplier.phone ? <p className="text-xs text-muted-foreground">{supplier.phone}</p> : null}
                  </td>
                  <td className="py-2.5 pr-3 text-muted-foreground">
                    {supplier.lastBillOn ? formatBsDate(new Date(`${supplier.lastBillOn}T00:00:00Z`)) : "—"}
                  </td>
                  {home.money ? <td className="py-2.5 pr-3 text-right">{currency(supplier.billed ?? 0)}</td> : null}
                  {home.money ? (
                    <td
                      className={cn(
                        "py-2.5 pr-3 text-right font-semibold",
                        (supplier.due ?? 0) > 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400",
                      )}
                    >
                      {(supplier.due ?? 0) > 0 ? currency(supplier.due ?? 0) : (supplier.due ?? 0) < 0 ? `${currency(-(supplier.due ?? 0))} ahead` : "Settled"}
                    </td>
                  ) : null}
                  {home.canSpend ? (
                    <td className="py-2.5 text-right">
                      <Button
                        onClick={() => {
                          setPaying(supplier);
                          setPayText((supplier.due ?? 0) > 0 ? String(supplier.due) : "");
                          setPayBy("CASH");
                          setPayNote("");
                          setPayPhoto(null);
                          setRequestId(newRequestId());
                          setError("");
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Pay
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog onOpenChange={(next) => (next ? undefined : setPaying(null))} open={paying !== null}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pay {paying?.name}</DialogTitle>
            <DialogDescription>
              {paying && (paying.due ?? 0) > 0 ? `${currency(paying.due ?? 0)} owed now. ` : ""}It is added to Expenses too.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <input className={cn(input, "w-full")} inputMode="numeric" onChange={(event) => setPayText(event.target.value)} placeholder="Amount Rs" value={payText} />
            <select className={cn(input, "w-full")} onChange={(event) => setPayBy(event.target.value as ExpensePaidBy)} value={payBy}>
              {EXPENSE_PAID_BY.map((value) => (
                <option key={value} value={value}>
                  {EXPENSE_PAID_BY_LABELS[value]}
                </option>
              ))}
            </select>
            <input className={cn(input, "w-full")} maxLength={200} onChange={(event) => setPayNote(event.target.value)} placeholder="Note (optional)" value={payNote} />
            <div className="flex items-center gap-2">
              <input
                accept="image/*"
                aria-label="Receipt photo"
                onChange={async (event) => {
                  const file = event.target.files?.[0];

                  if (!file) return;

                  setUploading(true);
                  setPayPhoto(null);

                  try {
                    const result = await uploadFile(file, { assetKind: "EXPENSE_RECEIPT", kind: "image", label: "Receipt", silent: true });

                    setPayPhoto(result?.assetId ?? null);
                  } finally {
                    setUploading(false);
                  }
                }}
                type="file"
              />
              <span className="text-xs text-muted-foreground">
                {uploading ? "Adding photo…" : payPhoto ? "Photo added" : home.proofRequired ? "Photo needed" : "Photo optional"}
              </span>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button onClick={() => setPaying(null)} variant="ghost">
              Close
            </Button>
            <Button disabled={busy || uploading} onClick={() => void pay()}>
              {busy ? "Paying…" : "Pay"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
