"use client";

import { CheckCircle2 } from "@/components/icons";
import Link from "next/link";

import { ExistingResidentsPanel } from "@/app/_components/existing-residents-panel";
import { PortalPageHeader } from "@/app/_components/portal-dashboard-ui";

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
      <PortalPageHeader
        actions={
          <Link
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
            href="/team"
          >
            {justPublished ? "Skip for now" : "Done"}
          </Link>
        }
        breadcrumb={[{ href: "/team", label: "My desk" }, "Existing residents"]}
        description="People already living here. The owner can finish it later."
        title="Add existing residents"
      />

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
