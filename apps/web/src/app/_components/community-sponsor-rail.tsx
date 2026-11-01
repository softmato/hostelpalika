"use client";

import { apiFetch, apiUrl } from "@/lib/api-url";
import Link from "next/link";

import { useStickyBottom } from "@/hooks/use-sticky-bottom";

export type CommunitySponsor = {
  accentColor: string;
  ctaLabel: string;
  highlight: string;
  id: string;
  imageAssetId: string;
  imageUrl: string;
  kind: "COLLEGE" | "HOSTEL" | "BUSINESS" | "OTHER";
  linkUrl: string;
  name: string;
  subtitle: string;
};

export type PopularHostel = {
  id: string;
  name: string;
  rating: number | null;
  slug: string;
};

/** Fire-and-forget: a click-through must not wait on our own analytics. */
function recordClick(sponsorId: string) {
  void apiFetch(`/api/v1/community/sponsors/${sponsorId}/click`, {
    keepalive: true,
    method: "POST",
  }).catch(() => {});
}

function sponsorImage(sponsor: CommunitySponsor) {
  if (sponsor.imageUrl) {
    return sponsor.imageUrl;
  }

  return sponsor.imageAssetId
    ? apiUrl(`/api/v1/files/${sponsor.imageAssetId}/url?variant=MEDIUM`)
    : null;
}

function SponsorCard({ sponsor }: { sponsor: CommunitySponsor }) {
  const image = sponsorImage(sponsor);
  const isExternal = /^https?:\/\//i.test(sponsor.linkUrl);
  const body = (
    <>
      <div
        className="flex h-[110px] items-center justify-center bg-cover bg-center px-3 text-center text-[13px] font-bold tracking-wide text-white"
        style={
          image
            ? { backgroundImage: `url("${image}")` }
            : { backgroundColor: sponsor.accentColor }
        }
      >
        {image ? null : sponsor.name.toUpperCase()}
      </div>
      <div className="p-3.5">
        <p className="truncate text-sm font-bold text-foreground">{sponsor.name}</p>
        {sponsor.subtitle ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {sponsor.subtitle}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-[13px] font-bold text-foreground">
            {sponsor.highlight}
          </span>
          <span className="shrink-0 rounded-md bg-brand-teal-soft px-2.5 py-1 text-[11px] font-bold text-brand-teal">
            {sponsor.ctaLabel}
          </span>
        </div>
      </div>
    </>
  );

  const className =
    "block overflow-hidden rounded-xl border border-border bg-surface transition hover:border-brand-teal/40";

  if (!sponsor.linkUrl) {
    return <div className={className}>{body}</div>;
  }

  // An external sponsor link is a link off our site: `noopener` so the
  // destination cannot reach back through `window.opener`.
  return isExternal ? (
    <a
      className={className}
      href={sponsor.linkUrl}
      onClick={() => recordClick(sponsor.id)}
      rel="noopener noreferrer sponsored"
      target="_blank"
    >
      {body}
    </a>
  ) : (
    <Link
      className={className}
      href={sponsor.linkUrl}
      onClick={() => recordClick(sponsor.id)}
    >
      {body}
    </Link>
  );
}

/**
 * The right rail: paid placements, then a house ad, then popular hostels.
 *
 * Unlike the left rail — which pins immediately — this one scrolls fully into
 * view before it pins, so every sponsor card is actually seen. See
 * {@link useStickyBottom}.
 */
export function CommunitySponsorRail({
  popularHostels,
  sponsors,
}: {
  popularHostels: PopularHostel[];
  sponsors: CommunitySponsor[];
}) {
  const { ref, style } = useStickyBottom();

  return (
    <aside className="hidden self-start lg:block" ref={ref} style={style}>
      <div className="flex flex-col gap-4">
        {sponsors.length > 0 ? (
          <>
            <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
              Sponsored
            </p>
            {sponsors.map((sponsor) => (
              <SponsorCard key={sponsor.id} sponsor={sponsor} />
            ))}
          </>
        ) : null}

        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-center">
          <p className="mb-2 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
            Advertisement
          </p>
          <p className="text-[15px] font-bold text-foreground">Moving to a new city?</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Compare verified hostels near your campus in seconds.
          </p>
          <Link
            className="mt-2.5 inline-block rounded-lg bg-foreground px-4 py-2 text-[12.5px] font-bold text-background transition hover:opacity-90"
            href="/compare"
          >
            Compare Now
          </Link>
        </div>

        {popularHostels.length > 0 ? (
          <div className="rounded-xl border border-border p-4">
            <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
              Popular hostels
            </p>
            {popularHostels.map((hostel) => (
              <Link
                className="flex items-center justify-between gap-2 border-b border-border/60 py-1.5 last:border-b-0 hover:text-brand-teal"
                href={`/hostels/${hostel.slug}`}
                key={hostel.id}
              >
                <span className="truncate text-[13.5px] text-foreground">
                  {hostel.name}
                </span>
                <span className="shrink-0 text-xs font-bold text-brand-teal">
                  {hostel.rating ? `★ ${hostel.rating}` : "New"}
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
