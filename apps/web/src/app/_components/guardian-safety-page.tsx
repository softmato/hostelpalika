"use client";

import {
  Bell,
  Building2,
  Clock3,
  Info,
  Lock,
  MessageSquare,
  Phone,
  RefreshCw,
  ShieldCheck,
} from "@/components/icons";
import { memo, useCallback, useEffect, useState } from "react";

import { LoadingRows } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { type GuardianDashboard, Message } from "./daily-operations-shared";
import {
  EmptyInline,
  InitialsAvatar,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
} from "./portal-dashboard-ui";

export const GuardianSafetyPageContent = memo(function GuardianSafetyPageContent() {
  const [dashboard, setDashboard] = useState<GuardianDashboard | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await browserApi<{ dashboard: GuardianDashboard }>(
        "/api/v1/guardian/dashboard",
      );
      setDashboard(data.dashboard);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load safety summary.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const residentName = dashboard?.resident.fullName || "Resident";
  const safetyStatus = (dashboard?.safety?.status ?? "NOT_VERIFIED").replaceAll("_", " ");
  const safetyTone = statusToneFromLabel(dashboard?.safety?.status ?? "pending");
  const hostelPhone = dashboard?.hostel?.contact.phone ?? "";
  /**
   * Null — not "no status" — when the resident has not shared safety. The two
   * are different answers and this page exists to give one of them, so an
   * ungranted dashboard says so instead of rendering "NOT VERIFIED" as though
   * the hostel had failed to check.
   */
  const safetyShared = Boolean(dashboard?.safety);

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PortalPageHeader
        actions={
          <Button
            className="h-10 gap-2 rounded-xl"
            onClick={() => void load()}
            type="button"
            variant="outline"
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        }
        description="Real-time safety overview and emergency information for your ward."
        title="Safety Summary"
      />
      <Message value={message} />
      {loading ? <LoadingRows /> : null}

      {dashboard ? (
        <>
          <div className="grid gap-5 xl:grid-cols-[1.4fr_0.9fr]">
            <SectionCard title="Resident Safety Overview">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <InitialsAvatar
                  image={dashboard.resident.image}
                  name={residentName}
                  size="lg"
                  tone="guardian"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-lg font-bold text-foreground">{residentName}</p>
                    {safetyShared ? (
                      <SoftBadge tone={safetyTone}>{safetyStatus}</SoftBadge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {dashboard.hostel?.name ?? "Hostel"} · Guardian view only
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Relation: {dashboard.guardian.relation} · {dashboard.guardian.phone}
                  </p>
                </div>
              </div>

              {/*
                Two tiles, not three. The third was an "Emergency Status /
                Normal / No active alerts" card, and the guardian dashboard
                returns no SOS field of any kind — so it printed "Normal"
                whether or not an alert was live. Telling a parent there is no
                emergency without having asked is the one lie this page must
                not tell.
              */}
              {safetyShared ? (
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-border/70 bg-muted/15 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <ShieldCheck className="size-3.5 text-emerald-600" />
                      Current Status
                    </div>
                    <p className="mt-2 text-base font-bold text-foreground">
                      {safetyStatus}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Marked by hostel
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-muted/15 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <Clock3 className="size-3.5 text-role-guardian" />
                      Last Update
                    </div>
                    {/* A date. The serializer truncates it on purpose — §4.1. */}
                    <p className="mt-2 text-base font-bold text-foreground">
                      {dashboard.safety?.asOf
                        ? new Date(`${dashboard.safety.asOf}T00:00:00`).toLocaleDateString()
                        : "Not verified"}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Day only, never a time
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-xl border border-border/70 bg-muted/15 p-4">
                  <p className="text-sm font-semibold text-foreground">
                    Safety status is not shared with you
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {residentName} has not turned on safety sharing for this guardian
                    account. They can change that from their own portal.
                  </p>
                </div>
              )}

              <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <Lock className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-semibold">No GPS Tracking. No Location History.</p>
                  <p className="mt-0.5 text-xs opacity-90">
                    We do not track or share live location. Status is updated only by
                    hostel staff.
                  </p>
                </div>
              </div>
            </SectionCard>

            <div className="space-y-5">
              <SectionCard title="Warden / Hostel In-charge">
                <div className="flex items-center gap-3">
                  <InitialsAvatar
                    name={dashboard.hostel?.name ?? "Warden"}
                    size="md"
                    tone="guardian"
                  />
                  <div>
                    <p className="font-semibold text-foreground">
                      {dashboard.hostel?.name ?? "Hostel Office"}
                    </p>
                    <p className="text-xs text-muted-foreground">Hostel administration</p>
                    {/*
                      There was an "On duty · Available" badge here. Nothing in
                      the payload says who is on duty, so it was green whether
                      the office was staffed or shut.
                    */}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {hostelPhone || "No number on file"}
                    </p>
                  </div>
                </div>
                {hostelPhone ? (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <RoleButton asChild className="w-full" tone="guardian" variant="soft">
                      <a href={`tel:${hostelPhone}`}>
                        <Phone className="size-4" />
                        Call
                      </a>
                    </RoleButton>
                    <Button asChild className="h-10 rounded-xl" variant="outline">
                      <a href={`sms:${hostelPhone}`}>
                        <MessageSquare className="size-4" />
                        Message
                      </a>
                    </Button>
                  </div>
                ) : null}
              </SectionCard>

              <SectionCard title="Hostel Emergency Contact">
                <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 dark:border-rose-900 dark:bg-rose-950/20">
                  <div className="flex items-center gap-2">
                    <Building2 className="size-4 text-rose-600" />
                    <p className="font-semibold text-foreground">
                      {dashboard.hostel?.name ?? "Hostel"}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Hostel office line
                  </p>
                  {/*
                    The number itself, dialled by the button under it. This card
                    used to headline "24/7 Emergency Helpline" over a button
                    that called nobody — the hostel's own contact number is what
                    the platform actually holds, so that is what it offers.
                  */}
                  <p className="mt-3 text-2xl font-bold text-rose-600">
                    {hostelPhone || "Not on file"}
                  </p>
                  {hostelPhone ? (
                    <RoleButton
                      asChild
                      className="mt-4 w-full bg-rose-600 hover:bg-rose-600/90"
                      tone="guardian"
                    >
                      <a href={`tel:${hostelPhone}`}>
                        <Phone className="size-4" />
                        Call the hostel
                      </a>
                    </RoleButton>
                  ) : null}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  For critical emergencies, contact the hostel immediately.
                </p>
              </SectionCard>
            </div>
          </div>

          {dashboard.permissions.canViewNotices ? (
          <SectionCard title="Guardian-Visible Notices">
            {dashboard.notices.length === 0 ? (
              <EmptyInline label="No safety-related notices." />
            ) : (
              <div className="space-y-2">
                {dashboard.notices.map((notice) => (
                  <div
                    className="flex items-start gap-3 rounded-xl border border-border/70 px-3 py-3"
                    key={notice.id}
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-role-guardian-soft text-role-guardian">
                      {notice.isUrgent ? (
                        <Bell className="size-4" />
                      ) : (
                        <Info className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground">
                          {notice.title}
                        </p>
                        {notice.isUrgent ? (
                          <SoftBadge tone="rose">Urgent</SoftBadge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {notice.content}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
          ) : null}

          {/* The "How We Ensure Safety" button beside this went nowhere. */}
          <div className="flex items-center gap-2 rounded-xl border border-role-guardian/25 bg-role-guardian-soft/40 px-4 py-3 text-sm text-foreground">
            <ShieldCheck className="size-4 shrink-0 text-role-guardian" />
            In case of any emergency, contact the warden or hostel immediately.
          </div>
        </>
      ) : null}
    </div>
  );
});
