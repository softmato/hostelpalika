"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  BedDouble,
  ClipboardList,
  FileDown,
  HandCoins,
  type LucideIcon,
  MessageSquareWarning,
  Users,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { BRANCH_GC_MS, BRANCH_STALE_MS } from "@/lib/branch-cache";
import { browserApi } from "@/lib/browser-api";
import { downloadFile } from "@/lib/downloads/downloader";
import { formatBsDate, formatBsPeriod } from "@/lib/hostel-day";
import { cn } from "@/lib/utils";

import { EmptyState, LoadingRows, currency } from "./shared-ui";
import { MetricCard, PortalPageHeader, SectionCard, type SoftTone } from "./portal-dashboard-ui";

/**
 * **Overall** on the web — every branch at once (`/overall/admin/...`).
 *
 * Picked in the workspace switcher like a branch, with the same subjects in its
 * sidebar. Each page puts the all-branch totals on top and then **one card per
 * branch, stacked**, so two branches' rows never mix into a list nobody can
 * attribute. The app's Overall (`apps/mobile/src/components/overall-views.tsx`)
 * reads the same endpoints the same way.
 *
 * Read-only: every request names its branch in `x-hostel-id`, which the server
 * honours only for hostels on the owner's own token, and every action is a link
 * into that branch's workspace. The layout lets only an owner of several
 * hostels reach this page.
 */

export const OVERALL_SCREENS = [
  "dashboard",
  "residents",
  "staff",
  "payments",
  "statement",
  "expenses",
  "daily",
  "reports",
] as const;

export type OverallScreen = (typeof OVERALL_SCREENS)[number];

const API = "/api/v1/hostel-admin";

type Branch = {
  area?: string;
  beds: number;
  city?: string;
  collected: number;
  due: number;
  id: string;
  isBranch: boolean;
  name: string;
  occupancyPercent: number | null;
  openComplaints: number;
  residents: number;
  slug: string;
};

type Field = { data: unknown; error: null } | { data: null; error: string };
type BranchData = { branch: Branch; fields: Record<string, Field> };
type Overall = { branches: BranchData[]; period: string };

/** Which reads each page needs, per branch. `{period}` becomes the BS month. */
const READS: Record<OverallScreen, Record<string, string>> = {
  daily: {
    bookings: "/bookings?tab=requests",
    complaints: "/complaints?pageSize=50",
    inquiries: "/inquiries?pageSize=50",
    maintenance: "/maintenance/requests",
    night: "/night-status?pageSize=100",
  },
  dashboard: {},
  expenses: { expenses: "/expenses?period={period}" },
  payments: { invoices: "/finance/invoices?period={period}" },
  reports: { performance: "/reports/performance?month={period}" },
  residents: { residents: "/residents?pageSize=100" },
  staff: { cooks: "/cooks", expenses: "/expenses?period={period}", wardens: "/wardens?pageSize=100" },
  statement: { ledger: "/finance/invoices/ledger" },
};

const TITLES: Record<OverallScreen, string> = {
  daily: "Daily work",
  dashboard: "Dashboard",
  expenses: "Expenses",
  payments: "Payments",
  reports: "Reports",
  residents: "Residents",
  staff: "Wardens & cooks",
  statement: "Statement",
};

/** Where "Open" lands in the branch's own workspace. */
const BRANCH_SCREEN: Record<OverallScreen, string> = {
  daily: "complaints",
  dashboard: "dashboard",
  expenses: "expenses",
  payments: "payments",
  reports: "reports",
  residents: "residents",
  staff: "wardens",
  statement: "transactions",
};

async function read(branchId: string, path: string): Promise<Field> {
  try {
    return { data: await browserApi<unknown>(`${API}${path}`, { headers: { "x-hostel-id": branchId } }), error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error && error.message ? error.message : "Could not load." };
  }
}

/** Three branches at a time; one branch failing keeps its own error, never zeroes the rest. */
async function loadOverall(screen: OverallScreen): Promise<Overall> {
  const summary = await browserApi<{ hostels: Branch[]; period: string }>(`${API}/branches/summary`);
  const reads = Object.entries(READS[screen]);
  const branches: BranchData[] = [];

  for (let start = 0; start < summary.hostels.length; start += 3) {
    branches.push(
      ...(await Promise.all(
        summary.hostels.slice(start, start + 3).map(async (branch) => {
          const values = await Promise.all(
            reads.map(([, path]) => read(branch.id, path.replace("{period}", summary.period))),
          );

          return { branch, fields: Object.fromEntries(reads.map(([key], index) => [key, values[index]!])) };
        }),
      )),
    );
  }

  return { branches, period: summary.period };
}

