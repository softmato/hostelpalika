"use client";

import { AlertTriangle, Bell, Check, Megaphone } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { EmptyState } from "@/app/_components/shared-ui";
import {
  EmptyInline,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
  TabBar,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource, useUpdateResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { type Notice, Message } from "./resident-shared";

function NoticeSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          className="h-20 animate-pulse rounded-xl border border-border/60 bg-muted/30"
          key={index}
        />
      ))}
    </div>
  );
}

export const ResidentNoticesPageContent = memo(function ResidentNoticesPageContent() {
  const [actionMessage, setActionMessage] = useState("");
  const [tab, setTab] = useState<"all" | "unread" | "urgent">("all");
  const updateResource = useUpdateResource();
  const noticesResource = usePortalResource<{ notices: Notice[] }>(
    residentEndpoints.notices,
    { errorMessage: "Could not load notices." },
  );

  const notices = useMemo(
    () => noticesResource.data?.notices ?? [],
    [noticesResource.data],
  );
  const state = noticesResource.state;
  const message = actionMessage || noticesResource.message;

  const markRead = useCallback(
    async (noticeId: string) => {
      try {
        await browserApi(`${residentEndpoints.notices}/${noticeId}/read`, {
          body: JSON.stringify({}),
          method: "PATCH",
        });
        // Patch the cached row rather than refetching: the tick is the only
        // thing that changed, and we already know its new value.
        updateResource<{ notices: Notice[] }>(residentEndpoints.notices, (current) => ({
          ...current,
          notices: current.notices.map((notice) =>
            notice.id === noticeId ? { ...notice, isRead: true } : notice,
          ),
        }));
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not mark notice read.",
        );
      }
    },
    [updateResource],
  );

  const counts = useMemo(
    () => ({
      all: notices.length,
      unread: notices.filter((notice) => !notice.isRead).length,
      urgent: notices.filter((notice) => notice.isUrgent).length,
    }),
    [notices],
  );

  const visible = useMemo(() => {
    if (tab === "unread") return notices.filter((notice) => !notice.isRead);
    if (tab === "urgent") return notices.filter((notice) => notice.isUrgent);
    return notices;
  }, [notices, tab]);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader
        breadcrumb={[{ href: "/resident/dashboard", label: "Home" }, "Notices"]}
        description="Stay up to date with announcements from your hostel."
        title="Notices"
      />
      <Message value={message} />

      <SectionCard>
        <TabBar
          className="mb-4"
          onChange={(key) => setTab(key as typeof tab)}
          tabs={[
            { key: "all", label: "All", count: counts.all },
            { key: "unread", label: "Unread", count: counts.unread },
            { key: "urgent", label: "Urgent", count: counts.urgent },
          ]}
          tone="resident"
          value={tab}
        />

        {state === "loading" ? <NoticeSkeleton /> : null}
        {state === "error" ? <EmptyState label="Notices could not be loaded." /> : null}
        {state === "ready" && visible.length === 0 ? (
          <EmptyInline label="No notices in this view." />
        ) : null}

        <div className="space-y-2.5">
          {visible.map((notice) => (
            <div
              className={`flex items-start gap-3 rounded-xl border p-3 transition ${
                notice.isRead
                  ? "border-border/60 bg-card"
                  : "border-role-resident/25 bg-role-resident-soft/20"
              }`}
              key={notice.id}
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                  notice.isUrgent
                    ? "bg-rose-50 text-rose-600"
                    : "bg-role-resident-soft text-role-resident"
                }`}
              >
                {notice.isUrgent ? (
                  <AlertTriangle className="size-[17px]" />
                ) : (
                  <Megaphone className="size-[17px]" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-bold text-foreground">{notice.title}</p>
                  {notice.isUrgent ? <SoftBadge tone="rose">Urgent</SoftBadge> : null}
                  <SoftBadge tone="slate">{notice.category}</SoftBadge>
                  {!notice.isRead ? <SoftBadge tone="green">New</SoftBadge> : null}
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                  {notice.content}
                </p>
                {notice.publishedAt ? (
                  <p className="mt-1.5 text-[10.5px] text-muted-foreground/70">
                    {new Date(notice.publishedAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                ) : null}
              </div>
              {notice.isRead ? (
                <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                  <Check className="size-3.5" /> Read
                </span>
              ) : (
                <RoleButton
                  className="mt-0.5 shrink-0"
                  onClick={() => void markRead(notice.id)}
                  tone="resident"
                  variant="soft"
                >
                  <Bell className="size-3.5" />
                  Mark read
                </RoleButton>
              )}
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
});
