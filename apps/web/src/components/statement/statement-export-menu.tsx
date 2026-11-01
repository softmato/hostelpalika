"use client";

import { addBsMonths } from "@hostel/shared/calendar/bs";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Download, FileText, Loader2, Minus, Plus, Table2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { hostelPeriodOf } from "@/lib/hostel-day";
import type { TableFormat } from "@/lib/downloads/downloader";
import { cn } from "@/lib/utils";

/** The same choices as the app's download sheet: how far back, which file. */
const SPANS = [
  { label: "1 month", value: "1" },
  { label: "3 months", value: "3" },
  { label: "6 months", value: "6" },
  { label: "1 year", value: "12" },
  { label: "All", value: "0" },
  { label: "Custom", value: "custom" },
] as const;

const PANEL_WIDTH = 320;

type Span = (typeof SPANS)[number]["value"];


/**
 * The statement's PDF and CSV buttons for the page header. They only pick the
 * file; hovering opens the range — how many months back, six to start — and the
 * Download button underneath does the download.
 * `from` is null for "All".
 */
export function StatementExportMenu({
  disabled,
  onExport,
}: {
  disabled?: boolean;
  onExport: (pick: { format: TableFormat; from: string | null; to: string }) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [span, setSpan] = useState<Span>("6");
  const [custom, setCustom] = useState(2);
  const [format, setFormat] = useState<TableFormat>("pdf");
  const [busy, setBusy] = useState(false);
  // Where the panel sits: it slides under whichever button the cursor is on.
  const wrap = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const slideTo = (target: HTMLElement) => {
    const box = wrap.current;

    if (!box) {
      return;
    }

    // Fixed and portalled: the page header clips anything that hangs below it.
    const rect = box.getBoundingClientRect();
    const hit = target.getBoundingClientRect();
    const centre = hit.left + hit.width / 2;

    setPos({
      // Follows the button, never past the container's right edge, never off the screen.
      left: Math.max(
        8,
        Math.min(
          window.innerWidth - PANEL_WIDTH - 8,
          rect.right,
          Math.max(rect.right - PANEL_WIDTH, centre - PANEL_WIDTH / 2),
        ),
      ),
      top: rect.bottom,
    });
    setOpen(true);
  };
  const months = span === "custom" ? custom : Number(span);

  const download = async () => {
    const to = hostelPeriodOf(new Date());

    setBusy(true);

    try {
      await onExport({ format, from: months > 0 ? addBsMonths(to, -(months - 1)) : null, to });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const button = (on: boolean) =>
    cn(
      "h-10 gap-2 rounded-xl !border px-4 !text-white hover:!bg-white/25 [&_svg]:!text-white",
      on ? "!border-white !bg-white/30" : "!border-white/40 !bg-white/15",
    );

  return (
    <div
      className="relative"
      onMouseLeave={() => setOpen(false)}
      ref={wrap}
    >
      <div className="flex items-center gap-2">
        <Button
          className={button(format === "pdf")}
          disabled={disabled}
          onClick={() => setFormat("pdf")}
          onFocus={(event) => slideTo(event.currentTarget)}
          onMouseEnter={(event) => slideTo(event.currentTarget)}
          type="button"
          variant="outline"
        >
          <FileText className="size-4" />
          PDF
        </Button>
        <Button
          className={button(format === "csv")}
          disabled={disabled}
          onClick={() => setFormat("csv")}
          onFocus={(event) => slideTo(event.currentTarget)}
          onMouseEnter={(event) => slideTo(event.currentTarget)}
          type="button"
          variant="outline"
        >
          <Table2 className="size-4" />
          CSV
        </Button>
      </div>

      {/* A hairline of padding above the card keeps the hover unbroken between button and panel. */}
      {createPortal(
      <div
        className={cn(
          "fixed z-50 pt-2 transition-[left,opacity,transform] duration-300 ease-out",
          open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
        )}
        style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH }}
      >
        <div className="space-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">How far back</p>
          <div className="grid grid-cols-3 gap-1.5">
            {SPANS.map((option) => (
              <button
                className={cn(
                  "h-9 rounded-lg border text-[12.5px] font-semibold transition-colors",
                  span === option.value
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border/70 text-muted-foreground hover:bg-muted/50",
                )}
                key={option.value}
                onClick={() => setSpan(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          {span === "custom" ? (
            <div className="flex items-center justify-between rounded-xl border border-border/70 px-3 py-1.5 text-[13px]">
              <span className="font-medium">Last</span>
              <span className="flex items-center gap-2">
                <button
                  aria-label="One month fewer"
                  className="flex size-7 items-center justify-center rounded-lg border border-border/70 disabled:opacity-40"
                  disabled={custom <= 2}
                  onClick={() => setCustom(custom - 1)}
                  type="button"
                >
                  <Minus className="size-3.5" />
                </button>
                <span className="min-w-20 text-center font-semibold">{custom} months</span>
                <button
                  aria-label="One month more"
                  className="flex size-7 items-center justify-center rounded-lg border border-border/70 disabled:opacity-40"
                  disabled={custom >= 24}
                  onClick={() => setCustom(custom + 1)}
                  type="button"
                >
                  <Plus className="size-3.5" />
                </button>
              </span>
            </div>
          ) : null}
          <Button className="mt-2 h-10 w-full gap-2 rounded-xl" disabled={busy} onClick={() => void download()} type="button">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Download {format.toUpperCase()}
          </Button>
        </div>
      </div>,
      document.body,
      )}
    </div>
  );
}
