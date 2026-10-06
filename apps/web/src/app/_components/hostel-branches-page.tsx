"use client";

import Link from "next/link";

import { Loader2, Lock } from "lucide-react";

import { Glyph } from "@/components/glyph";
import { usePathname } from "next/navigation";
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

/** `lock` — why this workspace can't use branches (`branchesLock`); the screen says so instead of fetching. */
export function HostelBranchesPageContent({ lock = null }: { lock?: string | null }) {
  const resource = usePortalResource<BranchesView>(lock ? null : BRANCHES);
  const invalidate = useInvalidateResources();
  const view = resource.data;
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

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

      {lock ? (
        <SectionCard title="Your branches">
          <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4" role="alert">
            <Lock className="mt-0.5 size-5 shrink-0 text-warning" />
            <p className="text-sm font-semibold text-foreground">{lock}</p>
          </div>
        </SectionCard>
      ) : (
      <SectionCard
        actions={
          view && !blocked && !open ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white hover:brightness-110"
              onClick={() => setOpen(true)}
              type="button"
            >
              <Glyph className="size-4" name="plus" strokeWidth={2} />
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
          <ul className="grid gap-3 sm:grid-cols-2">
            {[view.main, ...view.branches].map((branch, index) => {
              const status = STATUS[branch.status] ?? {
                label: branch.status,
                tone: "slate" as const,
              };

              return (
                <li key={branch.id}>
                  <Link
                    href={`${pathname.replace(/\/$/, "")}/${branch.id}`}
                    className="group flex h-full flex-col gap-4 rounded-2xl border border-border bg-background p-5 transition hover:border-brand-teal/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex size-11 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal">
                        <Glyph className="size-6" name={index === 0 ? "hostel" : "branch"} />
                      </span>
                      <SoftBadge tone={status.tone}>{status.label}</SoftBadge>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {index === 0 ? "Main hostel" : "Branch"}
                      </p>
                      <h3 className="mt-1 text-base font-semibold text-foreground">
                        {branch.name}
                      </h3>
                      <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Glyph className="size-3.5 shrink-0" name="pin" />
                        {[branch.area, branch.city].filter(Boolean).join(", ") ||
                          "Location not added"}
                      </p>
                    </div>
                    <span className="mt-auto flex items-center justify-between border-t border-border pt-3 text-xs font-semibold text-brand-teal">
                      View branch details{" "}
                      <Glyph className="size-4 transition group-hover:translate-x-0.5" name="open" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </SectionCard>
      )}

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
