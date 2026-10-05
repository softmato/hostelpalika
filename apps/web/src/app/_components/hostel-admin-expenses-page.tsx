"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  ChevronLeft,
  ChevronRight,
  Droplets,
  Flame,
  HandCoins,
  ImageIcon,
  Leaf,
  type LucideIcon,
  MoreHorizontal,
  Plus,
  ShoppingBasket,
  Sparkles,
  Tag,
  Users,
  Wallet,
  Wifi,
  Wrench,
  Zap,
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
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  EXPENSE_WHAT_MAX,
  type ExpenseCategoryKey,
  type ExpenseCategoryValue,
  type ExpensePaidBy,
} from "@hostel/shared/expenses/categories";
import {
  parseAmountInput,
  parseBsDayInput,
  toBsDayInput,
  todayKey,
} from "@hostel/shared/expenses/input";

import { EmptyState, LoadingRows, currency } from "./shared-ui";
import { MetricCard, PortalPageHeader, SectionCard } from "./portal-dashboard-ui";

/**
 * Expenses — Money Out on the web (docs/EXPENSES_PLAN.md §3.5).
 *
 * The owner's desk view of what the app shows on a phone: the month's *In ·
 * Out · Left*, where the money went, and every row anyone added, with the add
 * form one click away. Same API as the app, so a warden opening this page sees
 * only their own rows — the server never sends them the totals.
 *
 * Dates are Bikram Sambat throughout, as the owner asked: today's is filled in
 * and can be changed by typing the Nepali date.
 */

const ENDPOINT = "/api/v1/hostel-admin/expenses";

type Row = {
  amount: number;
  cashNote: string | null;
  cashStatus: "ACCEPTED" | "DECLINED" | "PENDING" | null;
  cashTo: { name: string; userId: string } | null;
  category: ExpenseCategoryValue;
  categoryLabel: string;
  customCategoryId: string | null;
  id: string;
  mine: boolean;
  paidBy: ExpensePaidBy;
  photoAssetId: string | null;
  recordedBy: { id: string; name: string; role: string };
  salaryFor: { name: string; userId: string | null } | null;
  spentOn: string;
  status: "RECORDED" | "VOID";
  voidReason: string | null;
  what: string;
};

type Home = {
  canSeeTotals: boolean;
  categories: { hidden: boolean; id: string; name: string }[];
  currentPeriod: string;
  expenses: Row[];
  mine: { count: number; out: number };
  pendingCash: Row[];
  people: { holdsCash: boolean; name: string; role: string; userId: string }[];
  period: string;
  proofRequired: boolean;
  wallet: Wallet | null;
  wallets: Wallet[] | null;
  totals: {
    byCategory: {
      amount: number;
      category: ExpenseCategoryValue;
      customCategoryId: string | null;
      label: string;
    }[];
    in: number;
    lastMonthOut: number;
    left: number;
    out: number;
    staffCount: number;
  } | null;
};

/** A warden's cash box — see `StaffWallet` in expense.service.ts. */
type Wallet = { given: number; left: number; name: string; pending: number; spent: number; userId: string };

const CASH_STATE: Record<NonNullable<Row["cashStatus"]>, string> = {
  ACCEPTED: "Got it",
  DECLINED: "Not received",
  PENDING: "Waiting",
};

const ICONS: Record<ExpenseCategoryKey, LucideIcon> = {
  CLEANING: Sparkles,
  ELECTRICITY: Zap,
  GAS: Flame,
  GROCERIES: ShoppingBasket,
  INTERNET: Wifi,
  OTHER: MoreHorizontal,
  RENT: Building2,
  REPAIR: Wrench,
  SALARY: Users,
  STAFF_CASH: HandCoins,
  VEGETABLES_MEAT: Leaf,
  WATER: Droplets,
};

function iconFor(category: ExpenseCategoryValue): LucideIcon {
  return category === "CUSTOM" ? Tag : ICONS[category];
}

function dayOf(key: string) {
  return new Date(`${key}T00:00:00.000Z`);
}

