"use client";

import { CalendarCheck } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { Message, ResidentHeader } from "./resident-shared";

const ATTENDANCE_ENDPOINT = "/api/v1/resident/attendance";
const CONSENT_ENDPOINT = "/api/v1/resident/consent";

type Zone = "INSIDE" | "NEARBY" | "OUTSIDE" | "UNKNOWN";

type AttendanceDay = {
  day: string;
  source: "MOBILE_PING" | "MANUAL_OVERRIDE";
  zone: Zone;
};

const ZONE_STYLES: Record<Zone, string> = {
  INSIDE: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  NEARBY: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  OUTSIDE: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const ZONE_LABELS: Array<[Zone, string]> = [
  ["INSIDE", "Inside the hostel"],
  ["NEARBY", "Nearby"],
  ["OUTSIDE", "Outside"],
  ["UNKNOWN", "Not recorded"],
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
      <div className="mx-auto max-w-[1000px] space-y-6">
        {confirmDialog}
        <ResidentHeader
          description="Your day-by-day attendance. Only a zone is stored — never your exact location."
          icon={CalendarCheck}
          title="Attendance"
        />
        <Message value={actionMessage || resource.message} />

        <Panel title="Location tracking">
          <p className="text-sm text-muted-foreground">
            Your hostel uses your phone&apos;s location a few times a day to record
            whether you are inside, nearby, or away. The coordinates are used to work that
            out and then discarded — they are never saved. You can switch this off or
            erase your history at any time.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={cn(
                "rounded-md px-4 py-2 text-sm font-semibold",
                consentGranted
                  ? "border border-border text-foreground"
                  : "bg-role-resident text-white",
              )}
              onClick={() => void setConsent(!consentGranted)}
              type="button"
            >
              {consentGranted ? "Turn tracking off" : "Turn tracking on"}
            </button>
            <button
              className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-foreground"
              onClick={() => void eraseHistory()}
              type="button"
            >
              Delete my location history
            </button>
          </div>
        </Panel>

        <Panel title="History">
          {resource.state === "loading" ? <LoadingRows /> : null}
          {resource.state === "ready" && days.length === 0 ? (
            <EmptyState label="Nothing recorded yet." />
          ) : null}

          {days.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-3 pb-3">
                {ZONE_LABELS.map(([zone, label]) => (
                  <span className="flex items-center gap-1.5 text-xs" key={zone}>
                    <span
                      className={cn("size-3 rounded", ZONE_STYLES[zone])}
                      aria-hidden
                    />
                    {label}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {days.map((entry) => (
                  <div
                    className={cn("rounded-md p-2 text-center", ZONE_STYLES[entry.zone])}
                    key={entry.day}
                    title={`${entry.day} · ${entry.zone}${entry.source === "MANUAL_OVERRIDE" ? " (set by staff)" : ""}`}
                  >
                    <span className="block text-[10px] font-semibold">
                      {entry.day.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </Panel>
      </div>
    );
  },
);
