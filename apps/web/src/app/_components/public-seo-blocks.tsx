import { ArrowRight } from "@/components/icons";
import Image from "next/image";
import Link from "next/link";

import {
  PLATFORM_NAME,
  PLATFORM_VENDOR,
  PLATFORM_VENDOR_URL,
} from "@hostel/shared/brand/brand";

import { cn } from "@/lib/utils";

import { StarsCtaCard } from "./stars-cta-card";

/**
 * The pieces the search landing pages share — location pages, the software
 * page, feature pages, comparisons. Server components, so everything they draw
 * is in the first response.
 */

export function SeoChip({
  active = false,
  count,
  href,
  label,
}: {
  active?: boolean;
  count?: number;
  href: string;
  label: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-surface text-foreground hover:border-primary/50 hover:text-primary",
      )}
      href={href}
    >
      {label}
      {count !== undefined ? (
        <span
          className={cn(
            "text-xs font-bold",
            active ? "text-primary-foreground/80" : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

export function SeoCrumbs({
  className,
  items,
}: {
  className?: string;
  items: Array<{ name: string; path: string }>;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "mb-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-muted-foreground",
        className,
      )}
    >
      {items.map((crumb, index) => (
        <span className="flex items-center gap-2" key={crumb.path}>
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          ) : null}
          {index === items.length - 1 ? (
            <span className="font-bold text-foreground">{crumb.name}</span>
          ) : (
            <Link className="transition hover:text-primary" href={crumb.path}>
              {crumb.name}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

/** Visible FAQ — the same entries a page's FAQPage record states. */
export function SeoFaq({
  entries,
  title,
}: {
  entries: Array<{ answer: string; question: string }>;
  title: string;
}) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="mt-16 max-w-3xl">
      <h2 className="font-heading text-2xl font-bold text-foreground">{title}</h2>
      <div className="mt-6 divide-y divide-border rounded-2xl border border-border bg-surface">
        {entries.map((entry, index) => (
          <details className="group px-5 py-4" key={entry.question} open={index === 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-foreground">
              {entry.question}
              <span
                aria-hidden
                className="text-lg text-primary transition group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {entry.answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function OwnerCallout({ body, title }: { body: string; title: string }) {
  return (
    <StarsCtaCard contentClassName="p-6 text-white sm:p-8">
      <h2 className="font-heading text-xl font-bold">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-emerald-50/90">{body}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Link
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-bold text-primary transition hover:bg-emerald-50"
          href="/register-hostel"
        >
          List your hostel
          <ArrowRight className="size-4" />
        </Link>
        <Link
          className="inline-flex items-center rounded-lg border border-white/50 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          href="/plans-pricing"
        >
          See plans & pricing
        </Link>
      </div>
    </StarsCtaCard>
  );
}

/** "HostelPalika is a product of Softmato", with Softmato's own logo and site. */
export function SoftmatoCredit({ className }: { className?: string }) {
  return (
    <a
      className={cn(
        "inline-flex items-center gap-3 rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-semibold text-neutral-600 transition hover:border-primary/50",
        className,
      )}
      href={PLATFORM_VENDOR_URL}
      rel="noopener"
      target="_blank"
    >
      <span>{PLATFORM_NAME} is a product of</span>
      <Image
        alt={PLATFORM_VENDOR}
        className="h-10 w-auto"
        height={776}
        src="/brand/softmato.png"
        width={1032}
      />
    </a>
  );
}