/* -------------------------------------------------------------------------- */

export function HostelAdminOverallPage({ screen }: { screen: OverallScreen }) {
  const query = useQuery({
    gcTime: BRANCH_GC_MS,
    queryFn: () => loadOverall(screen),
    queryKey: ["overall", screen],
    staleTime: BRANCH_STALE_MS,
  });
  const data = query.data;

  return (
    <div className="space-y-4">
      <PortalPageHeader
        actions={screen === "dashboard" || screen === "reports" || screen === "statement" ? (
          <PdfButtons kinds={screen === "statement" ? ["statement"] : ["report", "statement"]} period={data?.period} />
        ) : undefined}
        breadcrumb={["Overall", TITLES[screen]]}
        description={data ? `${data.branches.length} branches · ${formatBsPeriod(data.period)}` : undefined}
        title={TITLES[screen]}
      />

      {query.isPending ? <SectionCard><LoadingRows /></SectionCard> : null}
      {query.isError && !data ? (
        <SectionCard>
          <p className="text-sm text-muted-foreground">Could not load your branches.</p>
          <Button className="mt-3" onClick={() => void query.refetch()} size="sm" variant="outline">Try again</Button>
        </SectionCard>
      ) : null}

      {data ? <ScreenBody data={data} screen={screen} /> : null}
    </div>
  );
}

function ScreenBody({ data, screen }: { data: Overall; screen: OverallScreen }) {
  const rows = data.branches;

  if (rows.length === 0) return <SectionCard><EmptyState label="No branches yet." /></SectionCard>;

  if (screen === "dashboard") return <Dashboard rows={rows} />;

  return (
    <>
      <Totals rows={rows} screen={screen} />
      <div className="space-y-4">
        {rows.map((row) => (
          <SectionCard
            actions={
              <Link
                className="text-sm font-semibold text-primary hover:underline"
                href={`/${encodeURIComponent(row.branch.slug)}/admin/${BRANCH_SCREEN[screen]}`}
              >
                Open
              </Link>
            }
            description={[row.branch.isBranch ? "Branch" : "Main hostel", row.branch.area || row.branch.city]
              .filter(Boolean)
              .join(" · ")}
            key={row.branch.id}
            title={row.branch.name}
          >
            <BranchBody row={row} screen={screen} />
          </SectionCard>
        ))}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- pieces */

function PdfButtons({ kinds, period }: { kinds: ("report" | "statement")[]; period?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {kinds.map((kind) => (
        <Button
          disabled={!period}
          key={kind}
          onClick={() =>
            void downloadFile({
              fileName: `all-branches-${kind}-${period}.pdf`,
              label: kind === "report" ? "All branches report" : "All branches statement",
              mimeType: "application/pdf",
              scope: "overall",
              url: `${API}/reports/overall/pdf?kind=${kind}&month=${period}`,
            })
          }
          variant="outline"
        >
          <FileDown />
          {kind === "report" ? "Report PDF" : "Statement PDF"}
        </Button>
      ))}
    </div>
  );
}

function Metrics({ items }: { items: { icon: LucideIcon; label: string; note?: string; tone: SoftTone; value: string }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <MetricCard icon={item.icon} key={item.label} label={item.label} note={item.note} tone={item.tone} value={item.value} />
      ))}
    </div>
  );
}

function Bar({ percent, tone = "primary" }: { percent: number | null; tone?: "primary" | "warning" }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", tone === "warning" ? "bg-amber-500" : "bg-primary")}
        style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
      />
    </div>
  );
}

/** A short list with "Show all" growing it in place. */
function Rows({ empty, items }: { empty: string; items: ReactNode[] }) {
  const [all, setAll] = useState(false);

  if (items.length === 0) return <EmptyState label={empty} />;

  return (
    <div>
      <ul className="divide-y divide-border/70">{items.slice(0, all ? 50 : 6)}</ul>
      {items.length > 6 ? (
        <button className="mt-2 text-xs font-semibold text-primary hover:underline" onClick={() => setAll(!all)} type="button">
          {all ? "Show fewer" : `Show ${Math.min(items.length, 50) - 6} more`}
        </button>
      ) : null}
    </div>
  );
}

