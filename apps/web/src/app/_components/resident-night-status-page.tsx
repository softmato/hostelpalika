"use client";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { Moon } from "@/components/icons";
import { memo, useCallback, useState } from "react";

import { Glyph, type GlyphName } from "@/components/glyph";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { cn } from "@/lib/utils";
import { Message, PageHeader } from "./daily-operations-shared";
import { EmptyState } from "@/app/_components/shared-ui";
import { CardSkeletons, titleCase } from "./daily-portal-ui";

type NightStatus = {
  checkedAt: string | null;
  status: string;
};

/* Per DESIGN.md: inside is green, not verified is amber, outside is neutral —
   being out at night is normal life, not a warning. */
const CHOICES: { glyph: GlyphName; status: string; tone: string }[] = [
  { glyph: "home", status: "INSIDE_HOSTEL", tone: "bg-role-team-soft text-role-team" },
  { glyph: "walk", status: "OUTSIDE_HOSTEL", tone: "bg-muted text-foreground" },
  { glyph: "shield-checkmark", status: "MARKED_SAFE", tone: "bg-role-team-soft text-role-team" },
  {
    glyph: "help-circle",
    status: "NOT_VERIFIED",
    tone: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  },
];

export const ResidentNightStatusPageContent = memo(
  function ResidentNightStatusPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const invalidate = useInvalidateResources();
    const statusResource = usePortalResource<{ status: NightStatus }>(
      residentEndpoints.nightStatus,
      { errorMessage: "Could not load status." },
    );

    const status = statusResource.data?.status ?? null;
    const message = actionMessage || statusResource.message;
    const current = status?.status ?? "NOT_VERIFIED";
    const currentChoice = CHOICES.find((choice) => choice.status === current) ?? CHOICES[3];

    const update = useCallback(
      async (statusValue: string) => {
        try {
          await browserApi(residentEndpoints.nightStatus, {
            body: JSON.stringify({ status: statusValue }),
            method: "POST",
          });
          setActionMessage("Night status updated.");
          invalidate(residentEndpoints.nightStatus, residentEndpoints.dashboard);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update status.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[900px] space-y-5">
        <PageHeader
          description="Tell the hostel where you are tonight."
          icon={Moon}
          title="Night Status"
        />
        <Message value={message} />

        {statusResource.state === "loading" ? (
          <CardSkeletons count={1} />
        ) : statusResource.state === "error" ? (
          <EmptyState label="Your night status could not be loaded." />
        ) : (
          <section className="flex items-center gap-4 rounded-2xl border border-border/70 bg-card p-5">
            <span className={cn("flex size-14 shrink-0 items-center justify-center rounded-2xl", currentChoice.tone)}>
              <Glyph className="size-7" name={currentChoice.glyph} variant="solid" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Tonight</p>
              <p className="font-heading text-[26px] font-bold leading-tight tracking-tight text-foreground">
                {titleCase(current)}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {/* No timestamp when nothing has been recorded — an empty
                    status is not the same as "checked and absent". */}
                {status?.checkedAt ? formatHostelDateTime(status.checkedAt) : "Not checked in yet today."}
              </p>
            </div>
          </section>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {CHOICES.map((choice) => {
            const on = choice.status === current;

            return (
              <button
                aria-pressed={on}
                className={cn(
                  "flex flex-col items-center gap-2.5 rounded-2xl border bg-card px-3 py-5 text-center transition duration-200 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0",
                  on ? "border-transparent ring-2 ring-role-team" : "border-border/70",
                )}
                key={choice.status}
                onClick={() => void update(choice.status)}
                type="button"
              >
                <span className={cn("flex size-12 items-center justify-center rounded-2xl", choice.tone)}>
                  <Glyph className="size-6" name={choice.glyph} variant={on ? "solid" : "line"} />
                </span>
                <span className="text-[13.5px] font-semibold text-foreground">{titleCase(choice.status)}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);
