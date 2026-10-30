"use client";

import type { ReactNode } from "react";

import { Glyph, type GlyphName } from "@/components/glyph";
import type { IconComponent } from "@/components/icons";
import { usePortalPageIcon } from "@/components/portal-page-context";

/**
 * A portal page's header block: painted brand green, the page's mark
 * in a glass tile, the title, one line, and actions on the right.
 *
 * It wears `.dark` itself, so whatever a page passes as `actions` — outline
 * buttons, selects, tabs — re-themes to sit on the dark ground without a
 * per-page change. The line under the title is clamped to one: the header
 * names the page, it does not explain it.
 *
 * The mark is `icon` when a page passes one, else the glyph of the page's own
 * row in the sidebar (`PortalShell` provides it).
 */
export function PageHero({
  actions,
  breadcrumb,
  description,
  icon: Icon,
  title,
}: {
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  description?: string;
  icon?: IconComponent;
  title: string;
}) {
  const navGlyph: GlyphName | null = usePortalPageIcon();

  return (
    // On brand green, the dark theme's own green buttons and grey captions
    // would vanish: primary turns white-on-green, captions a soft white.
    <div className="dark relative overflow-hidden rounded-2xl bg-[linear-gradient(135deg,var(--hero),var(--hero-to))] px-4 py-4 text-white shadow-sm ring-1 ring-white/10 [--foreground:#ffffff] [--muted-foreground:rgb(255_255_255/0.9)] [--primary-foreground:#0a8a4b] [--primary:#ffffff] md:px-5 md:py-[18px]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_140%_at_100%_0%,var(--hero-glow),transparent_60%)]"
      />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {Icon || navGlyph ? (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/20">
              {Icon ? (
                <Icon className="size-[22px]" variant="solid" />
              ) : (
                <Glyph className="size-[22px]" name={navGlyph as GlyphName} variant="solid" />
              )}
            </span>
          ) : null}
          <div className="min-w-0">
            {breadcrumb}
            <h1 className="truncate font-heading text-lg font-bold tracking-tight md:text-xl">{title}</h1>
            {description ? (
              <p className="line-clamp-1 text-[12.5px] text-white/90" title={description}>
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {/* Outline/soft buttons carry green text meant for a white page; on the green hero they go white-on-glass. */}
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 [&_button[class*='border-role-']]:!border-white/40 [&_button[class*='border-role-']]:!bg-white/15 [&_button[class*='border-role-']]:!text-white [&_button[class*='border-role-']:hover]:!bg-white/25 [&_button[class*='border-role-']_svg]:!text-white [&_a[class*='border-role-']]:!border-white/40 [&_a[class*='border-role-']]:!bg-white/15 [&_a[class*='border-role-']]:!text-white">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
