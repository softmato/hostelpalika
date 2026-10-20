"use client";

import { useState } from "react";

import { Download } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TableFormat } from "@/lib/downloads/downloader";

/** How far back a range export reaches, in BS months counting this one; 0 is everything. */
export const EXPORT_RANGES = [
  { label: "This month", months: 1 },
  { label: "Last 3 months", months: 3 },
  { label: "Last 6 months", months: 6 },
  { label: "Last 1 year", months: 12 },
  { label: "Everything", months: 0 },
] as const;

export type ExportPick = { choice: string; format: TableFormat; months: number; rangeLabel: string };

/**
 * Every export on the web: one button, CSV or PDF. Optionally a choice of
 * table (the Reports page's four) and a range — both remembered while the menu
 * is open, so picking them is a click each and the download is the last one.
 */
export function ExportMenu({
  choices,
  disabled,
  label = "Export",
  onExport,
  ranges = false,
}: {
  choices?: Array<{ id: string; label: string }>;
  disabled?: boolean;
  label?: string;
  onExport: (pick: ExportPick) => void;
  ranges?: boolean;
}) {
  const [choice, setChoice] = useState(choices?.[0]?.id ?? "");
  const [months, setMonths] = useState<number>(ranges ? 6 : 0);
  const rangeLabel = EXPORT_RANGES.find((range) => range.months === months)?.label ?? "Everything";

  const pick = (format: TableFormat) => onExport({ choice, format, months, rangeLabel });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-9 gap-2 rounded-xl" disabled={disabled} type="button" variant="outline">
          <Download className="size-4" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {choices ? (
          <>
            <DropdownMenuLabel>Report</DropdownMenuLabel>
            <DropdownMenuRadioGroup onValueChange={setChoice} value={choice}>
              {choices.map((entry) => (
                <DropdownMenuRadioItem key={entry.id} onSelect={(event) => event.preventDefault()} value={entry.id}>
                  {entry.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {ranges ? (
          <>
            <DropdownMenuLabel>Range</DropdownMenuLabel>
            <DropdownMenuRadioGroup onValueChange={(value) => setMonths(Number(value))} value={String(months)}>
              {EXPORT_RANGES.map((range) => (
                <DropdownMenuRadioItem
                  key={range.months}
                  onSelect={(event) => event.preventDefault()}
                  value={String(range.months)}
                >
                  {range.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => pick("pdf")}>
          <Download className="size-4" />
          Download PDF
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => pick("csv")}>
          <Download className="size-4" />
          Download CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
