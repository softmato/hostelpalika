"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { ChevronDown } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Height animates 0 → auto through a grid row, so the panel opens and closes
 * smoothly without measuring it. The content stays in the HTML while closed, so
 * crawlers and LLMs still read it; `inert` keeps it out of the tab order.
 */
export function Collapse({ children, open }: { children: ReactNode; open: boolean }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** A "Read more" that opens smoothly; any number of them can be open at once. */
export function MoreToggle({
  children,
  defaultOpen = false,
  label = "Read more",
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mt-4 border-t border-border pt-3">
      <button
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 text-sm font-bold text-primary"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? "Show less" : label}
        <ChevronDown className={cn("size-4 transition-transform duration-300", open && "rotate-180")} />
      </button>
      <Collapse open={open}>
        <div className="pt-3">{children}</div>
      </Collapse>
    </div>
  );
}

/** One question open at a time: opening another closes the last. */
export function FaqAccordion({
  entries,
}: {
  entries: Array<{ answer: string; question: string }>;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
      {entries.map((entry, index) => {
        const open = openIndex === index;

        return (
          <div key={entry.question}>
            <button
              aria-expanded={open}
              className="flex w-full cursor-pointer items-center justify-between gap-4 px-5 py-4 text-left font-semibold text-foreground transition-colors hover:bg-primary/5"
              onClick={() => setOpenIndex(open ? null : index)}
              type="button"
            >
              {entry.question}
              <span
                aria-hidden
                className={cn(
                  "text-lg text-primary transition-transform duration-300",
                  open && "rotate-45",
                )}
              >
                +
              </span>
            </button>
            <Collapse open={open}>
              <p className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">
                {entry.answer}
              </p>
            </Collapse>
          </div>
        );
      })}
    </div>
  );
}

/** A feature area: header row toggles a smooth panel of its features; "View all" still links out. */
export function AreaAccordion({
  children,
  count,
  defaultOpen = false,
  href,
  icon,
  id,
  subtitle,
  title,
}: {
  children: ReactNode;
  count: number;
  defaultOpen?: boolean;
  href: string;
  icon: ReactNode;
  id: string;
  subtitle: string;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section id={id} className="hp-card scroll-mt-28 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 text-left"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {icon}
          <span className="min-w-0 flex-1">
            <span className="block font-heading text-lg font-bold text-foreground">
              {title}
              <span className="ml-2 text-sm font-semibold text-muted-foreground">{count}</span>
            </span>
            <span className="line-clamp-1 block text-sm text-muted-foreground">{subtitle}</span>
          </span>
          <ChevronDown
            className={cn("size-5 shrink-0 text-primary transition-transform duration-300", open && "rotate-180")}
          />
        </button>
        <Link
          className="hidden shrink-0 text-sm font-bold text-primary hover:underline sm:inline"
          href={href}
        >
          View all
        </Link>
      </div>
      <Collapse open={open}>
        <div className="pt-5">{children}</div>
      </Collapse>
    </section>
  );
}

/** A bordered box whose title row opens a smooth panel; the hover border comes from `hp-card`. */
export function ToggleCard({
  children,
  defaultOpen = false,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="hp-card rounded-2xl border border-border bg-surface px-5 py-4">
      <button
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-4 text-left font-heading text-base font-bold text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {title}
        <ChevronDown
          className={cn("size-5 shrink-0 text-primary transition-transform duration-300", open && "rotate-180")}
        />
      </button>
      <Collapse open={open}>
        <div className="pt-4">{children}</div>
      </Collapse>
    </div>
  );
}
