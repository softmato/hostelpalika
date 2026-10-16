"use client";

import { Sparkles, Undo2 } from "@/components/icons";
import { useState } from "react";

import { cn } from "@/lib/utils";

type HostelType = "BOYS" | "CO_LIVING" | "GIRLS";

export type DescriptionFacts = {
  area?: string;
  city?: string;
  hostelName?: string;
  hostelType: HostelType;
  yearEstablished?: string;
};

const typeWords: Record<HostelType, string> = {
  BOYS: "boys' hostel",
  CO_LIVING: "co-living hostel",
  GIRLS: "girls' hostel",
};

/**
 * Starting points for a hostel description, written from whatever the form
 * already knows. Each one is a whole description, so picking one replaces the
 * box rather than appending to it — the Undo puts back what was there.
 */
const starters: { label: string; write: (f: Required<DescriptionFacts>) => string }[] = [
  {
    label: "For students",
    write: (f) =>
      `${opening(f, "a")} for students. Quiet rooms, a study-friendly routine and reliable Wi-Fi, close to colleges and coaching centres.`,
  },
  {
    label: "Home-like",
    write: (f) =>
      `${opening(f, "a")} that feels like home. Clean rooms, fresh home-cooked meals and caring staff who know every resident by name.`,
  },
  {
    label: "Working professionals",
    write: (f) =>
      `${opening(f, "a")} for working professionals. Flexible meal times, a calm place to rest after work and easy transport links.`,
  },
  {
    label: "Safe & secure",
    write: (f) =>
      `${opening(f, "a")} where safety comes first. CCTV, a warden on site, fixed gate hours and secure entry, so residents and parents can relax.`,
  },
  {
    label: "Affordable",
    write: (f) =>
      `${opening(f, "an affordable")}. Clean shared rooms, daily meals and all the essentials at a fair monthly rent.`,
  },
];

function opening(f: Required<DescriptionFacts>, article: string) {
  const name = f.hostelName.trim();
  const place = [f.area.trim(), f.city.trim()].filter(Boolean).join(", ");
  const subject = name ? `${name} is` : "We are";

  return `${subject} ${article} ${typeWords[f.hostelType]}${place ? ` in ${place}` : ""}`;
}

function since(year: string) {
  const value = Number(year.trim());
  const now = new Date().getFullYear();

  return Number.isInteger(value) && value >= 1950 && value <= now
    ? ` Running since ${value}.`
    : "";
}

export function DescriptionSuggestions({
  className,
  facts,
  onChange,
  value,
}: {
  className?: string;
  facts: DescriptionFacts;
  onChange: (next: string) => void;
  value: string;
}) {
  // What the box held before the last pick, and the text that pick wrote.
  // Undo only makes sense while the box still holds exactly that text.
  const [undo, setUndo] = useState<{ applied: string; previous: string } | null>(null);

  const full: Required<DescriptionFacts> = {
    area: facts.area ?? "",
    city: facts.city ?? "",
    hostelName: facts.hostelName ?? "",
    hostelType: facts.hostelType,
    yearEstablished: facts.yearEstablished ?? "",
  };
  const options = starters.map((starter) => ({
    label: starter.label,
    text: starter.write(full) + since(full.yearEstablished),
  }));
  const canUndo = undo !== null && undo.applied === value && undo.previous !== value;

  return (
    <div className={cn("mt-2", className)}>
      <span className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
        <Sparkles aria-hidden className="size-3.5 text-brand-teal" />
        Start from a suggestion
      </span>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = value.trim() === option.text;

          return (
            <button
              aria-pressed={active}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs font-semibold transition",
                active
                  ? "border-brand-teal bg-brand-teal/10 text-brand-teal"
                  : "border-border text-muted-foreground hover:border-brand-teal/40",
              )}
              key={option.label}
              onClick={() => {
                if (active) return;
                setUndo({ applied: option.text, previous: value });
                onChange(option.text);
              }}
              title={option.text}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
        {canUndo ? (
          <button
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
            onClick={() => {
              onChange(undo.previous);
              setUndo(null);
            }}
            type="button"
          >
            <Undo2 aria-hidden className="size-3.5" />
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}
