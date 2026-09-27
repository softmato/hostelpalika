"use client";

import { Building2 } from "lucide-react";

/**
 * "Which hostel am I working in?" — for an owner with branches.
 *
 * Every tab below it works on the one hostel chosen here: the URL carries its
 * slug, and every request says so (`x-hostel-id`, see `browser-api.ts`). The
 * dashboard's Branches card is the only view across all of them.
 *
 * A full navigation rather than a client route change, keeping the screen the
 * owner is on: a fresh page means nothing from the last hostel is left in any
 * component's state.
 */
export function HostelWorkspaceSwitcher({
  current,
  hostels,
}: {
  current: string;
  hostels: Array<{ isBranch: boolean; name: string; slug: string }>;
}) {
  if (hostels.length < 2) return null;

  function open(slug: string) {
    const rest = window.location.pathname.replace(/^\/[^/]+\/admin/, "");

    window.location.assign(`/${encodeURIComponent(slug)}/admin${rest}${window.location.search}`);
  }

  return (
    <label className="relative inline-flex min-w-0 items-center">
      <span className="sr-only">Switch hostel</span>
      <Building2 aria-hidden="true" className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
      <select
        className="h-8 max-w-[14rem] truncate rounded-lg border border-border bg-background py-0 pl-8 pr-7 text-[12.5px] font-semibold text-foreground shadow-sm outline-none focus:border-brand-teal"
        onChange={(event) => open(event.target.value)}
        value={current}
      >
        {hostels.map((hostel) => (
          <option key={hostel.slug} value={hostel.slug}>
            {hostel.name}
            {hostel.isBranch ? " (branch)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
