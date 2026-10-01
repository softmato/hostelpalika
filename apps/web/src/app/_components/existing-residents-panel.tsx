"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Pencil,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { currency } from "@/app/_components/shared-ui";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { downloadFile } from "@/lib/downloads/downloader";
import { cn } from "@/lib/utils";
import type { CheckResult, ListRow } from "@/modules/residents/existing-residents-check";
import type {
  AddResult,
  ExistingResidentsView,
} from "@/modules/residents/existing-residents.service";
import {
  joinedDateText,
  rentStatusLabel,
  type SheetOutRow,
} from "@/modules/residents/existing-residents-sheet-model";

import { ExistingResidentsSheet } from "./existing-residents-sheet";
import { RoleButton, SectionCard, SoftBadge } from "./portal-dashboard-ui";

/**
 * Residents already living in a hostel when it joined (docs/EXISTING_RESIDENTS.md).
 *
 * One screen for two front doors: the hostel's own Residents page, and the field
 * team's page for a hostel they just published. `apiBase` is the only difference.
 *
 * Three ways in — download the Excel file, upload it filled, or fill the sheet
 * right here — all landing in the same list. The page only shows the list;
 * typing happens in the sheet. Nothing is a resident until "Add all", and the
 * list says exactly what will be billed before anybody presses it.
 */

type Props = {
  apiBase: string;
  tone: "admin" | "platform";
};

function toPayload(rows: SheetOutRow[]) {
  return rows.map((row) => ({
    depositPaid: row.depositPaid,
    email: row.email,
    fullName: row.fullName,
    ...(row.id ? { id: row.id } : {}),
    joinedDate: row.joinedDate,
    monthlyRent: row.monthlyRent,
    oldDues: row.oldDues,
    partPaid: row.partPaid,
    paidTill: row.paidTill,
    phone: row.phone,
    roomType: row.roomType,
  }));
}

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("This file could not be read."));
    reader.readAsDataURL(file);
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

const tileClass =
  "app-card flex items-center gap-3 p-4 text-left transition hover:border-brand-teal hover:bg-brand-teal/5 disabled:opacity-60";

function TileBody({
  icon: Icon,
  label,
  note,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  note: string;
}) {
  return (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
        <Icon className="size-5" />
      </span>
      <span>
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{note}</span>
      </span>
    </>
  );
}

