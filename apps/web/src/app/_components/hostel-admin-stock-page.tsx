"use client";

import { downloadFile, downloadTable, type TableFormat } from "@/lib/downloads/downloader";

import {
  AlertTriangle,
  Archive,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  BarChart3,
  Download,
  Package,
  PackagePlus,
  Plus,
  Search,
  Send,
  Store,
  Trash2,
  Truck,
  Users,
  UtensilsCrossed,
  Wallet,
} from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { browserApi } from "@/lib/browser-api";
import { addBsMonths, formatBsDate, formatBsPeriod } from "@/lib/hostel-day";
import { usePortalResource } from "@/lib/portal-query";
import { uploadFile } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";
import {
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  type ExpenseCategoryKey,
  type ExpensePaidBy,
} from "@hostel/shared/expenses/categories";
import { parseAmountInput, parseBsDayInput, toBsDayInput, todayKey } from "@hostel/shared/expenses/input";
import {
  formatPackQty,
  formatQty,
  guessStockKind,
  splitBill,
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

import type { StockEntryRow, StockHome, StockItemRow, StockReport, StockUsage, StockUsageRange } from "@/lib/stock/stock.types";
import { STOCK_EXPENSE_CATEGORIES, type StockReportRange } from "@/lib/stock/stock.validation";

import { EmptyState, LoadingRows, currency } from "./shared-ui";
import { MoreMenu } from "./hostel-admin-page-ui";
import { MetricCard, PortalPageHeader, SectionCard } from "./portal-dashboard-ui";

/**
 * Inventory on the web (docs/INVENTORY_PLAN.md) — the owner's desk view of the
 * app's Inventory screen. Same API, so a warden here sees only their own building.
 *
 * What needs a click (counts to approve, goods arriving) sits on top; the rest
 * is one tab each: Items, Activity, Suppliers, Used, Reports.
 *
 * Every movement — Buy, Use, Waste, Send, Count, Opening — shares one dialog:
 * find an item, write how much, save. A Buy is a bill: item prices are
 * optional, the bill total is what counts, and whatever was not paid is owed to
 * the supplier. Dates are Bikram Sambat.
 */

const ENDPOINT = "/api/v1/hostel-admin/stock";

const KIND_LABEL: Record<StockEntryKind, string> = { ...STOCK_ENTRY_LABELS, BUY: "Buy" };

const field = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm";

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function newRequestId() {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function placeName(home: StockHome, id: string | null) {
  return home.places.find((place) => place.id === id)?.name ?? "Hostel";
}

function categoryLabel(category: string) {
  return EXPENSE_CATEGORY_LABELS[category as ExpenseCategoryKey] ?? "Other";
}

/** `null` blank, `false` not whole rupees, else the number. */
function readRupees(text: string): number | false | null {
  if (!text.trim()) return null;

  const value = parseAmountInput(text);

  return value === null ? false : value;
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
  if (entry.kind === "BUY") {
    return `Bought${entry.supplier ? ` · ${entry.supplier}` : ""}${entry.bill?.billNo ? ` · bill ${entry.bill.billNo}` : ""}`;
  }
  if (entry.kind === "USE" && entry.useFor) return `Used · ${STOCK_USE_FOR_LABELS[entry.useFor]} · ${entry.hostelName}`;
  if (entry.kind === "WASTE" && entry.wasteReason) {
    return `Wasted · ${STOCK_WASTE_LABELS[entry.wasteReason]} · ${entry.hostelName}`;
  }

  return `${STOCK_ENTRY_LABELS[entry.kind]} · ${entry.hostelName}`;
}

/** The items table as a CSV or a PDF, in the screen's period. */
function exportStock(home: StockHome, format: TableFormat) {
  const sumOf = (item: StockItemRow, pick: (at: StockItemRow["at"][number]) => number) =>
    item.at.reduce((total, at) => total + pick(at), 0);

  void downloadTable(
    format,
    `inventory-${home.period}`,
    [
      { key: "name", label: "Item" },
      { key: "category", label: "Category" },
      { key: "unit", label: "Unit" },
      { key: "opening", label: "Opening" },
      { key: "in", label: "In" },
      { key: "used", label: "Used" },
      { key: "wasted", label: "Wasted" },
      { key: "sent", label: "Sent" },
      { key: "adjusted", label: "Count +/-" },
      { key: "closing", label: "Closing" },
      { key: "avgCost", label: "Avg cost" },
      { key: "value", label: "Value now" },
    ],
    home.items
      .filter((item) => item.active && item.kind === "STORE")
      .map((item) => ({
        adjusted: sumOf(item, (at) => at.adjusted),
        avgCost: item.avgCost ?? "",
        category: categoryLabel(item.category),
        closing: sumOf(item, (at) => at.closing),
        in: sumOf(item, (at) => at.in),
        name: item.name,
        opening: sumOf(item, (at) => at.opening),
        sent: sumOf(item, (at) => at.out),
        unit: item.unit.toLowerCase(),
        used: sumOf(item, (at) => at.used),
        value: item.value ?? "",
        wasted: sumOf(item, (at) => at.wasted),
      })),
    { period: home.period, title: "Inventory" },
  );
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

/** A small "why" box under a row, for Cancel and Turn down. */
function ReasonBox({
  action,
  onBack,
  onConfirm,
  placeholder,
}: {
  action: string;
  onBack: () => void;
  onConfirm: (reason: string) => Promise<void>;
  placeholder: string;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();

        if (reason.trim().length < 3) {
          toast.error("Write why — a few words.");
          return;
        }

        setBusy(true);

        try {
          await onConfirm(reason.trim());
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        autoFocus
        className={cn(field, "min-w-56 flex-1")}
        maxLength={300}
        onChange={(event) => setReason(event.target.value)}
        placeholder={placeholder}
        value={reason}
      />
      <Button disabled={busy} size="sm" type="submit" variant="destructive">
        {action}
      </Button>
      <Button onClick={onBack} size="sm" type="button" variant="ghost">
        Back
      </Button>
    </form>
  );
}

export const HostelAdminStockPageContent = memo(function HostelAdminStockPageContent() {
  const [period, setPeriod] = useState<string | null>(null);
  const url = period ? `${ENDPOINT}?period=${period}` : ENDPOINT;
  const resource = usePortalResource<StockHome>(url, { errorMessage: "Could not load the inventory." });
  const home = resource.data ?? null;

  const [entryMode, setEntryMode] = useState<StockEntryKind | null>(null);
  const [itemDialog, setItemDialog] = useState<StockItemRow | "new" | null>(null);
  const [receiving, setReceiving] = useState<StockEntryRow | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [tab, setTab] = useState("items");
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const atCurrent = !home || home.period === home.currentPeriod;
  const step = (delta: number) => {
    if (!home) return;

    const next = addBsMonths(home.period, delta);

    setPeriod(next === home.currentPeriod ? null : next);
  };

  const items = useMemo(() => (home?.items ?? []).filter((item) => item.active), [home]);
  const places = useMemo(() => (home?.places ?? []).filter((place) => place.mine), [home]);
  const low = items.filter((item) => item.at.some((at) => at.low)).length;
  const typed = query.trim().toLowerCase();
  const shownItems = items.filter(
    (item) =>
      (!lowOnly || item.at.some((at) => at.low)) &&
      (!typed || item.name.toLowerCase().includes(typed) || categoryLabel(item.category).toLowerCase().includes(typed)),
  );
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
      toast.success("Count approved. The book now matches the shelf.");
      await refresh();
    } catch (error) {
      toast.error(errorText(error, "Could not approve it."));
    }
  };

  const cancel = async (id: string, reason: string) => {
    try {
      await browserApi(`${ENDPOINT}/entries/${id}/cancel`, { body: JSON.stringify({ reason }), method: "POST" });
      setCancelId(null);
      toast.success("Cancelled. It stays in Activity, crossed out.");
      await refresh();
    } catch (error) {
      toast.error(errorText(error, "Could not cancel it."));
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
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {monthSwitcher}
            <Button className="h-9 rounded-xl" disabled={!home} onClick={() => setEntryMode("USE")} variant="outline">
              <UtensilsCrossed />
              Use
            </Button>
            <Button
              className="h-9 rounded-xl bg-brand-teal text-white hover:bg-brand-teal/90"
              disabled={!home}
              onClick={() => setEntryMode("BUY")}
            >
              <PackagePlus />
              Buy
            </Button>
            <MoreMenu label="More inventory actions">
              <DropdownMenuItem disabled={!home} onSelect={() => setEntryMode("WASTE")}>
                <Trash2 className="size-4" />
                Waste
              </DropdownMenuItem>
              {(home?.places.length ?? 0) > 1 ? (
                <DropdownMenuItem disabled={!home} onSelect={() => setEntryMode("SEND")}>
                  <Send className="size-4" />
                  Send to a branch
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={!home} onSelect={() => setEntryMode("COUNT")}>
                <ClipboardList className="size-4" />
                Stock check
              </DropdownMenuItem>
              {home?.owner ? (
                <DropdownMenuItem onSelect={() => setEntryMode("OPENING")}>
                  <Archive className="size-4" />
                  Opening stock
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!home} onSelect={() => setItemDialog("new")}>
                <Plus className="size-4" />
                New item
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!home} onSelect={() => home && exportStock(home, "pdf")}>
                <Download className="size-4" />
                Download PDF
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!home} onSelect={() => home && exportStock(home, "csv")}>
                <Download className="size-4" />
                Download CSV
              </DropdownMenuItem>
            </MoreMenu>
          </div>
        }
        breadcrumb={["Operations", "Inventory"]}
        description="What is in the store, what it is worth, and what you owe."
        title="Inventory"
      />

      {resource.state === "error" ? (
        <SectionCard>
          <p className="text-sm text-muted-foreground">{resource.message}</p>
        </SectionCard>
      ) : null}

      {!home && resource.state !== "error" ? <LoadingRows /> : null}

      {home ? (
        <>
          <div className={cn("grid gap-3", home.money ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2")}>
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
                  icon={Store}
                  label="You owe suppliers"
                  note={(home.summary.dueTotal ?? 0) > 0 ? "See Suppliers to pay" : "Nothing owed"}
                  tone={(home.summary.dueTotal ?? 0) > 0 ? "amber" : "green"}
                  value={currency(home.summary.dueTotal ?? 0)}
                />
                <MetricCard
                  icon={Users}
                  label="Per student per day"
                  note={`Used, wasted and missing · ${home.summary.residents} students`}
                  tone="teal"
                  value={home.summary.costPerResidentDay === null ? "—" : currency(home.summary.costPerResidentDay)}
                />
              </>
            ) : (
              <MetricCard
                icon={Truck}
                label="On the way"
                note="Waiting for Got it"
                tone="teal"
                value={home.waiting.length + home.sentWaiting.length}
              />
            )}
            <MetricCard
              icon={AlertTriangle}
              label="Running low"
              note={low > 0 ? "Buy these soon" : "Nothing low"}
              tone={low > 0 ? "amber" : "green"}
              value={low}
            />
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
                      <ReasonBox
                        action="Turn down"
                        onBack={() => setCancelId(null)}
                        onConfirm={(reason) => cancel(entry.id, reason)}
                        placeholder="Why turn it down?"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {home.waiting.length > 0 ? (
            <SectionCard description="Check it came, then click Got it." icon={Truck} title="Coming to you">
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

          <Tabs onValueChange={setTab} value={tab}>
            <TabsList className="flex-wrap" variant="line">
              <TabsTrigger value="items">Items · {items.length}</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
              <TabsTrigger value="used">Used</TabsTrigger>
              {home.money ? <TabsTrigger value="reports">Reports</TabsTrigger> : null}
            </TabsList>

            {/* Store items show what is left; daily items show what came in this month. */}
            <TabsContent value="items">
              <SectionCard
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="relative">
                      <span className="sr-only">Find an item</span>
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        className={cn(field, "w-56 pl-8")}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Find an item"
                        value={query}
                      />
                    </label>
                    <Button
                      aria-pressed={lowOnly}
                      onClick={() => setLowOnly((value) => !value)}
                      size="sm"
                      variant={lowOnly ? "default" : "outline"}
                    >
                      Running low
                    </Button>
                  </div>
                }
                icon={Package}
                title="Items"
              >
                {items.length === 0 ? (
                  <EmptyState label="No items yet. Click Buy when goods come — new names become items as you type them." />
                ) : shownItems.length === 0 ? (
                  <EmptyState label={lowOnly ? "Nothing is running low." : "Nothing called that."} />
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
                        {shownItems.map((item) => (
                          <tr
                            className={cn("align-top", home.owner && "cursor-pointer hover:bg-muted/40")}
                            key={item.id}
                            onClick={home.owner ? () => setItemDialog(item) : undefined}
                          >
                            <td className="py-2.5 pr-3">
                              <p className="font-medium">{item.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {item.kind === "DAILY" ? "Daily" : "Store"} · {categoryLabel(item.category)}
                                {item.avgCost !== null ? ` · ${currency(item.avgCost)}/${STOCK_UNIT_LABELS[item.unit].one}` : ""}
                              </p>
                            </td>
                            {places.map((place) => {
                              const at = item.at.find((row) => row.hostelId === place.id);

                              if (!at) return <td key={place.id} />;

                              return (
                                <td className="py-2.5 pr-3 text-right" key={place.id}>
                                  <p className={cn("font-semibold tabular-nums", at.low && "text-amber-600 dark:text-amber-400")}>
                                    {formatQty(item.kind === "DAILY" ? at.in : at.left, item.unit)}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {item.kind === "DAILY"
                                      ? "came in"
                                      : at.low
                                        ? "running low"
                                        : at.onWay > 0
                                          ? `+${formatQty(at.onWay, item.unit)} on the way`
                                          : at.countedAt
                                            ? `counted ${formatBsDate(new Date(at.countedAt))}`
                                            : "not counted"}
                                  </p>
                                </td>
                              );
                            })}
                            <td className="py-2.5 pr-3 text-right tabular-nums">
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
                              <td className="py-2.5 text-right font-medium tabular-nums">{item.value ? currency(item.value) : "—"}</td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="activity">
              <SectionCard title={formatBsPeriod(home.period)}>
                {days.length === 0 ? (
                  <EmptyState label={atCurrent ? "Nothing yet. Click Buy when goods come in." : "Nothing was entered in this month."} />
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
                                    {entry.bill?.due ? ` · ${currency(entry.bill.due)} owed` : ""}
                                    {entry.cancelReason ? ` · ${entry.cancelReason}` : ""}
                                  </p>
                                </div>
                                <StatusPill entry={entry} />
                                {entry.bill?.total ? <span className="font-semibold tabular-nums">{currency(entry.bill.total)}</span> : null}
                                {entry.canCancel && cancelId !== entry.id ? (
                                  <Button onClick={() => setCancelId(entry.id)} size="sm" variant="ghost">
                                    Cancel
                                  </Button>
                                ) : null}
                              </div>
                              {cancelId === entry.id ? (
                                <ReasonBox
                                  action="Cancel entry"
                                  onBack={() => setCancelId(null)}
                                  onConfirm={(reason) => cancel(entry.id, reason)}
                                  placeholder="Why cancel it?"
                                />
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="suppliers">
              <SuppliersCard home={home} onChanged={refresh} onMessage={(text) => toast.success(text)} />
            </TabsContent>

            <TabsContent value="used">
              <UsageCard />
            </TabsContent>

            {home.money ? (
              <TabsContent value="reports">
                <ReportCard />
              </TabsContent>
            ) : null}
          </Tabs>

          <EntryDialog
            home={home}
            mode={entryMode}
            onClose={() => setEntryMode(null)}
            onItemAdded={refresh}
            onSaved={async (text) => {
              setEntryMode(null);
              toast.success(text);
              await refresh();
            }}
          />
          <ItemDialog
            item={itemDialog}
            onClose={() => setItemDialog(null)}
            onSaved={async (text) => {
              setItemDialog(null);
              toast.success(text);
              await refresh();
            }}
          />
          <ReceiveDialog
            entry={receiving}
            onClose={() => setReceiving(null)}
            onSaved={async () => {
              setReceiving(null);
              toast.success("Got it — added to your store.");
              await refresh();
            }}
          />
        </>
      ) : null}
    </div>
  );
});

/* ----------------------------------------------------- Buy · Use · Send · Count */

type Payment = "all" | "none" | "part";

function EntryDialog({
  home,
  mode,
  onClose,
  onItemAdded,
  onSaved,
}: {
  home: StockHome;
  mode: StockEntryKind | null;
  onClose: () => void;
  onItemAdded: () => Promise<void>;
  onSaved: (message: string) => Promise<void>;
}) {
  const mine = home.places.filter((place) => place.mine);
  const main = mine.find((place) => place.isMain);
  const [kind, setKind] = useState<StockEntryKind>("BUY");
  const [hostelId, setHostelId] = useState<string>("");
  const [toHostelId, setToHostelId] = useState<string>("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [price, setPrice] = useState<Record<string, string>>({});
  const [find, setFind] = useState("");
  const [newUnit, setNewUnit] = useState<StockUnit>("KG");
  const [adding, setAdding] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [billNo, setBillNo] = useState("");
  const [totalText, setTotalText] = useState("");
  const [payment, setPayment] = useState<Payment>("all");
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
      setFind("");
      setSupplierId("");
      setBillNo("");
      setTotalText("");
      setPayment("all");
      setPaidText("");
      setUseFor("KITCHEN");
      setWasteReason("SPOILED");
      setPaidBy("CASH");
      setBsDate(toBsDayInput(todayKey()));
      setNote("");
      setPhotoAssetId(null);
      setError("");
      setRequestId(newRequestId());
    }
  }

  const storeOnly = kind === "COUNT" || kind === "USE" || kind === "WASTE";
  const incoming = kind === "BUY" || kind === "OPENING";
  const items = home.items.filter((item) => item.active && (!storeOnly || item.kind === "STORE"));
  const showMoney = incoming && home.canSpend;
  const isBill = kind === "BUY" && home.canSpend;
  const qtyOf = (item: StockItemRow) => {
    const value = Number((qty[item.id] ?? "").replace(",", "."));

    return (qty[item.id] ?? "").trim() && Number.isFinite(value) ? value : null;
  };
  const leftHere = (item: StockItemRow) => item.at.find((row) => row.hostelId === hostelId)?.left ?? 0;

  /* The lines: every item with a number in its box, in the order of the list. */
  const picked = items.filter((item) => (qty[item.id] ?? "").trim() !== "");
  const wanted = find.trim().toLowerCase();
  const others = items.filter((item) => !picked.includes(item) && (!wanted || item.name.toLowerCase().includes(wanted)));
  const exact = items.some((item) => item.name.toLowerCase() === wanted) || home.items.some((item) => item.name.toLowerCase() === wanted);

  /* The money: typed prices, the bill total, and what the total leaves over for the rest. */
  const typedPrices = picked.map((item) => (showMoney ? readRupees(price[item.id] ?? "") || null : null));
  const badPrice = showMoney && picked.some((item) => readRupees(price[item.id] ?? "") === false);
  const itemsSum = typedPrices.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const unpriced = picked.filter((_, index) => typedPrices[index] === null);
  const billTyped = isBill ? readRupees(totalText) : null;
  const billTotal = typeof billTyped === "number" ? billTyped : null;
  const weights = picked.map((item) => {
    const count = qtyOf(item);

    return item.avgCost && count ? count * item.avgCost : null;
  });
  const amounts = splitBill(
    billTotal,
    picked.map((_, index) => ({ amount: typedPrices[index]!, weight: weights[index]! })),
  );
  const shareOf = new Map(picked.map((item, index) => [item.id, typedPrices[index] === null ? amounts[index] : null]));
  const total = billTotal ?? itemsSum;
  const gap = billTotal !== null && unpriced.length === 0 ? billTotal - itemsSum : 0;
  const pricesOver = billTotal !== null && unpriced.length > 0 && itemsSum > billTotal;
  const paidPart = readRupees(paidText);
  const paid = !isBill ? 0 : payment === "all" ? total : payment === "none" ? 0 : Math.min(paidPart || 0, total);
  const due = total - paid;
  const shared = billTotal !== null && unpriced.length > 0 && billTotal > itemsSum;
  const totalHint = pricesOver
    ? "Less than the item prices — check them."
    : gap < 0
      ? `Items add up to ${currency(itemsSum)} · ${currency(-gap)} discount`
      : gap > 0
        ? `Items add up to ${currency(itemsSum)} · ${currency(gap)} VAT or extra`
        : shared
          ? `${currency(billTotal - itemsSum)} shared by ${unpriced.map((item) => item.name).join(", ")}${
              unpriced.length < 2 ? "" : weights.every((weight, index) => typedPrices[index] !== null || (weight ?? 0) > 0) ? " by their usual price" : " equally"
            }`
          : billTotal === null && itemsSum > 0
            ? "Blank means the items' prices added up."
            : "Type the bill total, or a price on each item — or both.";

  const kinds: StockEntryKind[] = [
    "BUY",
    "USE",
    "WASTE",
    ...(home.places.length > 1 ? (["SEND"] as const) : []),
    "COUNT",
    ...(home.owner ? (["OPENING"] as const) : []),
  ];

  /** A name that is not an item yet becomes one, kept in the store or used daily as its name says. */
  const addItem = async () => {
    const name = find.trim();

    if (!name) return;

    setAdding(true);
    setError("");

    try {
      const item = await browserApi<{ id: string }>(`${ENDPOINT}/items`, {
        body: JSON.stringify({ kind: guessStockKind(name), name, unit: newUnit }),
        method: "POST",
      });

      await onItemAdded();
      setQty((prev) => ({ ...prev, [item.id]: prev[item.id] ?? "1" }));
      setFind("");
    } catch (addError) {
      setError(errorText(addError, "Could not add that item."));
    } finally {
      setAdding(false);
    }
  };

  const save = async () => {
    const day = parseBsDayInput(bsDate);

    if (picked.length === 0) return setError("Write how much of at least one item.");
    if (picked.some((item) => qtyOf(item) === null || qtyOf(item)! < 0 || (kind !== "COUNT" && qtyOf(item) === 0))) {
      return setError("Check the numbers.");
    }
    if (!day) return setError("Write the Nepali date like 2083-06-15.");
    if (kind === "SEND" && (!toHostelId || toHostelId === hostelId)) return setError("Pick where it goes.");
    if (badPrice || billTyped === false) return setError("Prices are whole rupees.");
    if (pricesOver) return setError("The item prices add up to more than the bill total.");
    if (isBill && total > 0 && payment === "part" && !paidPart) return setError("Write how much was paid.");
    if (isBill && due > 0 && !supplierId) return setError("Pick the supplier who is owed the rest.");
    if (isBill && paid > 0 && home.proofRequired && !photoAssetId) return setError("Add a photo of the bill.");

    const lines = picked.map((item, index) => {
      const count = qtyOf(item)!;
      const value = showMoney ? (amounts[index] ?? 0) : 0;

      return {
        itemId: item.id,
        qty: count,
        ...(value > 0 && kind === "BUY" ? { amount: value } : {}),
        ...(value > 0 && kind === "OPENING" && count > 0 ? { rate: value / count } : {}),
      };
    });

    setSaving(true);
    setError("");

    try {
      // The gap goes as discount / VAT rather than as the total, so a server from before the bill total reads it the same.
      await browserApi(ENDPOINT, {
        body: JSON.stringify({
          billNo: kind === "BUY" ? billNo.trim() || undefined : undefined,
          clientRequestId: requestId,
          discount: isBill && gap < 0 ? -gap : undefined,
          hostelId,
          kind,
          lines,
          note: note.trim() || undefined,
          on: day,
          paid: isBill && total > 0 ? paid : undefined,
          paidBy: isBill && paid > 0 ? paidBy : undefined,
          photoAssetId: kind === "BUY" ? (photoAssetId ?? undefined) : undefined,
          supplierId: kind === "BUY" && supplierId ? supplierId : undefined,
          tax: isBill && gap > 0 ? gap : undefined,
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
            : kind === "BUY" && due > 0
              ? `Bill saved. ${currency(due)} owed to ${home.suppliers.find((supplier) => supplier.id === supplierId)?.name ?? "the supplier"}.`
              : kind === "BUY" && paid > 0
                ? "Bill saved, and the paid amount added to Expenses."
                : `${STOCK_ENTRY_LABELS[kind]} saved.`,
      );
    } catch (saveError) {
      setError(errorText(saveError, "Not saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const row = (item: StockItemRow) => {
    const share = shareOf.get(item.id) ?? null;
    const count = qtyOf(item);
    const money = readRupees(price[item.id] ?? "") || share;
    const at = item.at.find((place) => place.hostelId === hostelId);

    return (
      <li className="flex items-center gap-3 px-3 py-2" key={item.id}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.name}</p>
          <p className="text-xs text-muted-foreground">
            {item.kind === "STORE" && at && !incoming
              ? `${kind === "COUNT" ? "Book says" : "Left"} ${formatQty(leftHere(item), item.unit)}`
              : showMoney && money && count
                ? `${share !== null && !(price[item.id] ?? "").trim() ? "≈ " : ""}${currency(Math.round((money / count) * 100) / 100)}/${STOCK_UNIT_LABELS[item.unit].one}`
                : item.kind === "DAILY"
                  ? "Daily"
                  : "Store"}
          </p>
        </div>
        <input
          aria-label={`${item.name} quantity`}
          className="h-9 w-24 rounded-md border border-border bg-background px-3 text-right text-sm font-semibold tabular-nums"
          inputMode="decimal"
          onChange={(event) => setQty((prev) => ({ ...prev, [item.id]: event.target.value }))}
          placeholder="0"
          value={qty[item.id] ?? ""}
        />
        <span className="w-14 text-xs text-muted-foreground">{STOCK_UNIT_LABELS[item.unit].many}</span>
        {showMoney ? (
          <input
            aria-label={`${item.name} ${kind === "OPENING" ? "value" : "amount"}`}
            className="h-9 w-28 rounded-md border border-border bg-background px-3 text-right text-sm tabular-nums"
            inputMode="numeric"
            onChange={(event) => setPrice((prev) => ({ ...prev, [item.id]: event.target.value }))}
            placeholder={share !== null ? String(share) : kind === "OPENING" ? "Value Rs" : "Rs"}
            value={price[item.id] ?? ""}
          />
        ) : null}
      </li>
    );
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={mode !== null}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{KIND_LABEL[kind]}</DialogTitle>
          <DialogDescription>
            {kind === "BUY"
              ? "Goods that came in. Item prices are optional — the bill total is what counts."
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
          <div className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-muted p-1">
            {kinds.map((option) => (
              <button
                className={cn(
                  "flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium",
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
              <span className="font-medium">{incoming ? "Where did it come?" : kind === "SEND" ? "From" : "Where?"}</span>
              <select className={field} onChange={(event) => setHostelId(event.target.value)} value={hostelId}>
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
                <select className={field} onChange={(event) => setToHostelId(event.target.value)} value={toHostelId}>
                  {home.places
                    .filter((place) => place.id !== hostelId)
                    .map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : kind === "USE" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">For</span>
                <select className={field} onChange={(event) => setUseFor(event.target.value as StockUseFor)} value={useFor}>
                  {STOCK_USE_FOR.map((value) => (
                    <option key={value} value={value}>
                      {STOCK_USE_FOR_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
            ) : kind === "WASTE" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">Why?</span>
                <select
                  className={field}
                  onChange={(event) => setWasteReason(event.target.value as StockWasteReason)}
                  value={wasteReason}
                >
                  {STOCK_WASTE_REASONS.map((value) => (
                    <option key={value} value={value}>
                      {STOCK_WASTE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
            ) : kind === "BUY" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">Supplier</span>
                <select className={field} onChange={(event) => setSupplierId(event.target.value)} value={supplierId}>
                  <option value="">No supplier</option>
                  {home.suppliers
                    .filter((supplier) => supplier.active)
                    .map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                        {supplier.due ? ` · ${currency(supplier.due)} owed` : ""}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {kind === "BUY" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">Bill no. (optional)</span>
                <input className={field} maxLength={40} onChange={(event) => setBillNo(event.target.value)} value={billNo} />
              </label>
            ) : null}
            <label className="space-y-1 text-sm">
              <span className="font-medium">Nepali date</span>
              <input className={field} onChange={(event) => setBsDate(event.target.value)} placeholder="2083-06-15" value={bsDate} />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="relative flex-1">
                <span className="sr-only">Find an item</span>
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className={cn(field, "pl-8")}
                  onChange={(event) => setFind(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && others.length === 1) {
                      event.preventDefault();
                      setQty((prev) => ({ ...prev, [others[0]!.id]: prev[others[0]!.id] || "1" }));
                      setFind("");
                    }
                  }}
                  placeholder={incoming ? "Find an item, or type a new one" : "Find an item"}
                  value={find}
                />
              </label>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {picked.length} item{picked.length === 1 ? "" : "s"}
              </span>
            </div>

            {incoming && wanted && !exact ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  Add <span className="font-semibold">{find.trim()}</span> as a new {guessStockKind(find) === "DAILY" ? "daily" : "store"} item, counted in
                </span>
                <select
                  aria-label="Counted in"
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                  onChange={(event) => setNewUnit(event.target.value as StockUnit)}
                  value={newUnit}
                >
                  {STOCK_UNITS.map((value) => (
                    <option key={value} value={value}>
                      {STOCK_UNIT_LABELS[value].many}
                    </option>
                  ))}
                </select>
                <Button disabled={adding || find.trim().length > STOCK_ITEM_NAME_MAX} onClick={() => void addItem()} size="sm" type="button">
                  {adding ? "Adding…" : "Add"}
                </Button>
              </div>
            ) : null}

            {items.length === 0 && !incoming ? (
              <EmptyState label={kind === "COUNT" ? "No store items to count." : "Add an item first."} />
            ) : (
              <div className="max-h-[42vh] overflow-y-auto rounded-xl border border-border">
                {picked.length > 0 ? <ul className="divide-y divide-border bg-muted/30">{picked.map(row)}</ul> : null}
                {picked.length > 0 && others.length > 0 ? <div className="h-px bg-border" /> : null}
                {others.length > 0 ? <ul className="divide-y divide-border">{others.map(row)}</ul> : null}
                {picked.length === 0 && others.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-muted-foreground">{wanted ? "Nothing called that." : "No items yet — type a name above."}</p>
                ) : null}
              </div>
            )}
          </div>

          {isBill ? (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Bill total</span>
                  <input
                    className={cn(field, "text-right font-semibold tabular-nums", (billTyped === false || pricesOver) && "border-destructive")}
                    inputMode="numeric"
                    onChange={(event) => setTotalText(event.target.value)}
                    placeholder={itemsSum > 0 ? String(itemsSum) : "Rs 0"}
                    value={totalText}
                  />
                  <span className={cn("block text-xs", pricesOver ? "text-destructive" : "text-muted-foreground")}>{totalHint}</span>
                </label>
                {total > 0 ? (
                  <div className="space-y-1 text-sm">
                    <span className="font-medium">Paid</span>
                    <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
                      {(
                        [
                          ["all", "Paid all"],
                          ["part", "Part"],
                          ["none", "Not paid"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          className={cn(
                            "flex-1 rounded-md px-2 py-1 text-sm font-medium",
                            payment === value ? "bg-background shadow-sm" : "text-muted-foreground",
                          )}
                          key={value}
                          onClick={() => setPayment(value)}
                          type="button"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {total > 0 ? (
                <div className="flex flex-wrap items-end gap-3">
                  {payment === "part" ? (
                    <label className="space-y-1 text-sm">
                      <span className="block font-medium">Paid now</span>
                      <input
                        className="h-9 w-36 rounded-md border border-border bg-background px-3 text-right text-sm tabular-nums"
                        inputMode="numeric"
                        onChange={(event) => setPaidText(event.target.value)}
                        placeholder="Rs"
                        value={paidText}
                      />
                    </label>
                  ) : null}
                  {paid > 0 ? (
                    <label className="space-y-1 text-sm">
                      <span className="block font-medium">Paid by</span>
                      <select
                        className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                        onChange={(event) => setPaidBy(event.target.value as ExpensePaidBy)}
                        value={paidBy}
                      >
                        {EXPENSE_PAID_BY.map((value) => (
                          <option key={value} value={value}>
                            {EXPENSE_PAID_BY_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {due > 0 ? (
                    <p className="ml-auto rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      {currency(due)} owed{supplierId ? ` to ${home.suppliers.find((supplier) => supplier.id === supplierId)?.name ?? "them"}` : " — pick the supplier"}
                    </p>
                  ) : null}
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
                  {uploading ? "Adding photo…" : photoAssetId ? "Photo added" : home.proofRequired && paid > 0 ? "Photo needed" : "Photo optional"}
                </span>
              </div>
            </div>
          ) : null}

          <label className="block space-y-1 text-sm">
            <span className="font-medium">{kind === "COUNT" ? "Why different? (needed if it is)" : "Note (optional)"}</span>
            <input className={field} maxLength={200} onChange={(event) => setNote(event.target.value)} value={note} />
          </label>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
          <Button disabled={saving || uploading || adding} onClick={() => void save()}>
            {saving ? "Saving…" : isBill && total > 0 ? `Save bill · ${currency(total)}` : "Save"}
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
  const [category, setCategory] = useState<string>("GROCERIES");
  const [lowAt, setLowAt] = useState("");
  const [packUnit, setPackUnit] = useState<StockUnit | "">("");
  const [packSize, setPackSize] = useState("");
  const [active, setActive] = useState(true);
  const [seen, setSeen] = useState<typeof item>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  if (item !== seen) {
    setSeen(item);
    setName(editing?.name ?? "");
    setKind(editing?.kind ?? "STORE");
    setUnit(editing?.unit ?? "KG");
    setCategory(editing?.category ?? "GROCERIES");
    setLowAt(editing?.lowAt != null ? String(editing.lowAt) : "");
    setPackUnit(editing?.packUnit ?? "");
    setPackSize(editing?.packSize != null ? String(editing.packSize) : "");
    setActive(editing?.active ?? true);
    setError("");
  }

  const save = async () => {
    const low = lowAt.trim() ? Number(lowAt) : null;
    const size = packSize.trim() ? Number(packSize) : null;

    if (!name.trim()) return setError("Name it, like Rice.");
    if (low !== null && (!Number.isFinite(low) || low < 0)) return setError("Check the low mark.");
    if (packUnit && (size === null || !Number.isFinite(size) || size <= 0)) return setError("Write how many are in one pack.");

    setSaving(true);

    try {
      const body = {
        category,
        kind,
        lowAt: kind === "STORE" ? low : null,
        name: name.trim(),
        packSize: packUnit ? size : null,
        packUnit: packUnit || null,
        unit,
      };

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
            <input
              className={field}
              maxLength={STOCK_ITEM_NAME_MAX}
              onChange={(event) => {
                setName(event.target.value);
                if (!editing) setKind(guessStockKind(event.target.value));
              }}
              placeholder="e.g. Rice"
              value={name}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Kind</span>
              <select className={field} onChange={(event) => setKind(event.target.value as StockKind)} value={kind}>
                <option value="STORE">Store · long use</option>
                <option value="DAILY">Daily · used same day</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Counted in</span>
              <select className={field} onChange={(event) => setUnit(event.target.value as StockUnit)} value={unit}>
                {STOCK_UNITS.map((value) => (
                  <option key={value} value={value}>
                    {STOCK_UNIT_LABELS[value].many}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Expense group</span>
              <select className={field} onChange={(event) => setCategory(event.target.value)} value={category}>
                {STOCK_EXPENSE_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {categoryLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            {kind === "STORE" ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">Running low below</span>
                <input className={field} inputMode="decimal" onChange={(event) => setLowAt(event.target.value)} placeholder="Optional" value={lowAt} />
              </label>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Bought in packs</span>
              <select className={field} onChange={(event) => setPackUnit(event.target.value as StockUnit | "")} value={packUnit}>
                <option value="">No</option>
                {STOCK_UNITS.filter((value) => value !== unit).map((value) => (
                  <option key={value} value={value}>
                    {STOCK_UNIT_LABELS[value].many}
                  </option>
                ))}
              </select>
            </label>
            {packUnit ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium">
                  1 {STOCK_UNIT_LABELS[packUnit].one} = ? {STOCK_UNIT_LABELS[unit].many}
                </span>
                <input className={field} inputMode="decimal" onChange={(event) => setPackSize(event.target.value)} placeholder="e.g. 25" value={packSize} />
              </label>
            ) : null}
          </div>
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
        <Button
          onClick={() => {
            setError("");
            setAdding(true);
          }}
          size="sm"
          variant="outline"
        >
          <Plus />
          New supplier
        </Button>
      }
      description={home.money ? "Bills not fully paid stay here until you pay them." : "The shops you buy from."}
      icon={Store}
      title="Suppliers"
    >
      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New supplier</DialogTitle>
            <DialogDescription>Pick them on a bill later.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <input className={cn(input, "h-10 w-full rounded-xl")} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Shop or person" value={name} />
            <div className="grid grid-cols-2 gap-2">
              <input className={cn(input, "h-10 rounded-xl")} maxLength={20} onChange={(event) => setPhone(event.target.value)} placeholder="Phone" value={phone} />
              {home.owner ? (
                <input
                  className={cn(input, "h-10 rounded-xl")}
                  inputMode="numeric"
                  onChange={(event) => setOwedText(event.target.value)}
                  placeholder="Already owed Rs"
                  value={owedText}
                />
              ) : null}
            </div>
          </div>
          {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button className="bg-brand-teal text-white hover:bg-brand-teal/90" disabled={busy} onClick={() => void add()}>
              Add supplier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && !paying && !adding ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}

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

/* ------------------------------------------------------------------- Usage */

const USAGE_RANGES: { label: string; value: StockUsageRange }[] = [
  { label: "Today", value: "today" },
  { label: "7 days", value: "week" },
  { label: "This month", value: "month" },
];

/**
 * How much of each thing was used — today, the last seven days, this month —
 * per building, with how much of it the kitchen entered. Daily items count as
 * used the day they came.
 */
function UsageCard() {
  const [range, setRange] = useState<StockUsageRange>("today");
  const resource = usePortalResource<StockUsage>(`${ENDPOINT}/usage?range=${range}`, {
    errorMessage: "Could not load usage.",
  });
  const usage = resource.data ?? null;

  const rows = useMemo(() => {
    if (!usage) return [];

    const items = new Map(usage.items.map((item) => [item.id, item]));
    const byItem = new Map<
      string,
      { byCook: number; byPlace: Map<string, number>; item: StockUsage["items"][number]; used: number; wasted: number }
    >();

    for (const row of usage.rows) {
      const item = items.get(row.itemId);

      if (!item) continue;

      const total = byItem.get(row.itemId) ?? { byCook: 0, byPlace: new Map(), item, used: 0, wasted: 0 };

      total.used += row.used;
      total.wasted += row.wasted;
      total.byCook += row.byCook;
      total.byPlace.set(row.hostelId, (total.byPlace.get(row.hostelId) ?? 0) + row.used);
      byItem.set(row.itemId, total);
    }

    return [...byItem.values()].sort(
      (a, b) =>
        (b.used + b.wasted) * (b.item.avgCost ?? 0) - (a.used + a.wasted) * (a.item.avgCost ?? 0) ||
        a.item.name.localeCompare(b.item.name),
    );
  }, [usage]);

  return (
    <SectionCard
      actions={
        <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
          {USAGE_RANGES.map((option) => (
            <button
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium",
                range === option.value ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
              key={option.value}
              onClick={() => setRange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      }
      description={
        usage?.money && usage.value
          ? `Worth about ${currency(usage.value)}, at average cost.`
          : "What left the store, and how much of it the kitchen entered."
      }
      icon={UtensilsCrossed}
      title="Used"
    >
      {!usage ? (
        resource.state === "error" ? (
          <p className="text-sm text-muted-foreground">{resource.message}</p>
        ) : (
          <LoadingRows />
        )
      ) : rows.length === 0 ? (
        <EmptyState label="Nothing used yet. When the cook taps Kitchen inventory, or you click Use, it shows here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Item</th>
                {usage.places.length > 1
                  ? usage.places.map((place) => (
                      <th className="py-2 pr-3 text-right font-medium" key={place.id}>
                        {place.name}
                      </th>
                    ))
                  : null}
                <th className="py-2 pr-3 text-right font-medium">Used</th>
                <th className="py-2 pr-3 text-right font-medium">By kitchen</th>
                <th className="py-2 text-right font-medium">Thrown away</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.item.id}>
                  <td className="py-2.5 pr-3">
                    <p className="font-medium">{row.item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.item.kind === "DAILY" ? "Daily · used the day it came" : "Store"}
                    </p>
                  </td>
                  {usage.places.length > 1
                    ? usage.places.map((place) => (
                        <td className="py-2.5 pr-3 text-right" key={place.id}>
                          {formatQty(row.byPlace.get(place.id) ?? 0, row.item.unit)}
                        </td>
                      ))
                    : null}
                  <td className="py-2.5 pr-3 text-right font-semibold">{formatQty(row.used, row.item.unit)}</td>
                  <td className="py-2.5 pr-3 text-right">{row.byCook > 0 ? formatQty(row.byCook, row.item.unit) : "—"}</td>
                  <td className={cn("py-2.5 text-right", row.wasted > 0 && "text-destructive")}>
                    {row.wasted > 0 ? formatQty(row.wasted, row.item.unit) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ Report */

const REPORT_RANGES: { label: string; value: StockReportRange }[] = [
  { label: "This month", value: "month" },
  { label: "3 months", value: "quarter" },
  { label: "Year", value: "year" },
];

/** Per item bought · used · left over a range, and next month at that pace (D2). Same table as the PDF/CSV. */
function ReportCard() {
  const [range, setRange] = useState<StockReportRange>("month");
  const resource = usePortalResource<StockReport>(`${ENDPOINT}/report?range=${range}`, {
    errorMessage: "Could not load the report.",
  });
  const report = resource.data ?? null;
  const save = (format: TableFormat) =>
    void downloadFile({
      fileName: `stock-report-${range}.${format}`,
      label: "Inventory report",
      url: `${ENDPOINT}/report?range=${range}&format=${format}`,
    });

  return (
    <SectionCard
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
            {REPORT_RANGES.map((option) => (
              <button
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium",
                  range === option.value ? "bg-background shadow-sm" : "text-muted-foreground",
                )}
                key={option.value}
                onClick={() => setRange(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button disabled={!report?.items.length} onClick={() => save("pdf")} size="sm" variant="outline">
            <Download className="size-4" />
            PDF
          </Button>
          <Button disabled={!report?.items.length} onClick={() => save("csv")} size="sm" variant="outline">
            <Download className="size-4" />
            CSV
          </Button>
        </div>
      }
      description={
        report?.totals
          ? `Next month ${currency(report.totals.nextValue)} · bought ${currency(report.totals.boughtValue)} · ${report.costPerResidentDay !== null ? `${currency(report.costPerResidentDay)} per student a day` : `${report.days} days`}`
          : "Bought, used and left per item."
      }
      icon={BarChart3}
      title="Inventory report"
    >
      {!report || report.range !== range ? (
        resource.state === "error" ? <p className="text-sm text-muted-foreground">{resource.message}</p> : <LoadingRows />
      ) : report.items.length === 0 ? (
        <EmptyState label="Nothing bought or used in this range." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Item</th>
                <th className="py-2 pr-3 text-right font-medium">Bought</th>
                <th className="py-2 pr-3 text-right font-medium">Used</th>
                <th className="py-2 pr-3 text-right font-medium">Wasted</th>
                <th className="py-2 pr-3 text-right font-medium">Left</th>
                <th className="py-2 pr-3 text-right font-medium">Next month</th>
                <th className="py-2 text-right font-medium">Rs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-2.5 pr-3 font-medium">{item.name}</td>
                  <td className="py-2.5 pr-3 text-right">{formatQty(item.bought, item.unit)}</td>
                  <td className="py-2.5 pr-3 text-right">{formatQty(item.used, item.unit)}</td>
                  <td className={cn("py-2.5 pr-3 text-right", item.wasted > 0 && "text-destructive")}>
                    {item.wasted > 0 ? formatQty(item.wasted, item.unit) : "—"}
                  </td>
                  <td className="py-2.5 pr-3 text-right">{item.left !== null ? formatQty(item.left, item.unit) : "—"}</td>
                  <td className="py-2.5 pr-3 text-right font-semibold">{formatQty(item.nextQty, item.unit)}</td>
                  <td className="py-2.5 text-right">{item.nextValue !== null ? currency(item.nextValue) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
