"use client";

import { formatHostelDate, hostelDayEnd } from "@hostel/shared/calendar/bs";
import { useEffect, useState } from "react";

import { Glyph } from "@/components/glyph";

const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kathmandu", weekday: "short" });

const label = (now: Date) => `${weekday.format(now)} · ${formatHostelDate(now)}`;

/**
 * Today in Nepal, for the portal header. One timeout to the next Nepal midnight — no
 * interval — and empty until mounted so the server's clock never mismatches.
 */
export function TodayChip({ className = "" }: { className?: string }) {
  const [text, setText] = useState("");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = new Date();
      setText(label(now));
      timer = setTimeout(tick, hostelDayEnd(now).getTime() - now.getTime() + 1000);
    };

    tick();
    return () => clearTimeout(timer);
  }, []);

  return (
    <span
      aria-live="off"
      className={`h-10 whitespace-nowrap items-center gap-2 rounded-xl bg-muted px-3 text-[12.5px] font-semibold text-foreground transition-all duration-500 ${className} ${text ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"}`}
    >
      <Glyph className="size-4 shrink-0 text-role-team" name="time" />
      {text || " "}
    </span>
  );
}