function Row({ amount, sub, title, tone }: { amount?: string; sub?: string; title: string; tone?: "in" | "out" | "move" }) {
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{title}</p>
        {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
      </div>
      {amount ? (
        <span
          className={cn(
            "shrink-0 font-semibold tabular-nums",
            tone === "in" ? "text-primary" : tone === "out" ? "text-destructive" : "text-foreground",
          )}
        >
          {amount}
        </span>
      ) : null}
    </li>
  );
}

function Figures({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="grid grid-cols-3 gap-3 pb-3">
      {items.map(([label, value]) => (
        <div key={label}>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-base font-semibold tabular-nums">{value}</p>
        </div>
      ))}
    </div>
  );
}

function issue(field: Field | undefined) {
  return field?.error ? <p className="text-sm text-amber-700 dark:text-amber-300">{field.error}</p> : null;
}

/* ------------------------------------------------------------- reading */

type Ledger = {
  entries: { createdAt?: string; id: string; month: string | null; paidAmount: number; paidDate?: string | null; residentName: string }[];
  expenses: ExpenseRow[] | null;
};
type ExpenseRow = {
  amount: number;
  cashStatus: string | null;
  cashTo: { name: string } | null;
  categoryLabel: string;
  id: string;
  payer: "HOSTEL" | "STAFF";
  recordedBy: { name: string };
  spentOn: string;
  status: string;
  what: string;
};
type Wallet = { given: number; left: number; name: string; pending: number; spent: number; userId: string };
type ExpenseHome = {
  expenses: ExpenseRow[];
  totals: { byCategory: { amount: number; label: string }[]; out: number } | null;
  wallets: Wallet[] | null;
};

const get = <T,>(row: BranchData, key: string) => row.fields[key]?.data as T | null | undefined;

/** Money in and out, newest first — a cash handover listed, never counted (it is not spending). */
function movements(ledger: Ledger | null | undefined) {
  const rows: { amount: number; at: string; id: string; kind: "in" | "out" | "move"; sub: string; title: string }[] = [];

  for (const entry of ledger?.entries ?? []) {
    const at = entry.paidDate ?? entry.createdAt;

    if (entry.paidAmount > 0 && at) {
      rows.push({
        amount: entry.paidAmount,
        at,
        id: entry.id,
        kind: "in",
        sub: formatBsDate(new Date(at)),
        title: `${entry.month ? `${formatBsPeriod(entry.month)} rent` : "One-off"} · ${entry.residentName || "Resident"}`,
      });
    }
  }

  for (const expense of ledger?.expenses ?? []) {
    if (expense.status !== "RECORDED" || expense.cashStatus === "DECLINED") continue;

    const at = `${expense.spentOn}T12:00:00+05:45`;

    rows.push({
      amount: expense.amount,
      at,
      id: `e:${expense.id}`,
      kind: expense.cashTo ? "move" : "out",
      sub: formatBsDate(new Date(at)),
      title: expense.cashTo
        ? `Cash to ${expense.cashTo.name}`
        : `${expense.what || expense.categoryLabel}${expense.payer === "STAFF" ? ` · ${expense.recordedBy.name}` : ""}`,
    });
  }

  rows.sort((a, b) => b.at.localeCompare(a.at));

  return {
    in: rows.filter((row) => row.kind === "in").reduce((sum, row) => sum + row.amount, 0),
    out: rows.filter((row) => row.kind === "out").reduce((sum, row) => sum + row.amount, 0),
    rows,
  };
}

function sum(rows: BranchData[], value: (row: BranchData) => number | null | undefined) {
  return rows.reduce((total, row) => total + (value(row) ?? 0), 0);
}

/* ------------------------------------------------------------- screens */

