"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session-store";

/**
 * A plan card's "Get plan": first asks whether the hostel is already on the
 * platform, in an iOS-style alert. Yes → the checkout that extends a running
 * plan; No → registration, as the button always did. A signed-in hostel admin
 * is already on the platform, so they skip the question and the email form.
 */
export function GetPlanButton({
  className,
  cycle,
  label,
  planId,
  registerHref,
}: {
  className: string;
  cycle: string;
  label: string;
  planId: string;
  registerHref: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const signedInAdmin = useSessionStore((state) => state.user?.role === Role.HOSTEL_ADMIN);
  const checkoutHref = `/plans-pricing/checkout?plan=${encodeURIComponent(planId)}&cycle=${cycle}`;
  const row =
    "flex h-11 w-full items-center justify-center border-t border-border/70 text-[16px] text-brand-teal transition active:bg-muted/70";

  return (
    <>
      <button
        className={className}
        onClick={() => (signedInAdmin ? router.push(checkoutHref) : setOpen(true))}
        type="button"
      >
        {label}
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          className="w-[380px] gap-0 overflow-hidden rounded-[14px] bg-card/95 p-0 text-center backdrop-blur-xl sm:max-w-[380px]"
          showCloseButton={false}
        >
          <div className="px-6 pb-5 pt-6">
            <DialogTitle className="text-[17px] font-semibold text-foreground">
              Is your hostel already on HostelPalika?
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13px] leading-snug text-muted-foreground">
              A running hostel can buy this plan now, and its current plan is extended.
            </DialogDescription>
          </div>
          <button
            className={cn(row, "font-semibold")}
            onClick={() => router.push(checkoutHref)}
            type="button"
          >
            Yes, it&apos;s running
          </button>
          <button
            className={row}
            onClick={() => router.push(`${registerHref}?plan=${encodeURIComponent(planId)}`)}
            type="button"
          >
            No, register it first
          </button>
          <button className={cn(row, "text-muted-foreground")} onClick={() => setOpen(false)} type="button">
            Cancel
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
