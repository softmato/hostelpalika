import { Building2, CalendarCheck, Users, Utensils, Wallet } from "@/components/icons";

import { cn } from "@/lib/utils";

const HERO_CHIPS = [
  { Icon: Users, label: "Residents", pos: "left-0 top-6" },
  { Icon: Wallet, label: "Rent", pos: "right-0 top-0" },
  { Icon: Utensils, label: "Food", pos: "left-6 bottom-8" },
  { Icon: CalendarCheck, label: "Attendance", pos: "right-4 bottom-0" },
] as const;

/** Decorative hero art for the owner software page — icons only, no copy to translate. */
export function SoftwareHeroVisual() {
  return (
    <div aria-hidden className="relative mx-auto hidden h-80 w-full max-w-md lg:block">
      <div className="absolute inset-6 rounded-[2.5rem] bg-primary/10" />
      <div className="absolute left-1/2 top-1/2 flex size-36 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[2rem] bg-primary text-primary-foreground shadow-xl">
        <Building2 className="size-16" />
      </div>
      {HERO_CHIPS.map(({ Icon, label, pos }) => (
        <div
          className={cn(
            "absolute flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold text-foreground shadow-md",
            pos,
          )}
          key={label}
        >
          <Icon className="size-4 text-primary" />
          {label}
        </div>
      ))}
    </div>
  );
}
