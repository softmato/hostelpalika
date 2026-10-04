"use client";

import { Building2, Check, ChevronDown, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
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
}: {
  current: string;
  hostels: Array<{ isBranch: boolean; name: string; slug: string }>;
}) {
  const router = useRouter();
  const [switching, startTransition] = useTransition();
  if (!hostels.length) return null;
  const selected = hostels.find((hostel) => hostel.slug === current);
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
          className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-left shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-teal"
        >
          {switching ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <Building2 className="size-4 shrink-0 text-brand-teal" />
          )}
          <span className="min-w-0">
            <span className="block text-[10px] font-medium text-muted-foreground">
              {switching ? "Switching branch..." : "Switch branch"}
            </span>
            <span className="block max-w-[7rem] truncate text-xs font-semibold md:max-w-[11rem]">
              {selected?.name ?? current}
            </span>
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)] p-2">
        <DropdownMenuLabel>Your branches</DropdownMenuLabel>
        {hostels.map((hostel) => (
          <DropdownMenuItem
            key={hostel.slug}
            onSelect={() => open(hostel.slug)}
            className="gap-3 rounded-lg py-3"
          >
            <Building2 className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{hostel.name}</span>
              {hostel.slug === current ? (
                <span className="text-xs text-muted-foreground">Active branch</span>
              ) : null}
            </span>
            {hostel.slug === current ? (
              <Check className="size-4 text-brand-teal" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href={`/${encodeURIComponent(current)}/admin/branches`}
            className="gap-3 py-3"
          >
            <Plus className="size-4" />
            Manage branches
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
