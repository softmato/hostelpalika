"use client";

import { hostelLeavePromise } from "@hostel/shared/constants/hostel-leave";
import { DoorOpen, Download, RotateCcw, ShieldCheck } from "@/components/icons";

import { useSiteConfig } from "@/components/site-config-provider";
import { cn } from "@/lib/utils";

const ICONS = [DoorOpen, Download, RotateCcw];

/**
 * "Your data stays yours" — leave any time, take everything, change your mind
 * within the hold (docs/HOSTEL_LEAVE_PLATFORM.md). On the plans page, plan
 * billing and KYC, so the owner knows it before they need it. `href` turns the
 * card into a door to the leave screen, for the owner already inside.
 */
export function LeavePromise({ className, href }: { className?: string; href?: string }) {
  const promise = hostelLeavePromise(useSiteConfig().leaveHold);

  return (
    <section className={cn("rounded-2xl border border-border bg-card p-5", className)}>
      <div className="mb-4 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-brand-teal-soft text-brand-teal">
          <ShieldCheck className="size-5" />
        </span>
        <h2 className="text-[15px] font-bold text-foreground">{promise.title}</h2>
        {href ? (
          <a className="ml-auto text-[12.5px] font-semibold text-brand-teal hover:underline" href={href}>
            How to leave
          </a>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {promise.points.map((point, index) => {
          const Icon = ICONS[index] ?? DoorOpen;

          return (
            <div className="rounded-xl bg-muted/50 p-3.5" key={point.title}>
              <Icon className="mb-2 size-4 text-brand-teal" />
              <p className="text-[13.5px] font-semibold text-foreground">{point.title}</p>
              <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">{point.body}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
