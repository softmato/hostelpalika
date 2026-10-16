"use client";

import { ArrowLeft, CheckCircle2 } from "@/components/icons";
import Link from "next/link";

import { ExistingResidentsPanel } from "@/app/_components/existing-residents-panel";

/**
 * The field team's onboarding step after publishing a hostel
 * (docs/EXISTING_RESIDENTS.md, item 8): the residents already living there,
 * filled in with the owner. Skippable — the owner can finish the same list from
 * the app or the web later, and the desk links back here.
 */
export function TeamHostelResidentsPage({
  hostelId,
  justPublished,
}: {
  hostelId: string;
  justPublished: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
            href="/team"
          >
            <ArrowLeft className="size-3.5" />
            My desk
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            Add existing residents
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            People already living in this hostel. Fill the list with the owner — the
            owner can also finish it later from the app.
          </p>
        </div>
        <Link
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
          href="/team"
        >
          {justPublished ? "Skip for now" : "Done"}
        </Link>
      </div>

      {justPublished ? (
        <p className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 p-3 text-sm font-medium text-foreground">
          <CheckCircle2 className="size-4 text-success" />
          Hostel published. Now add the residents who already live there.
        </p>
      ) : null}

      <ExistingResidentsPanel
        apiBase={`/api/v1/team/hostels/${hostelId}/existing-residents`}
        tone="platform"
      />
    </div>
  );
}
