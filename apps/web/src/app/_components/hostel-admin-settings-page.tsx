"use client";

import { Pencil, Settings } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Select,
} from "@/app/_components/shared-ui";
import { TemporaryCredentialsPanel } from "@/app/_components/temporary-credentials-panel";
import { Chip, RowMark } from "@/app/_components/hostel-admin-page-ui";
import type { GlyphName } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { Message, PageHeader, field } from "./portal-shared";

type AttendanceSettings = {
  absenceAlertDays: number;
  enabled: boolean;
  insideZoneRadiusMeters: number;
  nearbyZoneRadiusMeters: number;
  /**
   * The nightly "are you in tonight?" prompt.
   *
   * Edited through this same endpoint, on the same document, as the app's own
   * editor in `manage/settings.tsx` — which is what makes a change here show up
   * there without anything syncing. The server merges the object field by
   * field, so sending only what this form shows cannot reset what it does not.
   */
  nightStatus: {
    promptEnabled: boolean;
    /** `HH:mm` in Nepal. The server refuses anything outside 17:00-23:45. */
    promptTime: string;
    repeatEveryMinutes: number;
  };
  pingTimes: string[];
  retentionDays: number;
};

/**
 * 17:00 to 23:45 in quarter hours — the server's own bounds, so the picker
 * cannot offer an hour the save would reject.
 *
 * Those bounds are not arbitrary: a prompt before 17:00 would file answers
 * under the night that has not started, and one after midnight would be sent on
 * the calendar day *after* the night it asks about. See `night-window.ts`.
 */
