"use client";

import { CalendarCheck, Home, MapPin, MoreHorizontal, Navigation, Trash2 } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { EmptyState, LoadingRows } from "@/app/_components/shared-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Glyph } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { SectionTitle } from "./daily-portal-ui";
import { MetricCard, RoleButton, SectionCard } from "./portal-dashboard-ui";
import { Message, ResidentHeader } from "./resident-shared";

const ATTENDANCE_ENDPOINT = "/api/v1/resident/attendance";
const CONSENT_ENDPOINT = "/api/v1/resident/consent";

type Zone = "INSIDE" | "NEARBY" | "OUTSIDE" | "UNKNOWN";

type AttendanceDay = {
  day: string;
  source: "MOBILE_PING" | "MANUAL_OVERRIDE";
  zone: Zone;
};

/* Green for in, a lighter green for nearby, grey for away — being out is
   normal life, not a warning — and a dashed box for a day with no reading. */
const ZONE_STYLES: Record<Zone, string> = {
  INSIDE: "bg-brand-teal text-white",
  NEARBY: "bg-role-team-soft text-role-team",
  OUTSIDE: "bg-foreground/10 text-foreground",
  UNKNOWN: "border border-dashed border-border text-muted-foreground",
};

const ZONE_LABELS: Array<[Zone, string]> = [
  ["INSIDE", "Inside"],
  ["NEARBY", "Nearby"],
  ["OUTSIDE", "Away"],
  ["UNKNOWN", "No reading"],
];

export const ResidentAttendancePageContent = memo(
  function ResidentAttendancePageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const invalidate = useInvalidateResources();
    const { confirm, confirmDialog } = useConfirm();
    const resource = usePortalResource<{
      attendance: AttendanceDay[];
      consentGranted: boolean;
    }>(ATTENDANCE_ENDPOINT, { errorMessage: "Could not load your attendance." });

    const days = useMemo(() => resource.data?.attendance ?? [], [resource.data]);
    const consentGranted = resource.data?.consentGranted ?? false;
    const counts = useMemo(() => {
      const tally: Record<Zone, number> = { INSIDE: 0, NEARBY: 0, OUTSIDE: 0, UNKNOWN: 0 };

      for (const entry of days) tally[entry.zone] += 1;

      return tally;
    }, [days]);

    const setConsent = useCallback(
      async (granted: boolean) => {
        try {
          await browserApi(CONSENT_ENDPOINT, {
            body: JSON.stringify({ consentType: "LOCATION_TRACKING", granted }),
            method: "POST",
          });
          setActionMessage(
            granted ? "Location tracking turned on." : "Location tracking turned off.",
          );
          invalidate(ATTENDANCE_ENDPOINT);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update consent.",
          );
        }
      },
      [invalidate],
    );

    const eraseHistory = useCallback(async () => {
      const confirmed = await confirm({
        actionLabel: "Delete history",
        description:
          "Every stored attendance record for your account is erased. This cannot be undone, and your hostel will no longer see your past attendance.",
        title: "Delete all of your attendance history?",
        tone: "destructive",
      });

      if (!confirmed) {
        return;
      }

      try {
        await browserApi(ATTENDANCE_ENDPOINT, { method: "DELETE" });
        setActionMessage("Your location history was deleted.");
        invalidate(ATTENDANCE_ENDPOINT);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not delete history.",
        );
      }
    }, [confirm, invalidate]);

    return (
      <div className="mx-auto max-w-[1000px] space-y-5">
        {confirmDialog}
        <ResidentHeader
          actions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label="More attendance actions" className="size-9 rounded-xl" size="icon" type="button" variant="outline">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => void eraseHistory()} variant="destructive">
                    <Trash2 className="size-4" />
                    Delete my history
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <RoleButton
                className="h-9 px-4"
                onClick={() => void setConsent(!consentGranted)}
                tone="team"
                variant={consentGranted ? "outline" : "solid"}
              >
                <Navigation className="size-4" />
                {consentGranted ? "Turn tracking off" : "Turn tracking on"}
              </RoleButton>
            </>
          }
          description="Your days by zone. Only the zone is kept."
          icon={CalendarCheck}
          title="Attendance"
        />
        <Message value={actionMessage || resource.message} />

        <section className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-4">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              consentGranted ? "bg-role-team-soft text-role-team" : "bg-muted text-muted-foreground",
            )}
          >
            <Glyph className="size-5" name="locate" variant={consentGranted ? "solid" : "line"} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-[15px] font-semibold text-foreground">
              Tracking is {consentGranted ? "on" : "off"}
            </p>
            {/* The coordinates work out the zone and are then thrown away. */}
            <p className="truncate text-[13px] text-muted-foreground">
              A few checks a day. Where you were is never saved.
            </p>
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Home} label="Days inside" value={counts.INSIDE} />
          <MetricCard icon={MapPin} label="Days nearby" value={counts.NEARBY} />
          <MetricCard icon={Navigation} label="Days away" tone="slate" value={counts.OUTSIDE} />
        </div>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle>History</SectionTitle>
            <div className="flex flex-wrap gap-3">
              {ZONE_LABELS.map(([zone, label]) => (
                <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground" key={zone}>
                  <span aria-hidden className={cn("size-3 rounded", ZONE_STYLES[zone])} />
                  {label}
                </span>
              ))}
            </div>
          </div>
          <SectionCard>
            {resource.state === "loading" ? <LoadingRows /> : null}
            {resource.state === "ready" && days.length === 0 ? (
              <EmptyState label="Nothing recorded yet." />
            ) : null}
            {days.length > 0 ? (
              <div className="grid grid-cols-7 gap-1.5">
                {days.map((entry) => (
                  <div
                    className={cn("rounded-lg p-2 text-center", ZONE_STYLES[entry.zone])}
                    key={entry.day}
                    title={`${entry.day} · ${entry.zone}${entry.source === "MANUAL_OVERRIDE" ? " (set by staff)" : ""}`}
                  >
                    <span className="block text-[11px] font-semibold">{entry.day.slice(5)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </SectionCard>
        </section>
      </div>
    );
  },
);
