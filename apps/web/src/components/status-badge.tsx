import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type StatusBadgeProps = {
  children: ReactNode;
  className?: string;
  tone?:
    | "success"
    | "warning"
    | "danger"
    | "neutral"
    | "info"
    | "platform"
    | "admin"
    | "resident"
    | "guardian";
};

const toneClassName = {
  admin: "bg-role-admin-soft text-role-admin dark:bg-role-admin-soft/50",
  danger: "bg-red-50 text-danger ring-red-200 dark:bg-red-950/40 dark:ring-red-900",
  guardian: "bg-role-guardian-soft text-role-guardian dark:bg-role-guardian-soft/60",
  info: "bg-muted text-foreground ring-border",
  neutral:
    "bg-slate-100 text-muted-foreground ring-slate-200 dark:bg-slate-800 dark:ring-slate-700",
  platform: "bg-role-platform-soft text-role-platform dark:bg-role-platform-soft/50",
  resident: "bg-role-resident-soft text-role-resident dark:bg-role-resident-soft/70",
  success:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900",
  warning:
    "bg-amber-50 text-warning ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900",
};

export function StatusBadge({ children, className, tone = "neutral" }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ring-1 ring-inset",
        toneClassName[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