const PROMPT_TIMES = Array.from({ length: (23 - 17) * 4 + 4 }, (_, index) => {
  const minute = 17 * 60 + index * 15;

  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
    minute % 60,
  ).padStart(2, "0")}`;
});

type CookPortalSettings = {
  cookCredentialIssuedAt?: string | null;
  cookName?: string;
  enabled: boolean;
};

type CommunitySettings = {
  enabled: boolean;
  profanityFilterEnabled: boolean;
};

const ATTENDANCE_ENDPOINT = "/api/v1/hostel-admin/attendance/settings";
const COOK_ENDPOINT = "/api/v1/hostel-admin/cook-portal";
const COMMUNITY_ENDPOINT = "/api/v1/hostel-admin/settings/community";

export const HostelAdminSettingsPageContent = memo(
  function HostelAdminSettingsPageContent() {
    const [message, setMessage] = useState("");
    const [busySection, setBusySection] = useState("");
    const [editing, setEditing] = useState<"" | "attendance" | "community" | "cook">("");

    const attendanceResource = usePortalResource<{ settings: AttendanceSettings }>(
      ATTENDANCE_ENDPOINT,
      { errorMessage: "Could not load attendance settings." },
    );
    const cookResource = usePortalResource<{ settings: CookPortalSettings }>(
      COOK_ENDPOINT,
      { errorMessage: "Could not load cook portal settings." },
    );
    const communityResource = usePortalResource<{ settings: CommunitySettings }>(
      COMMUNITY_ENDPOINT,
      { errorMessage: "Could not load community settings." },
    );

    const attendance = attendanceResource.data?.settings ?? null;
    const cook = cookResource.data?.settings ?? null;
    const community = communityResource.data?.settings ?? null;

    const saveAttendance = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        setBusySection("attendance");
        setMessage("");

        try {
          await browserApi(ATTENDANCE_ENDPOINT, {
            body: JSON.stringify({
              absenceAlertDays: Number(field(form, "absenceAlertDays")),
              enabled: field(form, "enabled") === "true",
              insideZoneRadiusMeters: Number(field(form, "insideZoneRadiusMeters")),
              nearbyZoneRadiusMeters: Number(field(form, "nearbyZoneRadiusMeters")),
              // Comma-separated in the form; the API wants HH:mm entries.
              pingTimes: field(form, "pingTimes")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
              nightStatus: {
                promptEnabled: field(form, "promptEnabled") === "true",
                promptTime: field(form, "promptTime"),
                repeatEveryMinutes: Number(field(form, "repeatEveryMinutes")),
              },
              retentionDays: Number(field(form, "retentionDays")),
            }),
            method: "PATCH",
          });

          setMessage("Location tracking settings saved.");
          setEditing("");
          await attendanceResource.refreshAsync();
        } catch (error) {
          setMessage(
            error instanceof Error
              ? error.message
              : "Could not save attendance settings.",
          );
        } finally {
          setBusySection("");
        }
      },
      [attendanceResource],
    );

    const saveCook = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        setBusySection("cook");
        setMessage("");

        try {
          await browserApi(COOK_ENDPOINT, {
            body: JSON.stringify({
              cookName: field(form, "cookName") || undefined,
              enabled: field(form, "cookEnabled") === "true",
            }),
            method: "PATCH",
          });

          setMessage("Cook portal settings saved.");
          setEditing("");
          await cookResource.refreshAsync();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save cook settings.",
          );
        } finally {
          setBusySection("");
        }
      },
      [cookResource],
    );

    const saveCommunity = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        setBusySection("community");
        setMessage("");

        try {
          await browserApi(COMMUNITY_ENDPOINT, {
            body: JSON.stringify({
              enabled: field(form, "communityEnabled") === "true",
              profanityFilterEnabled: field(form, "profanityFilterEnabled") === "true",
            }),
            method: "PATCH",
          });

          setMessage("Community settings saved.");
          setEditing("");
          await communityResource.refreshAsync();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save community settings.",
          );
        } finally {
          setBusySection("");
        }
      },
      [communityResource],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          description="Access, tracking, cook portal and moderation."
          icon={Settings}
          title="Settings"
        />
        {editing ? null : <Message value={message} />}

        <TemporaryCredentialsPanel tone="admin" />

        <div className="grid gap-4 lg:grid-cols-3">
          <SettingCard
            facts={
              attendance
                ? [
                    `Inside ${attendance.insideZoneRadiusMeters} m`,
                    `Nearby ${attendance.nearbyZoneRadiusMeters} m`,
                    `Alert after ${attendance.absenceAlertDays} days`,
                    `Logs kept ${attendance.retentionDays} days`,
                    `Pings ${attendance.pingTimes.join(", ") || "none"}`,
                    attendance.nightStatus.promptEnabled
                      ? `Night ask ${attendance.nightStatus.promptTime}, every ${attendance.nightStatus.repeatEveryMinutes} min`
                      : "Night ask off",
                  ]
                : []
            }
            glyph="location"
            note="A zone and a distance, never coordinates."
            on={attendance?.enabled ?? null}
            onEdit={() => setEditing("attendance")}
            resourceState={attendanceResource.state}
            title="Location & attendance"
          />
          <SettingCard
            facts={
              cook
                ? [
                    cook.cookName ? `Name ${cook.cookName}` : "No cook name",
                    cook.cookCredentialIssuedAt
                      ? `Login issued ${new Date(cook.cookCredentialIssuedAt).toLocaleDateString()}`
                      : "No login issued",
                  ]
                : []
            }
            glyph="chef-hat"
            note="One kitchen login that can say a meal is ready."
            on={cook?.enabled ?? null}
            onEdit={() => setEditing("cook")}
            resourceState={cookResource.state}
            title="Cook portal"
          />
          <SettingCard
            facts={
              community
                ? [community.profanityFilterEnabled ? "Profanity filter on" : "Profanity filter off"]
                : []
            }
            glyph="people"
            note="Off stops new posts; old ones stay for moderation."
            on={community?.enabled ?? null}
            onEdit={() => setEditing("community")}
            resourceState={communityResource.state}
            title="Community feed"
          />
        </div>

        <Dialog onOpenChange={(open) => (open ? null : setEditing(""))} open={editing === "attendance" && attendance !== null}>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Location & attendance</DialogTitle>
              {/* Pings record a zone and a distance — never coordinates. The
                  platform sets the outer limits; a value above them is rejected. */}
              <DialogDescription>Never coordinates. Values over the platform&apos;s limits are refused.</DialogDescription>
            </DialogHeader>
            <Message value={message} />
          {attendance ? (
            <form
              className="grid gap-4"
              key={JSON.stringify(attendance)}
              onSubmit={saveAttendance}
            >
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Select
                  defaultValue={String(attendance.enabled)}
                  label="Location tracking"
                  name="enabled"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </Select>
                <Input
                  defaultValue={attendance.insideZoneRadiusMeters}
                  hint="Counted as INSIDE."
                  label="Inside radius (m)"
                  min="10"
                  name="insideZoneRadiusMeters"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.nearbyZoneRadiusMeters}
                  hint="Larger than inside."
                  label="Nearby radius (m)"
                  min="20"
                  name="nearbyZoneRadiusMeters"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.absenceAlertDays}
                  hint="Absent days in a row."
                  label="Absence alert (days)"
                  min="1"
                  name="absenceAlertDays"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.retentionDays}
                  hint="Raw logs purged; totals kept."
                  label="Log retention (days)"
                  min="30"
                  name="retentionDays"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.pingTimes.join(", ")}
                  hint="HH:mm, comma-separated."
                  label="Ping times"
                  name="pingTimes"
                  required
                />
                {/*
                  The nightly prompt. Two fields rather than a section of its
                  own because it saves through this form and this endpoint —
                  splitting it out would mean a second submit that patches the
                  same document, which is how the two halves start disagreeing.
                  On by default, once a night; anyone who answered is skipped.
                */}
                <Select
                  defaultValue={String(attendance.nightStatus.promptEnabled)}
                  label="Night status prompt"
                  name="promptEnabled"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </Select>
                <Select
                  defaultValue={attendance.nightStatus.promptTime}
                  label="Ask at"
                  name="promptTime"
                >
                  {PROMPT_TIMES.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </Select>
                {/*
                  Whoever has not answered is asked again on this interval,
                  replacing the unanswered notification, until five hours after
                  the hour or 01:00 — see `promptRound`.
                */}
                <Select
                  defaultValue={String(attendance.nightStatus.repeatEveryMinutes)}
                  label="Ask again if not answered"
                  name="repeatEveryMinutes"
                >
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60">Every hour</option>
                </Select>
              </div>
              <DialogFooter>
                <SaveButton busy={busySection === "attendance"} />
              </DialogFooter>
            </form>
          ) : null}
          </DialogContent>
        </Dialog>

        <Dialog onOpenChange={(open) => (open ? null : setEditing(""))} open={editing === "cook" && cook !== null}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Cook portal</DialogTitle>
              {/* Only the hash is stored — rotate from the Food page to issue a
                  new password. */}
              <DialogDescription>Turning it off suspends the kitchen login at once.</DialogDescription>
            </DialogHeader>
            <Message value={message} />
          {cook ? (
            <form className="grid gap-4" key={JSON.stringify(cook)} onSubmit={saveCook}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  defaultValue={String(cook.enabled)}
                  label="Cook portal"
                  name="cookEnabled"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </Select>
                <Input
                  defaultValue={cook.cookName ?? ""}
                  hint="Shown on food-ready alerts."
                  label="Cook name"
                  name="cookName"
                />
              </div>
              <DialogFooter>
                <SaveButton busy={busySection === "cook"} />
              </DialogFooter>
            </form>
          ) : null}
          </DialogContent>
        </Dialog>

        <Dialog onOpenChange={(open) => (open ? null : setEditing(""))} open={editing === "community" && community !== null}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Community feed</DialogTitle>
              {/* Turning the feed off stops new posts; existing ones stay
                  readable for moderation. Reporting and hiding work either way. */}
              <DialogDescription>Reporting and hiding work either way.</DialogDescription>
            </DialogHeader>
            <Message value={message} />
          {community ? (
            <form
              className="grid gap-4"
              key={JSON.stringify(community)}
              onSubmit={saveCommunity}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  defaultValue={String(community.enabled)}
                  label="Community feed"
                  name="communityEnabled"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </Select>
                <Select
                  defaultValue={String(community.profanityFilterEnabled)}
                  label="Profanity filter"
                  name="profanityFilterEnabled"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </Select>
              </div>
              <DialogFooter>
                <SaveButton busy={busySection === "community"} />
              </DialogFooter>
            </form>
          ) : null}
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);

function SaveButton({ busy }: { busy: boolean }) {
  return (
    <button
      className="h-10 rounded-xl bg-brand-teal px-5 text-[13.5px] font-semibold text-white transition hover:bg-brand-teal/90 disabled:opacity-60"
      disabled={busy}
      type="submit"
    >
      {busy ? "Saving…" : "Save"}
    </button>
  );
}

/** One area of settings as facts: its mark, on or off, the values as chips, and Edit. */
function SettingCard({
  facts,
  glyph,
  note,
  on,
  onEdit,
  resourceState,
  title,
}: {
  facts: string[];
  glyph: GlyphName;
  note: string;
  on: boolean | null;
  onEdit: () => void;
  resourceState: string;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex items-center gap-2.5">
        <RowMark glyph={glyph} tone={on === false ? "neutral" : "brand"} />
        <h2 className="min-w-0 flex-1 truncate font-heading text-[15px] font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {on === null ? null : <Chip tone={on ? "brand" : "neutral"}>{on ? "On" : "Off"}</Chip>}
      </div>
      <p className="text-[12.5px] text-muted-foreground">{note}</p>
      {resourceState === "loading" ? <LoadingRows /> : null}
      {resourceState === "error" ? <EmptyState label="Could not be loaded." /> : null}
      {facts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {facts.map((fact) => (
            <Chip key={fact}>{fact}</Chip>
          ))}
        </div>
      ) : null}
      <div className="mt-auto pt-1">
        <Button disabled={on === null} onClick={onEdit} size="sm" type="button" variant="outline">
          <Pencil className="size-3.5" />
          Edit
        </Button>
      </div>
    </section>
  );
}