function Dashboard({ rows }: { rows: BranchData[] }) {
  const collected = sum(rows, (row) => row.branch.collected);
  const due = sum(rows, (row) => row.branch.due);
  const residents = sum(rows, (row) => row.branch.residents);
  const beds = sum(rows, (row) => row.branch.beds);

  return (
    <>
      <Metrics
        items={[
          { icon: ArrowDownRight, label: "Collected this month", tone: "green", value: currency(collected) },
          { icon: Wallet, label: "Still due", tone: due > 0 ? "amber" : "slate", value: currency(due) },
          { icon: BedDouble, label: "Residents / beds", note: beds > 0 ? `${Math.round((residents / beds) * 100)}% full` : undefined, tone: "teal", value: `${residents} / ${beds}` },
          { icon: MessageSquareWarning, label: "Open complaints", tone: "rose", value: String(sum(rows, (row) => row.branch.openComplaints)) },
        ]}
      />
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map(({ branch }) => {
          const billed = branch.collected + branch.due;

          return (
            <Link
              className="block space-y-3 rounded-xl border border-border bg-card p-4 transition hover:border-primary/50 hover:shadow-sm"
              href={`/${encodeURIComponent(branch.slug)}/admin/dashboard`}
              key={branch.id}
            >
              <div>
                <p className="font-semibold">{branch.name}</p>
                <p className="text-xs text-muted-foreground">
                  {[branch.isBranch ? "Branch" : "Main hostel", branch.area || branch.city].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{billed > 0 ? `${Math.round((branch.collected / billed) * 100)}% collected` : "Nothing billed"}</span>
                  <span>{`${branch.residents} / ${branch.beds} beds`}</span>
                </div>
                <Bar percent={billed > 0 ? (branch.collected / billed) * 100 : null} />
              </div>
              <Figures
                items={[
                  ["Collected", currency(branch.collected)],
                  ["Due", <span className={branch.due > 0 ? "text-destructive" : undefined} key="due">{currency(branch.due)}</span>],
                  ["Complaints", String(branch.openComplaints)],
                ]}
              />
            </Link>
          );
        })}
      </div>
    </>
  );
}

function Totals({ rows, screen }: { rows: BranchData[]; screen: OverallScreen }) {
  switch (screen) {
    case "residents":
      return <Metrics items={[{ icon: Users, label: "Residents", tone: "teal", value: String(sum(rows, (row) => row.branch.residents)) }]} />;
    case "staff":
      return (
        <Metrics
          items={[
            { icon: Users, label: "Wardens", tone: "teal", value: String(sum(rows, (row) => get<{ wardens: unknown[] }>(row, "wardens")?.wardens.length)) },
            {
              icon: HandCoins,
              label: "Cash with wardens",
              tone: "green",
              value: currency(sum(rows, (row) => (get<ExpenseHome>(row, "expenses")?.wallets ?? []).reduce((total, wallet) => total + Math.max(0, wallet.left), 0))),
            },
          ]}
        />
      );
    case "payments": {
      const totals = (row: BranchData) => get<{ totals: { collected: number; due: number } }>(row, "invoices")?.totals;

      return (
        <Metrics
          items={[
            { icon: Wallet, label: "Billed", tone: "slate", value: currency(sum(rows, (row) => totals(row)?.due)) },
            { icon: ArrowDownRight, label: "Collected", tone: "green", value: currency(sum(rows, (row) => totals(row)?.collected)) },
            { icon: ArrowUpRight, label: "Still due", tone: "amber", value: currency(sum(rows, (row) => Math.max(0, (totals(row)?.due ?? 0) - (totals(row)?.collected ?? 0)))) },
          ]}
        />
      );
    }
    case "statement": {
      const all = rows.map((row) => movements(get<Ledger>(row, "ledger")));

      return (
        <Metrics
          items={[
            { icon: ArrowDownRight, label: "Money in", tone: "green", value: currency(all.reduce((total, row) => total + row.in, 0)) },
            { icon: ArrowUpRight, label: "Money out", tone: "rose", value: currency(all.reduce((total, row) => total + row.out, 0)) },
            { icon: Wallet, label: "Net", tone: "teal", value: currency(all.reduce((total, row) => total + row.in - row.out, 0)) },
          ]}
        />
      );
    }
    case "expenses":
      return (
        <Metrics
          items={[
            { icon: ArrowUpRight, label: "Spent this month", tone: "rose", value: currency(sum(rows, (row) => get<ExpenseHome>(row, "expenses")?.totals?.out)) },
            {
              icon: HandCoins,
              label: "Cash with wardens",
              tone: "green",
              value: currency(sum(rows, (row) => (get<ExpenseHome>(row, "expenses")?.wallets ?? []).reduce((total, wallet) => total + Math.max(0, wallet.left), 0))),
            },
          ]}
        />
      );
    case "daily":
      return (
        <Metrics
          items={[
            { icon: MessageSquareWarning, label: "Open complaints", tone: "rose", value: String(sum(rows, (row) => row.branch.openComplaints)) },
            { icon: ClipboardList, label: "Open repairs", tone: "amber", value: String(sum(rows, (row) => get<{ summary: { open: number } }>(row, "maintenance")?.summary.open)) },
            { icon: Users, label: "Outside tonight", tone: "slate", value: String(sum(rows, (row) => get<{ summary: { OUTSIDE_HOSTEL: number } }>(row, "night")?.summary.OUTSIDE_HOSTEL)) },
          ]}
        />
      );
    case "reports": {
      const finance = (row: BranchData) =>
        get<{ report: { finance: { billed: number; collected: number; outstanding: number } } }>(row, "performance")?.report.finance;

      return (
        <Metrics
          items={[
            { icon: Wallet, label: "Billed", tone: "slate", value: currency(sum(rows, (row) => finance(row)?.billed)) },
            { icon: ArrowDownRight, label: "Collected", tone: "green", value: currency(sum(rows, (row) => finance(row)?.collected)) },
            { icon: ArrowUpRight, label: "Outstanding", tone: "amber", value: currency(sum(rows, (row) => finance(row)?.outstanding)) },
          ]}
        />
      );
    }
    default:
      return null;
  }
}

