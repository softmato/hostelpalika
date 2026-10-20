"use client";

import { Briefcase, Check, CheckCircle2, Loader2, Wrench } from "@/components/icons";
import Link from "next/link";
import { useEffect, useState } from "react";

import { MetricCard, PortalPageHeader, RoleButton } from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Glyph, type GlyphName } from "@/components/glyph";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { FactChip, titleCase } from "./daily-portal-ui";

/**
 * The service provider's job feed — their only screen on the website.
 *
 * A provider is a public account with an approved provider record, so the
 * `/jobs` portal is guarded by sign-in only (see `route-access.ts`); the
 * public header still carries a "Jobs" tab into it once they are approved.
 * "Available" is every open request on the platform (their trade first) that
 * they can accept; "Open" and "Past work" are the jobs that are theirs.
 */

type ProviderJob = {
  category: string;
  createdAt: string | null;
  description: string;
  hostelArea: string;
  hostelCity: string;
  hostelName: string;
  hostelPhone: string;
  id: string;
  inMyTrade: boolean;
  location: string;
  minimumCharge: number | null;
  priority: string;
  scheduledFor: string | null;
  status: string;
  title: string;
};

/** Open work first — a completed job is a record, not a task. */
const OPEN_STATUSES = new Set(["PENDING", "CONTACTED", "SCHEDULED"]);

/* Maintenance status → colour, per DESIGN.md: completed green, scheduled or
   contacted amber, cancelled grey, pending neutral. */
