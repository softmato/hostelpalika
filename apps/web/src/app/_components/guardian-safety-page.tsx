"use client";

import {
  Clock3,
  Lock,
  MessageSquare,
  Phone,
  RefreshCw,
  ShieldCheck,
} from "@/components/icons";
import { memo, useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { type GuardianDashboard, Message } from "./daily-operations-shared";
import { CardSkeletons, NoticeCard, SectionTitle, titleCase } from "./daily-portal-ui";
import {
  EmptyInline,
  InitialsAvatar,
  PortalPageHeader,
  RoleButton,
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
  const safetyStatus = titleCase(dashboard?.safety?.status ?? "NOT_VERIFIED");
  const hostelPhone = dashboard?.hostel?.contact.phone ?? "";
  /**
   * Null — not "no status" — when the resident has not shared safety. The two
   * are different answers and this page exists to give one of them, so an
   * ungranted dashboard says so instead of rendering "NOT VERIFIED" as though
   * the hostel had failed to check.
   */
  const safetyShared = Boolean(dashboard?.safety);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader
        actions={
          <Button
            className="h-9 gap-2 rounded-xl"
            onClick={() => void load()}
            type="button"
            variant="outline"
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        }
        description="How your ward is tonight, and who to call."
        title="Safety Summary"
      />
      <Message value={message} />
      {loading ? <CardSkeletons count={2} /> : null}

      {dashboard ? (
        <>
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
              <div className="flex items-center gap-3">
                <InitialsAvatar image={dashboard.resident.image} name={residentName} size="lg" tone="team" />
                <div className="min-w-0">
                  <p className="truncate font-heading text-[17px] font-bold tracking-tight text-foreground">
                    {residentName}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">{dashboard.hostel?.name ?? "Hostel"}</p>
                </div>
              </div>

              {/*
                Two facts, not three. A third "Emergency Status / Normal" tile
                once printed "Normal" with no SOS field behind it — telling a
                parent there is no emergency without having asked is the one
                lie this page must not tell.
              */}
              {safetyShared ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-muted/60 p-4">
                    <ShieldCheck className="size-5 text-role-team" />
                    <p className="mt-2 font-heading text-[20px] font-bold leading-tight text-foreground">
                      {safetyStatus}
                    </p>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Marked by hostel
                    </p>
                  </div>
                  <div className="rounded-2xl bg-muted/60 p-4">
                    <Clock3 className="size-5 text-role-team" />
                    {/* A date. The serializer truncates it on purpose — §4.1. */}
                    <p className="mt-2 font-heading text-[20px] font-bold leading-tight text-foreground">
                      {dashboard.safety?.asOf
                        ? new Date(`${dashboard.safety.asOf}T00:00:00`).toLocaleDateString()
                        : "Not checked"}
                    </p>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Last update · day only
                    </p>
                  </div>
                </div>
              ) : (
                // Null — not "no status" — when the resident has not shared it.
                <div className="flex items-center gap-3 rounded-2xl bg-muted/60 p-4">
                  <Lock className="size-5 shrink-0 text-muted-foreground" />
                  <p className="text-[13.5px] text-foreground">
                    {residentName} has not shared their safety status with you.
                  </p>
                </div>
              )}

              <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <Lock className="size-3.5 shrink-0" />
                No GPS, no location history. Only hostel staff set this.
              </p>
            </section>

            {/* The hostel office line is what the platform holds, so that is
                what it offers. Nothing says who is on duty, so nothing claims it. */}
            <section className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-card p-5 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-role-team-soft text-role-team">
                <Phone className="size-6" />
              </span>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {dashboard.hostel?.name ?? "Hostel"} office
              </p>
              <p className="font-heading text-[26px] font-bold tracking-tight text-foreground tabular-nums">
                {hostelPhone || "No number on file"}
              </p>
              {hostelPhone ? (
                <div className="flex gap-2">
                  <RoleButton asChild className="h-10 px-5" tone="team">
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
            </section>
          </div>

          {dashboard.permissions.canViewNotices ? (
            <section className="space-y-3">
              <SectionTitle>Notices</SectionTitle>
              {dashboard.notices.length === 0 ? (
                <EmptyInline label="No notices shared with guardians." />
              ) : (
                <div className="grid gap-3">
                  {dashboard.notices.map((notice) => (
                    <NoticeCard
                      category={notice.category}
                      content={notice.content}
                      isUrgent={notice.isUrgent}
                      key={notice.id}
                      title={notice.title}
                    />
                  ))}
                </div>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
});
