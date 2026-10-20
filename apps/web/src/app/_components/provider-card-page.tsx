"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

import Link from "next/link";

import {
  InitialsAvatar,
  PortalPageHeader,
  RoleButton,
  SectionCard,
} from "@/app/_components/portal-dashboard-ui";
import { Glyph, type GlyphName } from "@/components/glyph";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { CardSkeletons, FactChip, SectionTitle, titleCase } from "./daily-portal-ui";

/**
 * The provider app's My card tab, on the web: the application as the platform
 * holds it. Read-only on every surface — it is a reviewed record, not a profile.
 */

type ProviderRecord = {
  area: string;
  availability: string;
  categories: string[];
  category: string;
  city: string;
  documentCount: number;
  email: string;
  experience: string;
  fullName: string;
  phone: string;
  /** Only set on REJECTED, written for the applicant to read. */
  rejectionReason: string;
  status: string;
  submittedAt?: string;
};

/* Service provider status → colour, per DESIGN.md: approved green, pending
   amber, rejected rose, hidden grey. */
const STATUS_CHIP: Record<string, string> = {
  APPROVED: "bg-role-team-soft text-role-team",
  HIDDEN: "bg-muted text-muted-foreground",
  PENDING: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  REJECTED: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
};

export function ProviderCardPage() {
  const resource = usePortalResource<{ provider: ProviderRecord | null }>(
    "/api/v1/public/service-providers/me",
    { errorMessage: "Your card could not be loaded." },
  );
  const record = resource.data?.provider;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PortalPageHeader
        actions={
          resource.data !== undefined && !record ? (
            <RoleButton asChild className="h-9 px-4" tone="team">
              <Link href="/service-providers/register">Apply now</Link>
            </RoleButton>
          ) : null
        }
        description="Your application as the platform holds it."
        title="My card"
      />

      {resource.data === undefined ? (
        resource.state === "error" ? (
          <p className="text-[13px] text-muted-foreground">{resource.message}</p>
        ) : (
          <CardSkeletons className="sm:grid-cols-1 xl:grid-cols-1" count={2} />
        )
      ) : !record ? (
        <SectionCard>
          <p className="text-[13.5px] text-foreground">You have not applied as a service provider.</p>
        </SectionCard>
      ) : (
        <>
          <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
            <div className="flex items-center gap-4">
              <InitialsAvatar name={record.fullName} size="lg" tone="team" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading text-[18px] font-bold tracking-tight text-foreground">
                  {record.fullName}
                </p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {[titleCase(record.category), record.area, record.city].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
                  STATUS_CHIP[record.status] ?? STATUS_CHIP.PENDING,
                )}
              >
                {titleCase(record.status)}
              </span>
            </div>
            {record.rejectionReason ? (
              <p className="rounded-xl bg-rose-50 px-3 py-2.5 text-[13px] text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                {record.rejectionReason}
              </p>
            ) : null}
            {record.categories.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {record.categories.map((category) => (
                  <FactChip glyph="build" key={category}>
                    {titleCase(category)}
                  </FactChip>
                ))}
              </div>
            ) : null}
          </section>

          <section className="space-y-3">
            <SectionTitle>What the platform holds</SectionTitle>
            <SectionCard>
              <ul className="divide-y divide-border/60 text-[13.5px]">
                {(
                  [
                    ["call", record.phone],
                    ["mail", record.email],
                    ["time", record.availability],
                    ["ribbon", record.experience],
                    ["documents", `${record.documentCount} document${record.documentCount === 1 ? "" : "s"} on file`],
                    [
                      "calendar",
                      record.submittedAt
                        ? `Applied ${formatHostelDate(record.submittedAt)}`
                        : "",
                    ],
                  ] as [GlyphName, string][]
                ).map(([glyph, value]) => (
                  <li className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0" key={glyph}>
                    <Glyph className="size-4 shrink-0 text-muted-foreground" name={glyph} />
                    <span className="min-w-0 truncate text-foreground">{value || "—"}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
            <p className="text-[12.5px] text-muted-foreground">Contact support if something here is wrong.</p>
          </section>
        </>
      )}
    </div>
  );
}
