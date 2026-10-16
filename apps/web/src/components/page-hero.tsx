"use client";

import type { ReactNode } from "react";

import { Glyph, type GlyphName } from "@/components/glyph";
import type { IconComponent } from "@/components/icons";
import { usePortalPageIcon } from "@/components/portal-page-context";

/**
 * A portal page's header block: near-black with a green glow, the page's mark
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
    <div className="dark relative overflow-hidden rounded-2xl bg-hero px-4 py-4 text-foreground shadow-sm ring-1 ring-white/5 md:px-5 md:py-[18px]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_140%_at_100%_0%,var(--hero-glow),transparent_60%)]"
      />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {Icon || navGlyph ? (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.08] text-role-team ring-1 ring-white/10">
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
              <p className="line-clamp-1 text-[12.5px] text-muted-foreground" title={description}>
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
