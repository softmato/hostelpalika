"use client";

import { ChevronDown, Share2 } from "@/components/icons";
import Image from "next/image";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The pictures are drawn by `scripts/share-guide` (same files as the app). The
 * bank app in them is generic grey: no real bank's or wallet's colours.
 */
const STEPS = [
  "Open the payment in your bank or wallet app. Tap Share.",
  "Pick HostelPalika.",
  "Check the amount and month. Tap Send to hostel.",
  "Done. You'll get a notification when it's confirmed.",
] as const;

/**
 * "See how to share your receipt straight to the app" — collapsed to one row,
 * opening the four steps in place. In place rather than a dialog because the
 * claim form that carries it is already a modal.
 */
export function ShareReceiptSteps({
  className,
  onOpenChange,
  open: controlled,
}: {
  className?: string;
  onOpenChange?: (open: boolean) => void;
  /** Controlled by a page that widens the card when it opens; uncontrolled in the claim form. */
  open?: boolean;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;

  return (
    <div className={cn("rounded-xl bg-brand-teal/10", className)}>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] font-semibold text-brand-teal"
        onClick={() => {
          setInner(!open);
          onOpenChange?.(!open);
        }}
        type="button"
      >
        <Share2 aria-hidden className="size-4 shrink-0" />
        <span className="flex-1">See how to share your receipt straight to the app</span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform duration-500 ease-out", open && "rotate-180")}
        />
      </button>

      {/* 0fr -> 1fr animates the height without measuring it. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        inert={!open}
      >
        <ol className="grid min-h-0 grid-cols-2 gap-4 overflow-hidden px-3 sm:grid-cols-4">
          {STEPS.map((title, index) => (
            <li className="mx-auto mb-3 grid w-full max-w-[260px] content-start gap-2 first:mt-0" key={title}>
              <Image
                alt={`Step ${index + 1}: ${title}`}
                className="h-auto w-full rounded-2xl"
                height={1200}
                src={`/share-guide/step-${index + 1}.png`}
                width={600}
              />
              <p className="text-[12px] leading-4 text-muted-foreground">
                <span className="font-semibold text-foreground">{index + 1}. </span>
                {title}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
