"use client";

import Link from "next/link";

import { Building2, Loader2, Plus } from "lucide-react";
import { useState } from "react";

import { BranchForm } from "./branch-registration-form";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";

import { PortalPageHeader, SectionCard, SoftBadge } from "./portal-dashboard-ui";

const BRANCHES = "/api/v1/hostel-admin/branches";

type BranchesView = {
  allowance: { active: boolean; cap: number; planName: string | null; used: number };
  branches: Array<{
    area: string;
    city: string;
    id: string;
    name: string;
    slug: string;
    status: string;
  }>;
  main: {
    id: string;
    name: string;
    slug: string;
    status: string;
    area: string;
    city: string;
    panNumber: string | null;
  };
};

const STATUS: Record<
  string,
  { label: string; tone: "amber" | "green" | "rose" | "slate" }
> = {
  PENDING_APPROVAL: { label: "Waiting for our call", tone: "amber" },
  PUBLISHED: { label: "Live", tone: "green" },
  REJECTED: { label: "Not approved", tone: "rose" },
};

export function HostelBranchesPageContent() {
  const resource = usePortalResource<BranchesView>(BRANCHES);
  const invalidate = useInvalidateResources();
  const view = resource.data;
  const [open, setOpen] = useState(false);

  const room = view ? view.allowance.cap - view.allowance.used : 0;
  const blocked = !view
    ? null
    : view.allowance.cap === 0
      ? `${view.allowance.planName ?? "Your plan"} does not include branches. Max does.`
      : !view.allowance.active
        ? "Your plan has to be active — clear any due first."
        : room <= 0
          ? `${view.allowance.planName} includes ${view.allowance.cap} ${view.allowance.cap === 1 ? "branch" : "branches"}, and all are in use.`
          : null;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader
        breadcrumb={["Home", "Branches"]}
        description="One owner account, all your branches. Each has its own residents, rooms, payments and settings."
        title="Branches"
      />

      <SectionCard
        actions={
          view && !blocked && !open ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white hover:brightness-110"
              onClick={() => setOpen(true)}
              type="button"
            >
              <Plus className="size-4" />
              Add a branch
            </button>
          ) : null
        }
        description={
          view
            ? `${view.allowance.used} of ${view.allowance.cap} on ${view.allowance.planName ?? "your plan"}. Branches cost nothing extra.`
            : undefined
        }
        title="Your branches"
      >
        {resource.state === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading branches
          </p>
        ) : null}
        {resource.state === "error" ? (
          <div role="alert">
            <p className="text-sm text-destructive">{resource.message}</p>
            <button
              className="mt-2 text-sm font-semibold text-brand-teal"
              onClick={resource.refresh}
            >
              Try again
            </button>
          </div>
        ) : null}
        {blocked ? <p className="text-sm text-muted-foreground">{blocked}</p> : null}
        {view ? (
          <ul className="mt-2 divide-y divide-border">
            {[view.main, ...view.branches].map((branch) => {
              const status = STATUS[branch.status] ?? {
                label: branch.status,
                tone: "slate" as const,
              };

              return (
                <li
                  className="flex items-center justify-between gap-3 py-3"
                  key={branch.id}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Building2 className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {branch.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[branch.area, branch.city].filter(Boolean).join(", ")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <SoftBadge tone={status.tone}>{status.label}</SoftBadge>
                    {branch.status === "PUBLISHED" ? (
                      <Link
                        className="text-xs font-semibold text-brand-teal underline"
                        href={`/${encodeURIComponent(branch.slug)}/admin/dashboard`}
                      >
                        Open
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </SectionCard>

      {open && view ? (
        <BranchForm
          main={view.main}
          onCancel={() => setOpen(false)}
          onFiled={() => {
            setOpen(false);
            invalidate(BRANCHES);
          }}
        />
      ) : null}
    </div>
  );
}
