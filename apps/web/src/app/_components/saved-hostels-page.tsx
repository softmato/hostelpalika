"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { mapPublicHostelToSummary } from "@/app/_components/public-hostel-data";
import type { PublicHostel } from "@/app/_components/public-hostel-data";
import { HostelCard, PublicShell } from "@/app/_components/shared";
import { browserApi } from "@/lib/browser-api";
import { useSavedHostelsStore } from "@/stores/saved-hostels-store";

/** The hostels this browser or account has hearted, read from the public list. */
export function SavedHostelsPage() {
  const ids = useSavedHostelsStore((state) => state.ids);
  const { data, isPending } = useQuery({
    queryFn: () => browserApi<{ hostels: PublicHostel[] }>("/api/v1/public/hostels"),
    queryKey: ["saved-hostels-list"],
    staleTime: 5 * 60_000,
  });
  const hostels = (data?.hostels ?? []).filter((hostel) => ids.includes(hostel.id));

  return (
    <PublicShell active="browse">
      <main className="mx-auto max-w-[1200px] px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">Saved hostels</h1>
        {hostels.length ? (
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {hostels.map((hostel) => (
              <HostelCard hostel={mapPublicHostelToSummary(hostel)} key={hostel.id} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-muted-foreground">
            {isPending ? "Loading…" : "Nothing saved yet. Tap the heart on a hostel to keep it here."}{" "}
            <Link className="text-brand-teal underline" href="/hostels">
              Browse hostels
            </Link>
          </p>
        )}
      </main>
    </PublicShell>
  );
}
