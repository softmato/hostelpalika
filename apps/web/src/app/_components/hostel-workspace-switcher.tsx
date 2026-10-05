"use client";

import { Loader2 } from "lucide-react";
import { Glyph } from "@/components/glyph";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { OVERALL_SLUG } from "@/lib/branch-cache";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Client navigation retains each branch cache; the workspace key resets local forms. */
export function HostelWorkspaceSwitcher({
  current,
  hostels,
  overall = false,
}: {
  current: string;
  hostels: Array<{ isBranch: boolean; name: string; slug: string }>;
  /** The owner of several hostels: offer "Overall", every branch at once. */
  overall?: boolean;
}) {
  const router = useRouter();
  const [switching, startTransition] = useTransition();
  if (!hostels.length) return null;
  const inOverall = current === OVERALL_SLUG;
  const selected = inOverall
    ? { isBranch: false, name: "Overall", slug: OVERALL_SLUG }
    : hostels.find((hostel) => hostel.slug === current);
  function open(slug: string) {
    if (slug === current || switching) return;
    startTransition(() => router.push(`/${encodeURIComponent(slug)}/admin/dashboard`));
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Switch branch. Current branch: ${selected?.name ?? current}`}
          disabled={switching}
          className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-border bg-background px-2.5 py-1.5 text-left outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand-teal"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
            {switching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Glyph className="size-4" name={inOverall ? "overall" : selected?.isBranch ? "branch" : "hostel"} />
            )}
          </span>
          <span className="block max-w-[7rem] truncate text-xs font-semibold md:max-w-[11rem]">
            {switching ? "Switching…" : selected?.name ?? current}
          </span>
          <Glyph className="size-3.5 shrink-0 text-muted-foreground" name="chevronDown" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)] p-1.5">
        {overall ? (
          <>
            <DropdownMenuItem onSelect={() => open(OVERALL_SLUG)} className="gap-3 rounded-lg px-2 py-2.5">
              <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${inOverall ? "bg-brand-teal text-white" : "bg-brand-teal/10 text-brand-teal"}`}>
                <Glyph className="size-[18px]" name="overall" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">Overall</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {`All ${hostels.length} branches together`}
                </span>
              </span>
              {inOverall ? <Glyph className="size-4 text-brand-teal" name="check" strokeWidth={2} /> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="px-2 text-xs font-medium text-muted-foreground">Your hostels</DropdownMenuLabel>
        {hostels.map((hostel) => {
          const active = hostel.slug === current;
          return (
            <DropdownMenuItem
              key={hostel.slug}
              onSelect={() => open(hostel.slug)}
              className="gap-3 rounded-lg px-2 py-2.5"
            >
              <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${active ? "bg-brand-teal text-white" : "bg-brand-teal/10 text-brand-teal"}`}>
                <Glyph className="size-[18px]" name={hostel.isBranch ? "branch" : "hostel"} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{hostel.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {hostel.isBranch ? "Branch" : "Main hostel"}
                </span>
              </span>
              {active ? <Glyph className="size-4 text-brand-teal" name="check" strokeWidth={2} /> : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href={`/${encodeURIComponent(inOverall ? hostels[0]?.slug ?? current : current)}/admin/branches`}
            className="gap-3 rounded-lg px-2 py-2.5 font-semibold text-brand-teal"
          >
            <span className="flex size-9 items-center justify-center rounded-lg border border-dashed border-border">
              <Glyph className="size-4" name="plus" />
            </span>
            Manage branches
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