const STATUS_TONES: Record<string, string> = {
  CANCELLED: "bg-muted text-muted-foreground",
  COMPLETED: "bg-role-team-soft text-role-team",
  CONTACTED: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  PENDING: "bg-muted text-foreground",
  SCHEDULED: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

const TRADE_GLYPH: Record<string, GlyphName> = {
  APPLIANCE_REPAIR: "plug",
  CARPENTER: "hammer",
  CLEANER: "brush",
  DOCTOR_CLINIC: "medkit",
  ELECTRICIAN: "flash",
  INTERNET_TECHNICIAN: "wifi",
  PAINTER: "color-palette",
  PLUMBER: "water",
  ROOM_REPAIR: "construct",
  WATER_SUPPLIER: "water",
};

type Show = "ALL" | "AVAILABLE" | "OPEN" | "PAST";

function formatDate(value: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function JobCard({
  accepting,
  job,
  onAccept,
}: {
  accepting?: boolean;
  job: ProviderJob;
  onAccept?: () => void;
}) {
  const where = [job.location, job.hostelArea, job.hostelCity].filter(Boolean).join(" · ");
  const urgent = job.priority === "URGENT" || job.priority === "HIGH";

  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-role-team-soft text-role-team">
          <Glyph className="size-5" name={TRADE_GLYPH[job.category] ?? "build"} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-heading text-[15px] font-semibold text-foreground">{job.title}</h3>
          <p className="truncate text-[13px] font-medium text-muted-foreground">{job.hostelName}</p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
            STATUS_TONES[job.status] ?? STATUS_TONES.PENDING!,
          )}
        >
          {titleCase(job.status)}
        </span>
      </div>

      {job.description ? (
        <p className="line-clamp-3 text-[13.5px] text-muted-foreground">{job.description}</p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <FactChip glyph="flag" tone={job.priority === "URGENT" ? "wrong" : urgent ? "warn" : "neutral"}>
          {titleCase(job.priority)}
        </FactChip>
        <FactChip glyph="build">{titleCase(job.category)}</FactChip>
        {where ? <FactChip glyph="location">{where}</FactChip> : null}
        {job.minimumCharge !== null ? (
          <FactChip glyph="cash">{`Min NPR ${job.minimumCharge.toLocaleString("en-US")}`}</FactChip>
        ) : null}
        {job.scheduledFor ? <FactChip glyph="calendar-clock">{formatDate(job.scheduledFor)}</FactChip> : null}
        {job.hostelPhone ? (
          <FactChip glyph="call" href={`tel:${job.hostelPhone}`} tone="brand">
            {job.hostelPhone}
          </FactChip>
        ) : null}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3">
        <span className="text-[12px] text-muted-foreground">
          {job.createdAt ? `Raised ${formatDate(job.createdAt)}` : ""}
        </span>
        {onAccept ? (
          <RoleButton className="h-9 px-4" disabled={accepting} onClick={onAccept} tone="team">
            {accepting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Accept job
          </RoleButton>
        ) : null}
      </div>
    </article>
  );
}

type JobBoard = { available: ProviderJob[]; jobs: ProviderJob[] };

const loadBoard = () =>
  browserApi<JobBoard>("/api/v1/public/service-providers/me/jobs");

export function ProviderJobsPage() {
  const [jobs, setJobs] = useState<ProviderJob[] | null>(null);
  const [available, setAvailable] = useState<ProviderJob[]>([]);
  const [failed, setFailed] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState("");
  const [show, setShow] = useState<Show>("ALL");

  useEffect(() => {
    let isMounted = true;

    void loadBoard()
      .then((data) => {
        if (isMounted) {
          setJobs(data.jobs);
          setAvailable(data.available);
        }
      })
      .catch(() => {
        if (isMounted) {
          setFailed(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  async function accept(jobId: string) {
    setAccepting(jobId);
    setAcceptError("");

    try {
      await browserApi(`/api/v1/public/service-providers/me/jobs/${jobId}/accept`, {
        method: "POST",
      });
    } catch (error) {
      setAcceptError(error instanceof Error ? error.message : "That job could not be accepted.");
    }

    // Either way the board has moved: reload so the phone number arrives, or
    // the job somebody else took disappears.
    try {
      const data = await loadBoard();
      setJobs(data.jobs);
      setAvailable(data.available);
    } finally {
      setAccepting(null);
    }
  }

  const open = jobs?.filter((job) => OPEN_STATUSES.has(job.status)) ?? [];
  const closed = jobs?.filter((job) => !OPEN_STATUSES.has(job.status)) ?? [];
  const sections = [
    { accept: true, heading: "In your trade", list: available.filter((job) => job.inMyTrade), show: "AVAILABLE" },
    { accept: true, heading: "Other trades", list: available.filter((job) => !job.inMyTrade), show: "AVAILABLE" },
    { accept: false, heading: "Your open jobs", list: open, show: "OPEN" },
    { accept: false, heading: "Past work", list: closed, show: "PAST" },
  ].filter((section) => section.list.length > 0 && (show === "ALL" || show === section.show));

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader description="Accept a job to get the hostel's number." title="Your jobs" />

      {jobs === null && !failed ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="h-40 animate-pulse rounded-2xl bg-muted" key={index} />
          ))}
        </div>
      ) : failed ? (
        <section className="rounded-2xl border border-border/70 bg-card p-8 text-center">
          <p className="font-heading text-[15px] font-semibold text-foreground">Your jobs could not be loaded.</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Refresh, or{" "}
            <Link className="font-semibold text-role-team" href="/login">
              sign in again
            </Link>
            .
          </p>
        </section>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard icon={Briefcase} label="Available" value={available.length} />
            <MetricCard icon={Wrench} label="Your open jobs" value={open.length} />
            <MetricCard icon={CheckCircle2} label="Past work" value={closed.length} />
          </div>

          {acceptError ? <p className="text-[13px] font-semibold text-rose-600">{acceptError}</p> : null}

          {jobs === null || (jobs.length === 0 && available.length === 0) ? (
            <section className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-card p-8 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Wrench className="size-6" />
              </span>
              <p className="font-heading text-[15px] font-semibold text-foreground">No jobs yet</p>
              <p className="text-[13px] text-muted-foreground">Work in your trade appears here, and we tell you.</p>
            </section>
          ) : (
            <>
              <div className="flex justify-end">
                <FilterButton active={show === "ALL" ? 0 : 1} onClear={() => setShow("ALL")}>
                  <FilterChoice
                    label="Show"
                    onChange={setShow}
                    options={[
                      { label: "All", value: "ALL" },
                      { label: `Available ${available.length}`, value: "AVAILABLE" },
                      { label: `Open ${open.length}`, value: "OPEN" },
                      { label: `Past ${closed.length}`, value: "PAST" },
                    ]}
                    value={show}
                  />
                </FilterButton>
              </div>
              {sections.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">Nothing here.</p>
              ) : null}
              {sections.map((section) => (
                <section className="space-y-3" key={section.heading}>
                  <h2 className="font-heading text-[15px] font-semibold text-foreground">
                    {section.heading} <span className="font-normal text-muted-foreground">· {section.list.length}</span>
                  </h2>
                  <div className="grid gap-3 md:grid-cols-2">
                    {section.list.map((job) => (
                      <JobCard
                        accepting={accepting === job.id}
                        job={job}
                        key={job.id}
                        onAccept={section.accept ? () => void accept(job.id) : undefined}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
