"use client";

import { ChefHat, MapPin, Settings, Users } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
} from "@/app/_components/shared-ui";
import { TemporaryCredentialsPanel } from "@/app/_components/temporary-credentials-panel";
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

function SectionIcon({ icon: Icon, bg = "bg-brand-teal", label }: { icon: typeof MapPin; bg?: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${bg} text-white shadow-sm`}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="font-medium">{label}</span>
    </span>
  );
}

export const HostelAdminSettingsPageContent = memo(
  function HostelAdminSettingsPageContent() {
    const [message, setMessage] = useState("");
    const [busySection, setBusySection] = useState("");

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
      <div className="mx-auto max-w-[1100px] space-y-6">
        <PageHeader
          description="Temporary account access, location tracking, cook portal, and community moderation for this hostel."
          icon={Settings}
          title="Settings"
        />
        <Message value={message} />

        <TemporaryCredentialsPanel tone="admin" />

        <Panel title="Location tracking & attendance">
          {attendanceResource.state === "loading" ? <LoadingRows /> : null}
          {attendanceResource.state === "error" ? (
            <EmptyState label="Attendance settings could not be loaded." />
          ) : null}

          {attendance ? (
            <form
              className="grid gap-4"
              key={JSON.stringify(attendance)}
              onSubmit={saveAttendance}
            >
              <p className="text-sm text-muted-foreground">
                <SectionIcon icon={MapPin} label="" />
                Pings record a zone and a distance — never coordinates. The platform sets
                the outer limits; a value above them is rejected.
              </p>
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
                  hint="Distance from the hostel counted as INSIDE."
                  label="Inside radius (m)"
                  min="10"
                  name="insideZoneRadiusMeters"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.nearbyZoneRadiusMeters}
                  hint="Must be larger than the inside radius."
                  label="Nearby radius (m)"
                  min="20"
                  name="nearbyZoneRadiusMeters"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.absenceAlertDays}
                  hint="Consecutive absent days that raise an alert."
                  label="Absence alert (days)"
                  min="1"
                  name="absenceAlertDays"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.retentionDays}
                  hint="Raw logs are purged after this; aggregates are kept."
                  label="Log retention (days)"
                  min="30"
                  name="retentionDays"
                  required
                  type="number"
                />
                <Input
                  defaultValue={attendance.pingTimes.join(", ")}
                  hint="Comma-separated HH:mm times the app checks in at."
                  label="Ping times"
                  name="pingTimes"
                  required
                />
                {/*
                  The nightly prompt. Two fields rather than a section of its
                  own because it saves through this form and this endpoint —
                  splitting it out would mean a second submit that patches the
                  same document, which is how the two halves start disagreeing.
                */}
                <Select
                  defaultValue={String(attendance.nightStatus.promptEnabled)}
                  label="Night status prompt (on by default, once a night)"
                  name="promptEnabled"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </Select>
                <Select
                  defaultValue={attendance.nightStatus.promptTime}
                  label="Ask at (anyone who answered is skipped)"
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
              <div className="flex justify-end">
                <button
                  className="rounded-md bg-role-admin px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-admin disabled:opacity-60"
                  disabled={busySection === "attendance"}
                  type="submit"
                >
                  {busySection === "attendance" ? "Saving…" : "Save tracking settings"}
                </button>
              </div>
            </form>
          ) : null}
        </Panel>

        <Panel title="Cook portal">
          {cookResource.state === "loading" ? <LoadingRows /> : null}
          {cookResource.state === "error" ? (
            <EmptyState label="Cook portal settings could not be loaded." />
          ) : null}

          {cook ? (
            <form className="grid gap-4" key={JSON.stringify(cook)} onSubmit={saveCook}>
              <p className="text-sm text-muted-foreground">
                <SectionIcon icon={ChefHat} label="" />
                One shared kitchen login that can announce a meal is ready. Turning it off
                suspends the account immediately.
              </p>
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
                  hint="Shown to residents on food-ready alerts."
                  label="Cook name"
                  name="cookName"
                />
              </div>
              {cook.cookCredentialIssuedAt ? (
                <p className="text-xs text-muted-foreground">
                  Credentials last issued{" "}
                  {new Date(cook.cookCredentialIssuedAt).toLocaleDateString()}. Only the
                  hash is stored — rotate from the Food page to issue a new password.
                </p>
              ) : null}
              <div className="flex justify-end">
                <button
                  className="rounded-md bg-role-admin px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-admin disabled:opacity-60"
                  disabled={busySection === "cook"}
                  type="submit"
                >
                  {busySection === "cook" ? "Saving…" : "Save cook settings"}
                </button>
              </div>
            </form>
          ) : null}
        </Panel>

        <Panel title="Community moderation">
          {communityResource.state === "loading" ? <LoadingRows /> : null}
          {communityResource.state === "error" ? (
            <EmptyState label="Community settings could not be loaded." />
          ) : null}

          {community ? (
            <form
              className="grid gap-4"
              key={JSON.stringify(community)}
              onSubmit={saveCommunity}
            >
              <p className="text-sm text-muted-foreground">
                <SectionIcon icon={Users} label="" />
                Turning the feed off stops new posts; existing ones stay readable for
                moderation. Reporting and hiding work either way.
              </p>
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
              <div className="flex justify-end">
                <button
                  className="rounded-md bg-role-admin px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-admin disabled:opacity-60"
                  disabled={busySection === "community"}
                  type="submit"
                >
                  {busySection === "community" ? "Saving…" : "Save community settings"}
                </button>
              </div>
            </form>
          ) : null}
        </Panel>
      </div>
    );
  },
);