function BranchBody({ row, screen }: { row: BranchData; screen: OverallScreen }) {
  switch (screen) {
    case "residents": {
      const list = get<{ residents: { firstName: string; id: string; lastName?: string; roomType?: string; status: string }[] }>(row, "residents");

      return (
        <>
          {issue(row.fields.residents)}
          {list ? (
            <Rows
              empty="No residents yet."
              items={list.residents.map((person) => (
                <Row key={person.id} sub={[person.roomType, person.status].filter(Boolean).join(" · ")} title={`${person.firstName} ${person.lastName ?? ""}`.trim()} />
              ))}
            />
          ) : null}
        </>
      );
    }
    case "staff": {
      const wardens = get<{ wardens: { id: string; name: string; status: string }[] }>(row, "wardens");
      const cooks = get<{ cooks: { id: string; name: string; status: string }[] }>(row, "cooks");
      const wallets = new Map((get<ExpenseHome>(row, "expenses")?.wallets ?? []).map((wallet) => [wallet.name, wallet]));

      return (
        <>
          {issue(row.fields.wardens)}
          <Rows
            empty="No wardens or cooks yet."
            items={[
              ...(wardens?.wardens ?? []).map((person) => {
                const wallet = wallets.get(person.name);

                return (
                  <Row
                    amount={wallet ? (wallet.left < 0 ? `owes ${currency(-wallet.left)}` : currency(wallet.left)) : undefined}
                    key={person.id}
                    sub={["Warden", person.status, wallet ? "cash left" : null].filter(Boolean).join(" · ")}
                    title={person.name}
                  />
                );
              }),
              ...(cooks?.cooks ?? []).map((person) => <Row key={person.id} sub={`Cook · ${person.status}`} title={person.name} />),
            ]}
          />
        </>
      );
    }
    case "payments": {
      const matrix = get<{
        rows: { payment: { dueAmount: number; paidAmount: number } | null; resident: { fullName: string; id: string; roomNumber?: string | null } }[];
        totals: { collected: number; due: number };
      }>(row, "invoices");
      const billed = matrix?.totals.due ?? 0;

      return (
        <>
          {issue(row.fields.invoices)}
          {matrix ? (
            <>
              <Figures
                items={[
                  ["Billed", currency(billed)],
                  ["Collected", currency(matrix.totals.collected)],
                  ["Due", currency(Math.max(0, billed - matrix.totals.collected))],
                ]}
              />
              <div className="pb-3"><Bar percent={billed > 0 ? (matrix.totals.collected / billed) * 100 : null} /></div>
              <Rows
                empty="Everyone has paid."
                items={matrix.rows
                  .filter((item) => item.payment && item.payment.dueAmount > item.payment.paidAmount)
                  .map((item) => (
                    <Row
                      amount={currency(item.payment!.dueAmount - item.payment!.paidAmount)}
                      key={item.resident.id}
                      sub={item.resident.roomNumber ? `Room ${item.resident.roomNumber}` : undefined}
                      title={item.resident.fullName}
                      tone="out"
                    />
                  ))}
              />
            </>
          ) : null}
        </>
      );
    }
    case "statement": {
      const money = movements(get<Ledger>(row, "ledger"));

      return (
        <>
          {issue(row.fields.ledger)}
          <Figures items={[["Money in", currency(money.in)], ["Money out", currency(money.out)], ["Net", currency(money.in - money.out)]]} />
          <Rows
            empty="Nothing moved yet."
            items={money.rows.map((item) => (
              <Row
                amount={`${item.kind === "in" ? "+" : item.kind === "out" ? "-" : ""}${currency(item.amount)}`}
                key={item.id}
                sub={item.kind === "move" ? `${item.sub} · to staff cash` : item.sub}
                title={item.title}
                tone={item.kind}
              />
            ))}
          />
        </>
      );
    }
    case "expenses": {
      const home = get<ExpenseHome>(row, "expenses");

      return (
        <>
          {issue(row.fields.expenses)}
          {home ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Spent on</p>
                {(home.totals?.byCategory ?? []).slice(0, 5).map((category) => (
                  <div className="space-y-1" key={category.label}>
                    <div className="flex justify-between text-sm">
                      <span>{category.label}</span>
                      <span className="font-semibold tabular-nums">{currency(category.amount)}</span>
                    </div>
                    <Bar percent={home.totals!.out > 0 ? (category.amount / home.totals!.out) * 100 : 0} />
                  </div>
                ))}
                {(home.wallets ?? []).length > 0 ? (
                  <p className="pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Staff cash</p>
                ) : null}
                {(home.wallets ?? []).map((wallet) => (
                  <div className="flex justify-between text-sm" key={wallet.userId}>
                    <span>{wallet.name}</span>
                    <span className={cn("font-semibold tabular-nums", wallet.left < 0 && "text-destructive")}>
                      {wallet.left < 0 ? `owes ${currency(-wallet.left)}` : `${currency(wallet.left)} left`}
                    </span>
                  </div>
                ))}
              </div>
              <Rows
                empty="Nothing spent this month."
                items={home.expenses
                  .filter((item) => item.status === "RECORDED" && !item.cashTo)
                  .map((item) => (
                    <Row
                      amount={currency(item.amount)}
                      key={item.id}
                      sub={[formatBsDate(new Date(`${item.spentOn}T12:00:00+05:45`)), item.categoryLabel, item.payer === "STAFF" ? item.recordedBy.name : null].filter(Boolean).join(" · ")}
                      title={item.what || item.categoryLabel}
                      tone="out"
                    />
                  ))}
              />
            </div>
          ) : null}
        </>
      );
    }
    case "daily": {
      const complaints = get<{ complaints: { id: string; isOverdue?: boolean; status: string; title: string }[] }>(row, "complaints");
      const repairs = get<{ requests: { id: string; location: string; status: string; title: string }[]; summary: { open: number } }>(row, "maintenance");
      const night = get<{ summary: { INSIDE_HOSTEL: number; NOT_VERIFIED: number; OUTSIDE_HOSTEL: number } }>(row, "night");
      const bookings = get<{ counts: { requests: number } }>(row, "bookings");

      return (
        <>
          {issue(row.fields.complaints)}
          <Figures
            items={[
              ["Inside / outside tonight", night ? `${night.summary.INSIDE_HOSTEL} / ${night.summary.OUTSIDE_HOSTEL}` : "-"],
              ["Open repairs", String(repairs?.summary.open ?? "-")],
              ["Booking requests", String(bookings?.counts.requests ?? "-")],
            ]}
          />
          <Rows
            empty="No open complaints or repairs."
            items={[
              ...(complaints?.complaints ?? [])
                .filter((item) => item.status !== "RESOLVED" && item.status !== "CLOSED")
                .map((item) => <Row key={item.id} sub={`Complaint · ${item.status}${item.isOverdue ? " · overdue" : ""}`} title={item.title} />),
              ...(repairs?.requests ?? [])
                .filter((item) => item.status !== "COMPLETED")
                .map((item) => <Row key={item.id} sub={`Repair · ${item.location}`} title={item.title} />),
            ]}
          />
        </>
      );
    }
    case "reports": {
      const report = get<{
        report: {
          finance: { billed: number; collected: number; outstanding: number };
          operations: { complaints: { open: number }; repairs: { open: number } };
          residents: { movedIn: number; movedOut: number; now: { total: number } };
        };
      }>(row, "performance")?.report;

      return (
        <>
          {issue(row.fields.performance)}
          {report ? (
            <div className="space-y-3">
              <Figures items={[["Billed", currency(report.finance.billed)], ["Collected", currency(report.finance.collected)], ["Outstanding", currency(report.finance.outstanding)]]} />
              <Bar percent={report.finance.billed > 0 ? (report.finance.collected / report.finance.billed) * 100 : null} />
              <Figures
                items={[
                  ["Residents", String(report.residents.now.total)],
                  ["Moved in / out", `${report.residents.movedIn} / ${report.residents.movedOut}`],
                  ["Open complaints / repairs", `${report.operations.complaints.open} / ${report.operations.repairs.open}`],
                ]}
              />
            </div>
          ) : null}
        </>
      );
    }
    default:
      return null;
  }
}
