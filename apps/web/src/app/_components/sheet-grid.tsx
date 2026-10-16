"use client";

import { Trash2, X } from "@/components/icons";
import {
  useEffect,
  type ClipboardEvent,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/**
 * A full-screen sheet that types like Excel: arrow keys and Enter move between
 * cells, Alt+Down opens a dropdown, rows copied from any spreadsheet paste in.
 *
 * Written for the existing-residents list (docs/EXISTING_RESIDENTS.md) and
 * shared with the hostel registration track sheet. The owner keeps the rows and
 * what their cells mean; this keeps the grid, the keys and the frame around it.
 */

export type SheetGridColumn = {
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  key: string;
  label: string;
  /** Dropdown choices for the cell's current value. A text box when absent. */
  options?: (value: string) => { label: string; value: string }[];
  /** Shown in the first line's empty box, as an example. */
  placeholder?: string;
  /** Filled in by the system — shown, never typed in. */
  readOnly?: boolean;
  width: number;
};

export type SheetGridRow = { cells: Record<string, string>; key: string };

export type SheetCell = { column: number; row: number };

type Props<Row extends SheetGridRow> = {
  actions: ReactNode;
  active: SheetCell;
  cellTitle?: (row: Row, column: string) => string | undefined;
  /** Rendered inside the frame — a confirm dialog, say. */
  children?: ReactNode;
  columns: readonly SheetGridColumn[];
  isFlagged?: (row: Row, column: string) => boolean;
  /** A line that is shown but can't be changed or removed — already added, or somebody else's for now. */
  isLocked?: (row: Row) => boolean;
  /** Somebody else's for now: none of its cells can be clicked, and the arrow keys skip it. */
  isHeld?: (row: Row) => boolean;
  label: string;
  /** Somebody else is on this line: it is tinted, with this said on it. */
  lineNote?: (row: Row) => string | null;
  /** The number beside a line, when it is not its place in `rows`. */
  lineNumber?: (row: Row, index: number) => number;
  /** Shown in place of a line's number until it is hovered. */
  marker?: (row: Row) => ReactNode;
  onActiveChange: (cell: SheetCell) => void;
  onCellChange: (row: Row, column: string, value: string) => void;
  /** Shows the sheet as a dialog over the page, with a close button. Without it, the sheet is the page. */
  onClose?: () => void;
  /** Adds lines under the last one when the cursor moves past it. */
  onGrow?: () => void;
  /** The cursor left the grid. */
  onLeave?: () => void;
  /** Cells copied from a spreadsheet, pasted with the cursor at `at`. */
  onPaste?: (at: SheetCell, text: string) => void;
  onRemove?: (row: Row) => void;
  /** The line the cursor starts on. */
  openAt?: number;
  rows: Row[];
  /** Footer, left: what the cursor is on. */
  status: ReactNode;
  subtitle?: ReactNode;
  /** Footer, right: the count. */
  summary: ReactNode;
  title: ReactNode;
};

const cellInput =
  "block h-9 w-full min-w-0 truncate bg-transparent px-2 text-[13px] text-foreground outline-none focus:bg-background focus:ring-2 focus:ring-inset focus:ring-brand-teal read-only:text-muted-foreground [&>option]:bg-background [&>option]:text-foreground";

/** The line-number column; the pinned first column starts where it ends. */
const NUMBER_WIDTH = 48;

function cellAt(row: number, column: number) {
  return document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-cell="${row}:${column}"]`);
}

export function focusCell(row: number, column: number) {
  const cell = cellAt(row, column);

  cell?.focus();
  if (cell instanceof HTMLInputElement) cell.select();
}

function cellOf(target: EventTarget | null) {
  const at = (target as HTMLElement | null)?.dataset?.cell?.split(":").map(Number);

  return at ? { column: at[1]!, row: at[0]! } : null;
}

export function SheetGrid<Row extends SheetGridRow>({
  actions,
  active,
  cellTitle,
  children,
  columns,
  isFlagged,
  isLocked,
  isHeld,
  label,
  lineNote,
  lineNumber,
  marker,
  onActiveChange,
  onCellChange,
  onClose,
  onGrow,
  onLeave,
  onPaste,
  onRemove,
  openAt,
  rows,
  status,
  subtitle,
  summary,
  title,
}: Props<Row>) {
  const sheetWidth = NUMBER_WIDTH + columns.reduce((sum, column) => sum + column.width, 0);

  useEffect(() => {
    const overflow = document.body.style.overflow;

    if (onClose) document.body.style.overflow = "hidden";
    if (openAt !== undefined) focusCell(openAt, 0);

    return () => {
      document.body.style.overflow = overflow;
    };
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function move(row: number, column: number, step = 0) {
    const nextColumn = Math.min(Math.max(column, 0), columns.length - 1);
    let nextRow = Math.max(row, 0);

    while (step && rows[nextRow] && isHeld?.(rows[nextRow]!)) nextRow += step;
    if (nextRow < 0) return;

    if (nextRow >= rows.length) {
      if (!onGrow) return;

      onGrow();
      requestAnimationFrame(() => focusCell(nextRow, nextColumn));

      return;
    }

    focusCell(nextRow, nextColumn);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const at = cellOf(event.target);

    if (!at) return;

    const { column, row } = at;
    const text = event.target instanceof HTMLInputElement ? event.target : null;

    switch (event.key) {
      case "ArrowUp":
        move(row - 1, column, -1);
        break;
      case "ArrowDown":
        // Alt+Down opens a dropdown cell, as it does in Excel.
        if (event.altKey && !text) return;
        move(row + 1, column, 1);
        break;
      case "Enter":
        move(event.shiftKey ? row - 1 : row + 1, column, event.shiftKey ? -1 : 1);
        break;
      case "ArrowLeft":
        if (text && (text.selectionStart !== 0 || text.selectionEnd !== 0)) return;
        move(row, column - 1);
        break;
      case "ArrowRight":
        if (text && text.selectionEnd !== text.value.length) return;
        move(row, column + 1);
        break;
      case "Backspace":
      case "Delete": {
        // A dropdown box clears the way a typed box does.
        const line = rows[row];
        const cell = columns[column];

        if (text || !line || !cell || cell.readOnly || isLocked?.(line)) return;
        onCellChange(line, cell.key, "");
        break;
      }
      default:
        return;
    }

    event.preventDefault();
  }

  function paste(event: ClipboardEvent<HTMLTableElement>) {
    const at = cellOf(event.target);
    const text = event.clipboardData.getData("text/plain").replace(/\r?\n$/, "");

    // One plain value pastes into its box as usual; cells copied from a sheet spread out.
    if (!onPaste || !at || (!text.includes("\t") && !text.includes("\n"))) return;

    event.preventDefault();
    onPaste(at, text);
  }

  function blur(event: FocusEvent<HTMLTableElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave?.();
  }

  const frame = (
    <div
      className={cn("fixed inset-0 flex flex-col bg-background", onClose && "z-50")}
      {...(onClose ? { "aria-label": label, "aria-modal": true, role: "dialog" } : {})}
    >
      {children}

      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-foreground">{title}</p>
          {subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {onClose ? (
            <button
              aria-label="Close sheet"
              className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={onClose}
              type="button"
            >
              <X className="size-5" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <table
          aria-label={onClose ? undefined : label}
          className="w-full table-fixed border-separate border-spacing-0 text-left"
          onBlur={blur}
          onFocus={(event) => {
            const at = cellOf(event.target);

            if (at) onActiveChange(at);
          }}
          onKeyDown={onKeyDown}
          onPaste={paste}
          style={{ minWidth: sheetWidth }}
        >
          <colgroup>
            <col style={{ width: NUMBER_WIDTH }} />
            {columns.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
            {/* Takes whatever width is left, so the columns above keep theirs. */}
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 border-b border-r border-border bg-muted px-2 py-2 text-[11px] font-semibold text-muted-foreground" />
              {columns.map((column, index) => (
                <th
                  className={cn(
                    "sticky top-0 z-20 border-b border-r border-border bg-muted px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                    index === 0 && "left-12 z-30",
                    active.column === index && "text-brand-teal",
                  )}
                  key={column.key}
                >
                  <span className="block truncate">{column.label}</span>
                </th>
              ))}
              <th className="sticky top-0 z-20 border-b border-border bg-muted" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const held = isHeld?.(row) ?? false;
              const locked = held || (isLocked?.(row) ?? false);
              const note = lineNote?.(row) ?? null;
              const number = lineNumber?.(row, rowIndex) ?? rowIndex + 1;
              const mark = marker?.(row);

              return (
                <tr className="group" key={row.key}>
                  <td
                    className={cn(
                      "sticky left-0 z-10 border-b border-r border-border bg-muted px-1 text-center text-[11px] text-muted-foreground",
                      // A layer over the solid fill, so the pinned column stays opaque.
                      note && "bg-linear-to-r from-warning/25 to-warning/25 text-foreground",
                      active.row === rowIndex && "font-semibold text-brand-teal",
                    )}
                  >
                    <span className="group-hover:hidden">{mark ?? number}</span>
                    {locked || !onRemove ? (
                      <span className="hidden group-hover:inline">{number}</span>
                    ) : (
                      <button
                        aria-label={`Remove line ${number}`}
                        className="mx-auto hidden text-muted-foreground hover:text-destructive group-hover:block"
                        onClick={() => onRemove(row)}
                        tabIndex={-1}
                        type="button"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </td>
                  {columns.map((column, columnIndex) => {
                    const value = row.cells[column.key] ?? "";
                    const choices = column.options?.(value);
                    const cellProps = {
                      "aria-label": `${column.label}, line ${number}`,
                      "data-cell": `${rowIndex}:${columnIndex}`,
                      disabled: held,
                    };

                    let control;

                    if (locked || column.readOnly) {
                      const shown = choices?.find((option) => option.value === value)?.label ?? value;

                      control = (
                        <input
                          {...cellProps}
                          className={cn(cellInput, held && "cursor-not-allowed")}
                          readOnly
                          value={shown}
                        />
                      );
                    } else if (choices) {
                      control = (
                        <select
                          {...cellProps}
                          className={cellInput}
                          onChange={(event) => onCellChange(row, column.key, event.target.value)}
                          value={value}
                        >
                          <option disabled hidden value="" />
                          {choices.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      );
                    } else {
                      control = (
                        <input
                          {...cellProps}
                          className={cellInput}
                          inputMode={column.inputMode}
                          onChange={(event) => onCellChange(row, column.key, event.target.value)}
                          placeholder={rowIndex === 0 ? column.placeholder : undefined}
                          value={value}
                        />
                      );
                    }

                    return (
                      <td
                        className={cn(
                          "border-b border-r border-border bg-background p-0",
                          columnIndex === 0 && "sticky left-12 z-10",
                        )}
                        key={column.key}
                        title={cellTitle?.(row, column.key)}
                      >
                        {/* The tint sits inside, so the pinned first column stays solid when scrolled under. */}
                        <div
                          className={cn(
                            note ? "bg-warning/15" : (locked || column.readOnly) && "bg-muted/50",
                            isFlagged?.(row, column.key) && "ring-1 ring-inset ring-warning",
                          )}
                        >
                          {control}
                        </div>
                        {note && columnIndex === 0 ? (
                          <span className="pointer-events-none absolute right-1 top-1/2 max-w-[75%] -translate-y-1/2 truncate rounded bg-background px-1.5 py-0.5 text-[10px] font-semibold text-foreground ring-1 ring-warning">
                            {note}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                  <td className="border-b border-border" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/60 px-4 py-2 text-xs">
        <p className="min-w-0 flex-1 truncate">{status}</p>
        <p className="text-muted-foreground">{summary}</p>
      </footer>
    </div>
  );

  return onClose ? createPortal(frame, document.body) : frame;
}