function periodLabel(period: string) {
  return formatBsPeriod(period) || period;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A fresh id per Save, so a retried request returns the row it already made. */
function newRequestId() {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function Glyph({ icon: Icon, muted = false }: { icon: LucideIcon; muted?: boolean }) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg",
        muted ? "bg-muted text-muted-foreground" : "bg-brand-teal-soft text-brand-teal",
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

export const HostelAdminExpensesPageContent = memo(function HostelAdminExpensesPageContent() {
  const [period, setPeriod] = useState<string | null>(null);
  const url = period ? `${ENDPOINT}?period=${period}` : ENDPOINT;
  const resource = usePortalResource<Home>(url, { errorMessage: "Could not load expenses." });
  const home = resource.data ?? null;
  const owner = home?.canSeeTotals === true;

  const [adding, setAdding] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [message, setMessage] = useState("");
  const [newCategory, setNewCategory] = useState("");

  const days = useMemo(() => {
    const groups = new Map<string, { rows: Row[]; total: number }>();

    for (const row of home?.expenses ?? []) {
      const group = groups.get(row.spentOn) ?? { rows: [], total: 0 };

      group.rows.push(row);
      if (row.status === "RECORDED") group.total += row.amount;
      groups.set(row.spentOn, group);
    }

    return [...groups.entries()].sort(([a], [b]) => (a < b ? 1 : -1));
  }, [home]);

  const atCurrent = !home || home.period === home.currentPeriod;

  const step = (delta: number) => {
    if (!home) return;

    const next = addBsMonths(home.period, delta);

    setPeriod(next === home.currentPeriod ? null : next);
  };

  const cancel = useCallback(
    async (id: string) => {
      if (cancelReason.trim().length < 3) {
        setMessage("Write why you are cancelling it — a few words.");
        return;
      }

      try {
        await browserApi(`${ENDPOINT}/${id}/void`, {
          body: JSON.stringify({ reason: cancelReason.trim() }),
          method: "POST",
        });
        setCancelId(null);
        setCancelReason("");
        setMessage("Expense cancelled.");
        await resource.refreshAsync();
      } catch (error) {
        setMessage(errorText(error, "Could not cancel it."));
      }
    },
    [cancelReason, resource],
  );

  const addCategory = useCallback(async () => {
    const name = newCategory.trim();

    if (name.length < 2) return;

    try {
      await browserApi(`${ENDPOINT}/categories`, { body: JSON.stringify({ name }), method: "POST" });
      setNewCategory("");
      await resource.refreshAsync();
    } catch (error) {
      setMessage(errorText(error, "Could not add the category."));
    }
  }, [newCategory, resource]);

  const answerCash = useCallback(
    async (id: string, accept: boolean) => {
      try {
        await browserApi(`${ENDPOINT}/${id}/cash`, {
          body: JSON.stringify({ accept }),
          method: "POST",
        });
        setMessage(accept ? "Added to your cash." : "The owner is told it did not reach you.");
        await resource.refreshAsync();
      } catch (error) {
        setMessage(errorText(error, "Could not save your answer."));
      }
    },
    [resource],
  );

  const toggleCategory = useCallback(
    async (id: string, hidden: boolean) => {
      try {
        await browserApi(`${ENDPOINT}/categories/${id}`, {
          body: JSON.stringify({ hidden }),
          method: "PATCH",
        });
        await resource.refreshAsync();
      } catch (error) {
        setMessage(errorText(error, "Could not change the category."));
      }
    },
    [resource],
  );

  const monthSwitcher = (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
      <Button aria-label="Previous month" onClick={() => step(-1)} size="icon-sm" variant="ghost">
        <ChevronLeft />
      </Button>
      <span className="min-w-28 text-center text-sm font-semibold">
        {home ? periodLabel(home.period) : "…"}
      </span>
      <Button
        aria-label="Next month"
        disabled={atCurrent}
        onClick={() => step(1)}
        size="icon-sm"
        variant="ghost"
      >
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
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add expense
            </Button>
          </div>
        }
        breadcrumb={["Finance", "Expenses"]}
        description={
          owner
            ? "Money spent for the hostel, by day and by category, beside the money that came in."
            : "Money you spent for the hostel. Only you and the owner see these."
        }
        title="Expenses"
      />

      {message ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">{message}</div>
      ) : null}

      {resource.state === "error" ? (
        <SectionCard>
          <p className="text-sm text-muted-foreground">{resource.message}</p>
        </SectionCard>
      ) : null}

      {home?.totals ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={ArrowDownRight} label="Money In" tone="green" value={currency(home.totals.in)} />
          <MetricCard
            icon={ArrowUpRight}
            label="Money Out"
            note={
              home.totals.lastMonthOut > 0
                ? `Last month ${currency(home.totals.lastMonthOut)}`
                : undefined
            }
            tone="rose"
            value={currency(home.totals.out)}
          />
          <MetricCard
            icon={Wallet}
            label="Left"
            tone={home.totals.left < 0 ? "rose" : "teal"}
            value={currency(home.totals.left)}
          />
        </div>
      ) : home ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {home.wallet ? (
            <MetricCard
              icon={HandCoins}
              label={home.wallet.left < 0 ? "Hostel owes you" : "Cash left"}
              note={`Got ${currency(home.wallet.given)} · Spent ${currency(home.wallet.spent)}`}
              tone={home.wallet.left < 0 ? "rose" : "green"}
              value={currency(Math.abs(home.wallet.left))}
            />
          ) : null}
          <MetricCard
            icon={ArrowUpRight}
            label="You spent"
            note={home.mine.count === 1 ? "1 expense" : `${home.mine.count} expenses`}
            tone="rose"
            value={currency(home.mine.out)}
          />
        </div>
      ) : null}

      {home && !owner && home.pendingCash.length > 0 ? (
        <SectionCard title="Cash for you">
          <ul className="divide-y divide-border/70">
            {home.pendingCash.map((row) => (
              <li className="flex flex-wrap items-center gap-3 py-2.5" key={row.id}>
                <Glyph icon={HandCoins} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold tabular-nums">{currency(row.amount)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[formatBsDate(dayOf(row.spentOn)), EXPENSE_PAID_BY_LABELS[row.paidBy], row.what]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button onClick={() => void answerCash(row.id, true)} size="sm">
                  Got it
                </Button>
                <Button onClick={() => void answerCash(row.id, false)} size="sm" variant="ghost">
                  Not received
                </Button>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <div className={cn("grid gap-4", owner && "lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]")}>
        {owner && home?.totals ? (
          <div className="space-y-4">
            {home.wallets && home.wallets.length > 0 ? (
              <SectionCard title="Staff cash">
                <ul className="space-y-3">
                  {home.wallets.map((wallet) => (
                    <li className="flex items-center gap-3 text-sm" key={wallet.userId}>
                      <Glyph icon={HandCoins} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{wallet.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[
                            `Spent ${currency(wallet.spent)} of ${currency(wallet.given)}`,
                            wallet.pending > 0 ? `${currency(wallet.pending)} waiting` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "text-right font-semibold tabular-nums",
                          wallet.left < 0 ? "text-destructive" : "text-primary",
                        )}
                      >
                        {currency(Math.abs(wallet.left))}
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {wallet.left < 0 ? "Hostel owes" : "Left"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}

            <SectionCard title="Spent on">
              {home.totals.byCategory.length === 0 ? (
                <EmptyState label="Nothing spent this month yet." />
              ) : (
                <ul className="space-y-3">
                  {home.totals.byCategory.map((row) => {
                    const percent =
                      home.totals!.out > 0 ? Math.round((row.amount / home.totals!.out) * 100) : 0;

                    return (
                      <li className="space-y-1.5" key={`${row.category}:${row.customCategoryId ?? ""}`}>
                        <div className="flex items-center gap-2 text-sm">
                          <Glyph icon={iconFor(row.category)} />
                          <span className="flex-1 truncate font-medium">{row.label}</span>
                          <span className="text-xs text-muted-foreground">{percent}%</span>
                          <span className="font-semibold tabular-nums">{currency(row.amount)}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>

            <SectionCard
              description="Your own tiles on Add expense. Hiding one keeps its old expenses."
              title="Your categories"
            >
              <div className="space-y-2">
                {home.categories.map((category) => (
                  <div className="flex items-center gap-2 text-sm" key={category.id}>
                    <Glyph icon={Tag} muted={category.hidden} />
                    <span className={cn("flex-1", category.hidden && "text-muted-foreground line-through")}>
                      {category.name}
                    </span>
                    <Button
                      onClick={() => void toggleCategory(category.id, !category.hidden)}
                      size="sm"
                      variant="ghost"
                    >
                      {category.hidden ? "Show" : "Hide"}
                    </Button>
                  </div>
                ))}
                <form
                  className="flex gap-2 pt-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addCategory();
                  }}
                >
                  <input
                    aria-label="New category name"
                    className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                    maxLength={32}
                    onChange={(event) => setNewCategory(event.target.value)}
                    placeholder="e.g. Printing"
                    value={newCategory}
                  />
                  <Button disabled={newCategory.trim().length < 2} type="submit" variant="outline">
                    Add
                  </Button>
                </form>
              </div>
            </SectionCard>
          </div>
        ) : null}

        <SectionCard title={owner ? "Every expense" : "Your expenses"}>
          {resource.state === "loading" ? <LoadingRows /> : null}

          {home && home.expenses.length === 0 ? (
            <EmptyState
              label={
                atCurrent
                  ? "No expenses yet this month. Use Add expense when you buy something for the hostel."
                  : "Nothing was added in this month."
              }
            />
          ) : null}

          <div className="space-y-5">
            {days.map(([key, group]) => (
              <div className="space-y-2" key={key}>
                <div className="flex items-end justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>{key === todayKey() ? `Today · ${formatBsDate(dayOf(key))}` : formatBsDate(dayOf(key))}</span>
                  <span>{currency(group.total)}</span>
                </div>

                <ul className="divide-y divide-border/70 rounded-xl border border-border">
                  {group.rows.map((row) => {
                    const cancelled = row.status === "VOID";
                    const canCancel = !cancelled && (owner || row.mine);

                    return (
                      <li className="space-y-2 px-3 py-2.5" key={row.id}>
                        <div className="flex items-center gap-3">
                          <Glyph icon={iconFor(row.category)} muted={cancelled} />
                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                "truncate text-sm font-semibold",
                                cancelled && "text-muted-foreground line-through",
                              )}
                            >
                              {row.cashTo ? `Cash to ${row.cashTo.name}` : row.what || row.categoryLabel}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {cancelled
                                ? `Cancelled${row.voidReason ? ` — ${row.voidReason}` : ""}`
                                : [
                                    row.cashStatus ? CASH_STATE[row.cashStatus] : null,
                                    row.cashStatus === "DECLINED" ? row.cashNote : null,
                                    row.what && !row.cashTo ? row.categoryLabel : null,
                                    row.salaryFor ? `For ${row.salaryFor.name}` : null,
                                    owner && !row.mine ? row.recordedBy.name || "Staff" : null,
                                    EXPENSE_PAID_BY_LABELS[row.paidBy],
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </p>
                          </div>
                          {row.photoAssetId ? (
                            <a
                              aria-label="Open the bill photo"
                              className="text-muted-foreground hover:text-foreground"
                              href={`/api/v1/files/${row.photoAssetId}/url`}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <ImageIcon className="size-4" />
                            </a>
                          ) : null}
                          <span
                            className={cn(
                              "text-sm font-semibold tabular-nums",
                              cancelled ? "text-muted-foreground" : row.cashTo ? "text-foreground" : "text-destructive",
                            )}
                          >
                            {currency(row.amount)}
                          </span>
                          {canCancel && cancelId !== row.id ? (
                            <Button onClick={() => setCancelId(row.id)} size="sm" variant="ghost">
                              Cancel
                            </Button>
                          ) : null}
                        </div>

                        {cancelId === row.id ? (
                          <div className="flex flex-wrap items-center gap-2 pl-12">
                            <input
                              aria-label="Why cancel it?"
                              autoFocus
                              className="h-9 min-w-48 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                              onChange={(event) => setCancelReason(event.target.value)}
                              placeholder="Why? e.g. Wrong amount"
                              value={cancelReason}
                            />
                            <Button onClick={() => void cancel(row.id)} size="sm" variant="destructive">
                              Cancel expense
                            </Button>
                            <Button
                              onClick={() => {
                                setCancelId(null);
                                setCancelReason("");
                              }}
                              size="sm"
                              variant="ghost"
                            >
                              Keep it
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <AddExpenseDialog
        categories={(home?.categories ?? []).filter((category) => !category.hidden)}
        onClose={() => setAdding(false)}
        onSaved={async (note) => {
          setAdding(false);
          setMessage(note);
          setPeriod(null);
          await resource.refreshAsync();
        }}
        open={adding}
        owner={owner}
        people={home?.people ?? []}
        proofRequired={home?.proofRequired ?? false}
      />
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Add expense                                                                */
/* -------------------------------------------------------------------------- */

type Choice = { category: ExpenseCategoryValue; customCategoryId?: string };

function AddExpenseDialog({
  categories,
  onClose,
  onSaved,
  open,
  owner,
  people,
  proofRequired,
}: {
  categories: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (note: string) => Promise<void>;
  open: boolean;
  owner: boolean;
  people: { holdsCash: boolean; name: string; userId: string }[];
  proofRequired: boolean;
}) {
  const [amountText, setAmountText] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [what, setWhat] = useState("");
  const [bsDate, setBsDate] = useState(() => toBsDayInput(todayKey()));
  const [paidBy, setPaidBy] = useState<ExpensePaidBy>("CASH");
  const [salaryFor, setSalaryFor] = useState("");
  const [cashTo, setCashTo] = useState("");
  const [photoAssetId, setPhotoAssetId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** One id per expense, kept across retries: a Save that timed out but landed is not saved twice. */
  const [requestId, setRequestId] = useState(newRequestId);

  const amount = parseAmountInput(amountText);
  const day = parseBsDayInput(bsDate);
  const today = todayKey();

  const reset = () => {
    setAmountText("");
    setChoice(null);
    setWhat("");
    setBsDate(toBsDayInput(todayKey()));
    setPaidBy("CASH");
    setSalaryFor("");
    setCashTo("");
    setPhotoAssetId(null);
    setError("");
    setRequestId(newRequestId());
  };

  // A draft reopened later may be edited into a different expense, so it gets a new id.
  const close = () => {
    setRequestId(newRequestId());
    onClose();
  };

  const save = async () => {
    if (amount === null) return setError("Write how much you paid, in whole rupees.");
    if (!choice) return setError("Pick what it was for.");
    if (choice.category === "OTHER" && !what.trim()) return setError("Write what it was for.");
    if (!day) return setError("Write the Nepali date like 2083-06-15.");
    if (day > today) return setError("This day has not come yet.");
    if (choice.category === "STAFF_CASH" && !cashTo) return setError("Pick the warden.");
    if (proofRequired && !photoAssetId) return setError("Add a photo of the bill or the goods.");

    // The list fills in a name, so a picked person is found by name.
    const typed = salaryFor.trim();
    const person = people.find((entry) => entry.name.toLowerCase() === typed.toLowerCase());

    setSaving(true);
    setError("");

    try {
      await browserApi(ENDPOINT, {
        body: JSON.stringify({
          amount,
          category: choice.category,
          clientRequestId: requestId,
          customCategoryId: choice.customCategoryId,
          paidBy,
          photoAssetId: photoAssetId ?? undefined,
          salaryFor:
            choice.category === "SALARY" && typed
              ? person
                ? { name: person.name, userId: person.userId }
                : { name: typed }
              : undefined,
          cashTo: choice.category === "STAFF_CASH" ? { userId: cashTo } : undefined,
          spentOn: day,
          what: what.trim() || undefined,
        }),
        method: "POST",
      });
      reset();
      await onSaved(`Expense added: ${currency(amount)}.`);
    } catch (caught) {
      setError(errorText(caught, "Not saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const tiles: { choice: Choice; icon: LucideIcon; key: string; label: string }[] = [
    // Only the owner hands cash to a warden.
    ...EXPENSE_CATEGORY_KEYS.filter((key) => owner || key !== "STAFF_CASH").map((key) => ({
      choice: { category: key } as Choice,
      icon: ICONS[key],
      key,
      label: EXPENSE_CATEGORY_LABELS[key],
    })),
    ...categories.map((category) => ({
      choice: { category: "CUSTOM", customCategoryId: category.id } as Choice,
      icon: Tag,
      key: `custom:${category.id}`,
      label: category.name,
    })),
  ];

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : close())} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add expense</DialogTitle>
          <DialogDescription>How much, and what for. The rest is already filled in.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">How much did you pay?</span>
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 focus-within:border-primary">
              <span className="text-lg font-semibold text-muted-foreground">Rs</span>
              <input
                autoFocus
                className="h-12 flex-1 bg-transparent text-2xl font-bold tabular-nums outline-none"
                inputMode="numeric"
                onChange={(event) => setAmountText(event.target.value)}
                placeholder="0"
                value={amountText}
              />
            </div>
          </label>

          <div className="space-y-1.5">
            <span className="text-sm font-semibold">Spent on</span>
            <div className="grid grid-cols-4 gap-2">
              {tiles.map((tile) => {
                const Icon = tile.icon;
                const on =
                  choice?.category === tile.choice.category &&
                  choice?.customCategoryId === tile.choice.customCategoryId;

                return (
                  <button
                    aria-pressed={on}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-xl border p-2 text-center text-[11px] font-medium transition",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
                    )}
                    key={tile.key}
                    onClick={() => setChoice(tile.choice)}
                    type="button"
                  >
                    <Icon className="size-5" />
                    <span className="line-clamp-2">{tile.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {choice?.category === "STAFF_CASH" ? (
            <div className="space-y-1.5">
              <span className="text-sm font-semibold">Which warden?</span>
              <div className="flex flex-wrap gap-1.5">
                {people
                  .filter((person) => person.holdsCash)
                  .map((person) => (
                    <button
                      aria-pressed={cashTo === person.userId}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-semibold",
                        cashTo === person.userId
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border hover:bg-muted",
                      )}
                      key={person.userId}
                      onClick={() => setCashTo(person.userId)}
                      type="button"
                    >
                      {person.name}
                    </button>
                  ))}
              </div>
              {people.every((person) => !person.holdsCash) ? (
                <span className="block text-xs text-muted-foreground">
                  No warden here has Add expenses turned on.
                </span>
              ) : null}
            </div>
          ) : null}

          {choice?.category === "SALARY" ? (
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold">Whose salary?</span>
              <input
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                list="expense-people"
                onChange={(event) => setSalaryFor(event.target.value)}
                placeholder="Pick or type a name"
                value={salaryFor}
              />
              <datalist id="expense-people">
                {people.map((person) => (
                  <option key={person.userId} value={person.name} />
                ))}
              </datalist>
            </label>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">
              What was it?{choice?.category === "OTHER" ? "" : " (optional)"}
            </span>
            <input
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              maxLength={EXPENSE_WHAT_MAX}
              onChange={(event) => setWhat(event.target.value)}
              placeholder="e.g. Rice 25 kg"
              value={what}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold">Date (Nepali)</span>
              <input
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm tabular-nums outline-none focus:border-primary"
                onChange={(event) => setBsDate(event.target.value)}
                placeholder="2083-06-15"
                value={bsDate}
              />
              <span className="block text-xs text-muted-foreground">
                {day ? formatBsDate(dayOf(day)) : "Year-month-day, like 2083-06-15"}
              </span>
            </label>

            <div className="space-y-1.5">
              <span className="text-sm font-semibold">Paid by</span>
              <div className="flex flex-wrap gap-1.5">
                {EXPENSE_PAID_BY.map((method) => (
                  <button
                    aria-pressed={paidBy === method}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-semibold",
                      paidBy === method
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-muted",
                    )}
                    key={method}
                    onClick={() => setPaidBy(method)}
                    type="button"
                  >
                    {EXPENSE_PAID_BY_LABELS[method]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">
              {choice?.category === "STAFF_CASH"
                ? "Receipt (optional)"
                : `Photo of the bill${proofRequired ? "" : " (optional)"}`}
            </span>
            <input
              accept="image/*"
              className="block w-full text-sm"
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

                  if (!result?.assetId) setError("The photo did not upload. Save without it, or try again.");
                } finally {
                  setUploading(false);
                }
              }}
              type="file"
            />
            {uploading ? <span className="text-xs text-muted-foreground">Adding photo…</span> : null}
          </label>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button onClick={close} variant="outline">
            Close
          </Button>
          <Button disabled={saving || uploading} onClick={() => void save()}>
            {saving ? "Saving…" : amount ? `Save ${currency(amount)}` : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
