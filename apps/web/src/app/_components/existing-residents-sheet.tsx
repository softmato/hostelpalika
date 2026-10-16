"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "@/components/icons";
import { useMemo, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import type { CheckResult, ListRow } from "@/modules/residents/existing-residents-check";
import {
  AUTO_COLUMNS,
  autoFill,
  blankSheetRow,
  cleanCell,
  columnOfProblem,
  isBlankSheetRow,
  pasteIntoSheet,
  readSheet,
  rentStatusOptions,
  SHEET_COLUMNS,
  sheetFrom,
  type SheetColumn,
  type SheetContext,
  type SheetOutRow,
  type SheetRow,
} from "@/modules/residents/existing-residents-sheet-model";

import { RoleButton } from "./portal-dashboard-ui";
import { focusCell, SheetGrid, type SheetGridColumn } from "./sheet-grid";

/**
 * "Fill in sheet" — the Excel file's columns as a full-screen grid, for anyone
 * whose Excel won't type (docs/EXISTING_RESIDENTS.md). Arrow keys and Enter move
 * between cells, rows copied from any spreadsheet paste in, and saving writes
 * straight to the same list the page shows — no file to download and upload.
 */

type Props = {
  check: CheckResult | null;
  currentPeriod: string;
  hostelName: string;
  onClose: () => void;
  /** Saves the lines and returns the checked list. */
  onSave: (rows: SheetOutRow[]) => Promise<{ check: CheckResult | null; rows: ListRow[] }>;
  /** The list line to put the cursor on. */
  openAt?: string | null;
  /** Numbered rooms when the hostel keeps floors and rooms; null hides the Room no. column. */
  numberedRooms: { floor: number; free: number; number: string; roomType: string }[] | null;
  /** Each room type with its rate-card rent, which fills the rent box. */
  rooms: SheetContext["rooms"];
  rows: ListRow[];
  tone: "admin" | "platform";
};

/** "Ground floor", "1st floor", "Basement". */
function floorName(floor: number) {
  if (floor === 0) return "Ground floor";
  if (floor < 0) return floor === -1 ? "Basement" : `Basement ${-floor}`;
  const tens = floor % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[floor % 10] ?? "th";
  return `${floor}${suffix} floor`;
}

const INPUT_MODES: Partial<Record<SheetColumn, SheetGridColumn["inputMode"]>> = {
  depositPaid: "numeric",
  email: "email",
  joinedDate: "numeric",
  monthlyRent: "numeric",
  oldDues: "numeric",
  phone: "tel",
};

export function ExistingResidentsSheet({
  check: firstCheck,
  currentPeriod,
  hostelName,
  numberedRooms,
  onClose,
  onSave,
  openAt,
  rooms,
  rows: listRows,
  tone,
}: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const context = useMemo(() => ({ currentPeriod, numberedRooms, rooms }), [currentPeriod, numberedRooms, rooms]);
  const [rows, setRows] = useState<SheetRow[]>(() => sheetFrom(listRows, context));
  const [check, setCheck] = useState(firstCheck);
  // Lines typed in since the last check — their old problems no longer apply.
  const [edited, setEdited] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState({ column: 0, row: 0 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  // The line asked for, or the first empty line under the list.
  const [startAt] = useState(() => {
    const chosen = listRows.findIndex((row) => row.id === openAt);

    return chosen >= 0 ? chosen : listRows.length;
  });

  const columns = useMemo(() => {
    const roomTypes = rooms.map((room) => room.roomType);

    // Room no. is last, so hiding it moves no other column (paste maps by position).
    return SHEET_COLUMNS.filter((column) => column.key !== "roomNumber" || numberedRooms).map((column): SheetGridColumn => ({
      ...column,
      inputMode: INPUT_MODES[column.key],
      options:
        column.key === "roomNumber"
          ? () =>
              (numberedRooms ?? []).map((room) => ({
                label: `${room.number} · ${floorName(room.floor)} · ${room.roomType} (${room.free} free)`,
                value: room.number,
              }))
          : column.key === "roomType"
          ? (value) => [
              ...(value && !roomTypes.includes(value) ? [value] : []),
              ...roomTypes,
            ].map((room) => ({ label: room, value: room }))
          : column.key === "paidTill"
            ? (value) => rentStatusOptions(currentPeriod, value || null)
            : undefined,
      placeholder: column.key === "joinedDate" ? "2082-04-15" : undefined,
      readOnly: AUTO_COLUMNS.includes(column.key),
    }));
  }, [currentPeriod, numberedRooms, rooms]);

  const read = useMemo(() => readSheet(rows), [rows]);
  const cellErrors = useMemo(
    () => new Map(read.errors.map((error) => [`${error.key}:${error.column}`, error.message])),
    [read],
  );
  const problems = useMemo(() => new Map((check?.rows ?? []).map((row) => [row.id, row.problems])), [check]);

  const problemsOf = (row: SheetRow) =>
    row.id && !edited.has(row.key) && !isBlankSheetRow(row) ? (problems.get(row.id) ?? []) : [];
  const changed = edited.size > 0;
  const filled = rows.filter((row) => !isBlankSheetRow(row)).length;
  const withProblems = rows.filter((row) => problemsOf(row).length > 0).length;

  function setCell(key: string, column: SheetColumn, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.key === key
          ? { ...row, cells: autoFill({ ...row.cells, [column]: cleanCell(column, value) }, row.cells, context) }
          : row,
      ),
    );
    setEdited((current) => (current.has(key) ? current : new Set(current).add(key)));
  }

  function onPaste(at: { column: number; row: number }, text: string) {
    const next = pasteIntoSheet(rows, at, text, context);

    setRows(next);
    setEdited((current) => {
      const keys = new Set(current);

      next.forEach((line, index) => {
        if (line !== rows[index]) keys.add(line.key);
      });

      return keys;
    });
  }

  function removeLine(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
    setEdited((current) => new Set(current).add(key));
  }

  async function save(close: boolean) {
    const firstError = read.errors[0];

    if (firstError) {
      const row = rows.findIndex((line) => line.key === firstError.key);

      setMessage(`Line ${row + 1}: ${firstError.message}`);
      focusCell(row, SHEET_COLUMNS.findIndex((column) => column.key === firstError.column));

      return;
    }

    setSaving(true);
    setMessage("");

    try {
      const result = await onSave(read.rows);

      if (close) {
        onClose();

        return;
      }

      setRows(sheetFrom(result.rows, context));
      setCheck(result.check);
      setEdited(new Set());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function close() {
    if (changed) {
      const ok = await confirm({
        actionLabel: "Close without saving",
        description: "What you typed in the sheet is not saved to the list.",
        title: "Close without saving?",
        tone: "destructive",
      });

      if (!ok) return;
    }

    onClose();
  }

  function nextProblem() {
    for (let step = 1; step <= rows.length; step += 1) {
      const index = (active.row + step) % rows.length;
      const found = problemsOf(rows[index]!)[0];

      if (found) {
        focusCell(index, SHEET_COLUMNS.findIndex((column) => column.key === columnOfProblem(found.field)));

        return;
      }
    }
  }

  const activeRow = rows[active.row];
  const activeError = activeRow ? cellErrors.get(`${activeRow.key}:${SHEET_COLUMNS[active.column]?.key}`) : undefined;
  const activeProblems = activeRow ? problemsOf(activeRow) : [];

  return (
    <SheetGrid
      actions={
        <>
          {withProblems ? (
            <RoleButton onClick={nextProblem} tone={tone} type="button" variant="outline">
              <AlertTriangle className="size-4 text-warning" />
              Next problem
            </RoleButton>
          ) : null}
          <RoleButton disabled={saving} onClick={() => void save(false)} tone={tone} type="button" variant="outline">
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save and check
          </RoleButton>
          <RoleButton disabled={saving} onClick={() => void save(true)} tone={tone} type="button">
            Save and close
          </RoleButton>
        </>
      }
      active={active}
      cellTitle={(row, column) => cellErrors.get(`${row.key}:${column}`)}
      columns={columns}
      isFlagged={(row, column) =>
        cellErrors.has(`${row.key}:${column}`) ||
        problemsOf(row).some((problem) => columnOfProblem(problem.field) === column)
      }
      isLocked={(row) => Boolean(row.residentId)}
      label="Residents sheet"
      marker={(row) => (row.residentId ? <CheckCircle2 className="mx-auto size-3.5 text-success" /> : null)}
      onActiveChange={setActive}
      onCellChange={(row, column, value) => setCell(row.key, column as SheetColumn, value)}
      onClose={() => void close()}
      onGrow={() => setRows((current) => [...current, ...Array.from({ length: 10 }, blankSheetRow)])}
      onPaste={onPaste}
      onRemove={(row) => removeLine(row.key)}
      openAt={startAt}
      rows={rows}
      status={
        message ? (
          <span className="text-destructive">{message}</span>
        ) : activeError ? (
          <span className="text-warning">
            Line {active.row + 1} · {activeError}
          </span>
        ) : activeProblems.length ? (
          <span className="text-warning">
            Line {active.row + 1} · {activeProblems.map((problem) => problem.message).join(" · ")}
          </span>
        ) : activeRow?.residentId ? (
          <span className="text-muted-foreground">Line {active.row + 1} · Already added as a resident</span>
        ) : (
          <span className="text-muted-foreground">
            Line {active.row + 1} · {SHEET_COLUMNS[active.column]?.label}
            {AUTO_COLUMNS.includes(SHEET_COLUMNS[active.column]!.key) ? " · fills itself from the rate card" : null}
          </span>
        )
      }
      subtitle="Works like Excel: arrow keys and Enter move between boxes. Copy rows from any sheet and paste them here."
      summary={
        <>
          {filled} {filled === 1 ? "resident" : "residents"}
          {changed ? " · not saved" : withProblems ? ` · ${withProblems} need fixing` : ""}
        </>
      }
      title={`Residents sheet · ${hostelName}`}
    >
      {confirmDialog}
    </SheetGrid>
  );
}