export function ExistingResidentsPanel({ apiBase, tone }: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const [view, setView] = useState<ExistingResidentsView | null>(null);
  const [rows, setRows] = useState<ListRow[]>([]);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<"add" | "check" | "clear" | "upload" | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [added, setAdded] = useState<AddResult | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  // Open sheet: `""` puts the cursor on the first empty line, a row id on that line.
  const [sheetAt, setSheetAt] = useState<string | null>(null);

  const apply = useCallback((next: ExistingResidentsView) => {
    setView(next);
    setRows(next.list?.rows ?? []);
    setCheck(next.check);
  }, []);

  useEffect(() => {
    browserApi<ExistingResidentsView>(apiBase)
      .then(apply)
      .catch((cause: unknown) => setError(errorText(cause)));
  }, [apiBase, apply]);

  const checkedById = useMemo(
    () => new Map((check?.rows ?? []).map((row) => [row.id, row])),
    [check],
  );

  const totals = useMemo(() => {
    let months = 0;
    let dues = 0;
    let amount = 0;

    for (const row of check?.rows ?? []) {
      if (!row.bills) continue;

      months += row.bills.months.length;
      dues += row.bills.oldDues > 0 ? 1 : 0;
      amount += row.bills.total;
    }

    return { amount, dues, months };
  }, [check]);

  const pendingCount = rows.filter((row) => !row.residentId).length;
  // Rent is the rate card's, whatever a line once said.
  const rentOf = useMemo(
    () =>
      new Map((view?.roomTypes ?? []).map((room) => [room.roomType.trim().toLowerCase(), room.monthlyRent])),
    [view],
  );

  async function save(next: SheetOutRow[]) {
    const result = await browserApi<ExistingResidentsView>(apiBase, {
      body: JSON.stringify({ rows: toPayload(next) }),
      method: "PUT",
    });

    apply(result);
    setAdded(null);

    return result;
  }

  async function run(kind: NonNullable<typeof busy>, work: () => Promise<void>) {
    setBusy(kind);
    setError("");

    try {
      await work();
    } catch (cause) {
      // A refused "Add all" carries the check that refused it.
      if (cause instanceof ApiRequestError && cause.errorCode === "EXISTING_RESIDENTS_NOT_READY") {
        const details = cause.details as { check?: CheckResult } | undefined;

        if (details?.check) setCheck(details.check);
      }

      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }

  function download() {
    void downloadFile({
      fileName: "existing-residents.xlsx",
      label: "Existing residents Excel file",
      url: `${apiBase}/template`,
    });
    // Excel that is not activated opens every file read-only, and many hostel
    // computers run one — so say at once that the sheet here does the same job.
    setDownloaded(true);
  }

  function openSheet(at = "") {
    setDownloaded(false);
    setSheetAt(at);
  }

  function upload(file: File) {
    void run("upload", async () => {
      const result = await browserApi<{
        notes: string[];
        read: number;
        view: ExistingResidentsView;
      }>(`${apiBase}/file`, {
        body: JSON.stringify({ contentBase64: await readAsBase64(file), fileName: file.name }),
        method: "POST",
      });

      apply(result.view);
      setAdded(null);
      setNotes([`${result.read} ${result.read === 1 ? "resident" : "residents"} read from ${file.name}.`, ...result.notes]);
    });
  }

  function removeRow(id: string) {
    void run("check", async () => {
      await save(rows.filter((row) => row.id !== id));
    });
  }

  async function clear() {
    const ok = await confirm({
      actionLabel: "Delete list",
      description: "Residents not added yet are removed from this list. Residents already added stay.",
      title: "Delete this list?",
      tone: "destructive",
    });

    if (!ok) return;

    void run("clear", async () => {
      apply(await browserApi<ExistingResidentsView>(apiBase, { method: "DELETE" }));
      setNotes([]);
    });
  }

  async function addAll() {
    if (!check?.ready) {
      setError("Fix the problems in the list first.");

      return;
    }

    const bills =
      totals.months + totals.dues === 0
        ? "Nothing is billed now."
        : `${totals.months} ${totals.months === 1 ? "month" : "months"} due and ${totals.dues} old ${
            totals.dues === 1 ? "due" : "dues"
          } are billed, ${currency(totals.amount)} in total.`;
    const withEmail = rows.filter((row) => !row.residentId && row.email.trim()).length;
    const told =
      withEmail === check.toAdd
        ? "Each of them gets an email with what they owe."
        : `${withEmail} with an email get what they owe by email. Tell the other ${check.toAdd - withEmail} yourself.`;

    const ok = await confirm({
      actionLabel: `Add ${check.toAdd} residents`,
      description: `They are added as living here now, with no admission fee. ${bills} ${told}`,
      title: `Add ${check.toAdd} residents?`,
    });

    if (!ok) return;

    void run("add", async () => {
      const result = await browserApi<{ result: AddResult; view: ExistingResidentsView }>(
        `${apiBase}/add`,
        { method: "POST" },
      );

      apply(result.view);
      setAdded(result.result);
      setNotes([]);
    });
  }

  if (!view) {
    return (
      <div className="space-y-3">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {[0, 1, 2].map((index) => (
          <div className="h-16 animate-pulse rounded-xl bg-muted" key={index} />
        ))}
      </div>
    );
  }

  const lastAdded = added ?? (rows.length === 0 ? view.lastAdded : null);
  const period = view.currentMonth.period;

  return (
    <div className="space-y-4 pb-24">
      {confirmDialog}

      {sheetAt !== null ? (
        <ExistingResidentsSheet
          check={check}
          currentPeriod={period}
          hostelName={view.hostel.name}
          onClose={() => setSheetAt(null)}
          onSave={async (next) => {
            const result = await save(next);

            setNotes([]);

            return { check: result.check, rows: result.list?.rows ?? [] };
          }}
          openAt={sheetAt || null}
          rooms={view.roomTypes}
          rows={rows}
          tone={tone}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <button className={tileClass} disabled={busy !== null} onClick={download} type="button">
          <TileBody icon={Download} label="Download Excel file" note="Blank file with your room types" />
        </button>
        {/* A label, so the hidden file input opens without reaching for a ref. */}
        <label className={cn(tileClass, "cursor-pointer", busy !== null && "pointer-events-none opacity-60")}>
          <TileBody
            icon={Upload}
            label={busy === "upload" ? "Reading file…" : "Upload filled file"}
            note="Excel or CSV"
          />
          <input
            accept=".xlsx,.xls,.csv"
            className="hidden"
            disabled={busy !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];

              event.target.value = "";
              if (file) upload(file);
            }}
            type="file"
          />
        </label>
        <button className={tileClass} disabled={busy !== null} onClick={() => openSheet()} type="button">
          <TileBody icon={Table2} label="Fill in sheet" note="Type or paste here, like Excel" />
        </button>
      </div>

      {downloaded ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4 text-sm sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">Can&apos;t type in the Excel file?</p>
            <p className="mt-1 text-muted-foreground">
              No need for Excel. The sheet here has the same columns and works the same way.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RoleButton onClick={() => openSheet()} tone={tone} type="button">
              <FileSpreadsheet className="size-4" />
              Open sheet
            </RoleButton>
            <button
              aria-label="Close"
              className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={() => setDownloaded(false)}
              type="button"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      ) : null}

      {lastAdded ? (
        <div className="rounded-xl border border-success/30 bg-success/10 p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold text-foreground">
            <CheckCircle2 className="size-4 text-success" />
            {lastAdded.added} {lastAdded.added === 1 ? "resident" : "residents"} added ·{" "}
            {lastAdded.billsRaised} {lastAdded.billsRaised === 1 ? "bill" : "bills"} made
          </p>
          {lastAdded.problems.length ? (
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {lastAdded.problems.map((problem, index) => (
                <li key={index}>
                  <span className="font-medium text-foreground">{problem.name}:</span> {problem.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {notes.length ? (
        <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {notes.map((note, index) => (
            <p className={index === 0 ? "font-medium text-foreground" : undefined} key={index}>
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {check?.listProblems.length ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground" role="alert">
          {check.listProblems.map((problem) => (
            <p className="flex items-start gap-2" key={problem}>
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              {problem}
            </p>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="app-card flex flex-col items-center gap-2 p-8 text-center">
          <FileSpreadsheet className="size-8 text-muted-foreground" />
          <p className="text-sm font-semibold text-foreground">No residents in the list yet</p>
          <p className="text-xs text-muted-foreground">
            Upload the filled Excel file, or fill the sheet here.
          </p>
        </div>
      ) : (
        <SectionCard
          actions={
            <div className="flex items-center gap-4">
              <button
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-teal"
                disabled={busy !== null}
                onClick={() => openSheet()}
                type="button"
              >
                <Pencil className="size-3.5" />
                Edit in sheet
              </button>
              <button
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground transition hover:text-destructive"
                disabled={busy !== null}
                onClick={() => void clear()}
                type="button"
              >
                <Trash2 className="size-3.5" />
                Delete list
              </button>
            </div>
          }
          description={`This month is ${view.currentMonth.label}. Months due and old dues are billed when you add the list, and each resident is told what they owe.`}
          title={`List · ${rows.length} ${rows.length === 1 ? "resident" : "residents"}`}
        >
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left text-[13px]">
              <thead className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="sticky left-0 z-10 bg-card px-2 py-2 pl-4">Resident</th>
                  <th className="px-2 py-2">Room type</th>
                  <th className="px-2 py-2">Rent</th>
                  <th className="px-2 py-2">Deposit paid</th>
                  <th className="px-2 py-2">Old dues</th>
                  <th className="px-2 py-2">Joined</th>
                  <th className="px-2 py-2">Email</th>
                  <th className="px-2 py-2">Dues to bill</th>
                  <th className="px-2 py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const checked = checkedById.get(row.id);
                  const problems = checked?.problems ?? [];
                  const rent = rentStatusLabel(period, row.paidTill);
                  const monthly = rentOf.get(row.roomType.trim().toLowerCase());
                  const edge = problems.length ? "" : "border-b border-border/60";

                  return [
                    <tr
                      className={cn(
                        "cursor-pointer align-top transition hover:bg-muted/40",
                        row.residentId && "cursor-default text-muted-foreground hover:bg-transparent",
                        problems.length && "bg-warning/5",
                      )}
                      key={row.id}
                      onClick={() => (row.residentId ? undefined : openSheet(row.id))}
                    >
                      <td className={cn("sticky left-0 z-10 bg-card px-2 py-2.5 pl-4", edge)}>
                        <span className="flex items-baseline gap-2">
                          <span className="w-5 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                          <span className="min-w-0">
                            <span className="block font-medium text-foreground">
                              {row.fullName || <span className="text-muted-foreground">No name</span>}
                            </span>
                            <span className="block text-xs text-muted-foreground">{row.phone || "No phone"}</span>
                          </span>
                        </span>
                      </td>
                      <td className={cn("px-2 py-2.5", edge)}>{row.roomType || "—"}</td>
                      <td className={cn("px-2 py-2.5", edge)}>
                        {rent ?? <span className="text-warning">Not chosen</span>}
                        {monthly ? (
                          <span className="block text-xs text-muted-foreground">{currency(monthly)} a month</span>
                        ) : null}
                      </td>
                      <td className={cn("px-2 py-2.5", edge)}>{currency(row.depositPaid)}</td>
                      <td className={cn("px-2 py-2.5", edge)}>{currency(row.oldDues)}</td>
                      <td className={cn("px-2 py-2.5", edge)}>{joinedDateText(row.joinedDate) || "—"}</td>
                      <td className={cn("max-w-48 truncate px-2 py-2.5", edge)}>{row.email || "—"}</td>
                      <td className={cn("px-2 py-2.5 text-xs", edge)}>
                        {row.residentId ? (
                          <SoftBadge tone="green">Added</SoftBadge>
                        ) : !checked?.bills ? (
                          "—"
                        ) : checked.bills.total === 0 ? (
                          "Nothing now"
                        ) : (
                          <>
                            {checked.bills.months.map((month) => (
                              <span className="block whitespace-nowrap" key={month.period}>
                                {month.label} {currency(month.amount)}
                              </span>
                            ))}
                            {checked.bills.oldDues > 0 ? (
                              <span className="block whitespace-nowrap">Old dues {currency(checked.bills.oldDues)}</span>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className={cn("px-2 py-2.5 pr-4", edge)}>
                        {row.residentId ? null : (
                          <button
                            aria-label={`Remove ${row.fullName || `line ${index + 1}`}`}
                            className="text-muted-foreground transition hover:text-destructive"
                            disabled={busy !== null}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeRow(row.id);
                            }}
                            type="button"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </td>
                    </tr>,
                    problems.length ? (
                      <tr className="bg-warning/5" key={`${row.id}-problems`}>
                        <td className="border-b border-border/60 px-4 pb-2.5 pl-11 text-xs text-warning" colSpan={9}>
                          <span className="inline-flex items-start gap-1.5">
                            <AlertTriangle className="mt-px size-3.5 shrink-0" />
                            {problems.map((problem) => problem.message).join(" · ")}
                          </span>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {pendingCount > 0 ? (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur">
          <p className="text-sm text-muted-foreground">
            {check?.withProblems ? (
              <span className="text-warning">
                {check.withProblems} {check.withProblems === 1 ? "line needs" : "lines need"} fixing — click a line to fix it
              </span>
            ) : check?.ready ? (
              <>
                {pendingCount} ready · {totals.months} {totals.months === 1 ? "month" : "months"} due ·{" "}
                {currency(totals.amount)} to bill
              </>
            ) : (
              `${pendingCount} in the list`
            )}
          </p>
          <div className="flex gap-2">
            <RoleButton
              disabled={busy !== null}
              onClick={() => void run("check", async () => void (await save(rows)))}
              tone={tone}
              type="button"
              variant="outline"
            >
              {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : null}
              Check list
            </RoleButton>
            <RoleButton
              disabled={busy !== null || !check?.ready}
              onClick={() => void addAll()}
              tone={tone}
              type="button"
            >
              {busy === "add" ? <Loader2 className="size-4 animate-spin" /> : null}
              Add all {pendingCount} residents
            </RoleButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
