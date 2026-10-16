"use client";

import { X } from "@/components/icons";
import type { ReactNode } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The shell the two payment flows open in — *Pay now* and *Submit proof*.
 *
 * **Why a modal and not the inline panel they used to be.** Both flows were
 * sections spliced into the middle of Fees & Payments, which put them below the
 * focus card and above four metric tiles and a history table. Three problems, all
 * of them layout rather than content:
 *
 * 1. **They opened off-screen.** Tapping `Pay now` on a phone injected a panel
 *    where the page happened to be scrolled, so the commonest outcome was a
 *    screen that visibly reflowed and appeared to do nothing.
 * 2. **The page competed with the step.** A resident copying a reference code
 *    into a banking app was doing it beside an outstanding total, a status
 *    filter and every month they had ever paid.
 * 3. **Neither had a bottom.** The submit button sat wherever the form ended,
 *    with the metric tiles immediately beneath it.
 *
 * A modal fixes all three by construction: it is centred wherever they are, it
 * dims what is not the step, and it has an edge to pin the action to.
 *
 * **Header, scroll, footer.** The header carries the one-line answer to *what am
 * I doing and for how much*, and stays put. Only the middle scrolls. The footer
 * holds the action and is likewise fixed, so the button is reachable on a phone
 * without scrolling past a receipt preview to find it.
 *
 * Closing is deliberately ordinary — backdrop, escape, the X — because both
 * flows are abandonable at any point and nothing is lost by leaving.
 */
export function ResidentFlowModal({
  amount,
  badge,
  children,
  description,
  footer,
  onClose,
  title,
  wide = false,
}: {
  /** The figure this step is about, rendered as the header's right-hand anchor. */
  amount?: ReactNode;
  /** Sits under the title — the Resident Offer Program mark, on both flows. */
  badge?: ReactNode;
  children: ReactNode;
  description?: string;
  /** Pinned to the bottom edge. Omit on a step with no single action. */
  footer?: ReactNode;
  onClose: () => void;
  title: string;
  /** The pay screen is a two-column checkout and needs the extra width. */
  wide?: boolean;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        className={cn(
          "flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0",
          wide
            ? "w-[min(980px,calc(100%-1.5rem))] sm:max-w-[980px]"
            : "w-[min(680px,calc(100%-1.5rem))] sm:max-w-[680px]",
        )}
        showCloseButton={false}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 bg-card px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="font-heading text-base font-bold text-foreground">
              {title}
            </DialogTitle>
            {description ? (
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                {description}
              </p>
            ) : null}
            {badge ? <div className="mt-2">{badge}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {amount}
            <button
              aria-label={`Close ${title.toLowerCase()}`}
              className="rounded-lg border border-border p-2 transition hover:bg-muted"
              onClick={onClose}
              type="button"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        {/* The only part that scrolls. `min-h-0` is what makes that true inside a
            flex column — without it the body sizes to its content and the whole
            dialog scrolls, taking the pinned footer with it. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="shrink-0 border-t border-border/60 bg-card px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The header's right-hand figure: a label over a number, right-aligned. */
export function ModalAmount({ label, value }: { label: string; value: string }) {
  return (
    <div className="hidden text-right sm:block">
      <p className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="font-heading text-xl font-bold text-foreground">{value}</p>
    </div>
  );
}
