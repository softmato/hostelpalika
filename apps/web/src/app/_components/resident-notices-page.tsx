"use client";

import { AlertTriangle, Bell, Check, Megaphone } from "@/components/icons";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/app/_components/shared-ui";
import {
  EmptyInline,
  MetricCard,
  PortalPageHeader,
} from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { browserApi } from "@/lib/browser-api";
import { dayMonthYear } from "@/lib/format-month";
import { usePortalResource, useUpdateResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { CardSkeletons, NoticeCard, SectionTitle } from "./daily-portal-ui";
import { type Notice, Message } from "./resident-shared";

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

  /*
   * Opening the board reads it, as in the app: every notice is marked read on
   * the server once per visit, so the portal's notice count clears. The "New"
   * badges stay for this visit so the resident still sees what came in.
   */
  const clearedBoard = useRef(false);
  const hasUnread = notices.some((notice) => !notice.isRead);

  useEffect(() => {
    if (clearedBoard.current || !hasUnread) return;
    clearedBoard.current = true;
    void browserApi(`${residentEndpoints.notices}/read-all`, {
      body: JSON.stringify({}),
      method: "POST",
    }).catch(() => undefined);
  }, [hasUnread]);

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

  // Grouped by the day it went up, the heading outside the cards.
  const groups = useMemo(() => {
    const byDay = new Map<string, Notice[]>();

    for (const notice of visible) {
      const key = notice.publishedAt ? dayMonthYear(notice.publishedAt) : "Earlier";
      byDay.set(key, [...(byDay.get(key) ?? []), notice]);
    }

    return [...byDay];
  }, [visible]);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader description="Announcements from your hostel." title="Notices" />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={Megaphone} label="Notices" value={counts.all} />
        <MetricCard icon={Bell} label="New" value={counts.unread} />
        <MetricCard
          icon={AlertTriangle}
          label="Urgent"
          tone={counts.urgent > 0 ? "rose" : "teal"}
          value={counts.urgent}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <SectionTitle>{tab === "all" ? "All notices" : tab === "unread" ? "New" : "Urgent"}</SectionTitle>
        <FilterButton active={tab === "all" ? 0 : 1} onClear={() => setTab("all")}>
          <FilterChoice
            label="Show"
            onChange={setTab}
            options={[
              { label: `All ${counts.all}`, value: "all" },
              { label: `New ${counts.unread}`, value: "unread" },
              { label: `Urgent ${counts.urgent}`, value: "urgent" },
            ]}
            value={tab}
          />
        </FilterButton>
      </div>

      {state === "loading" ? <CardSkeletons count={4} /> : null}
      {state === "error" ? <EmptyState label="Notices could not be loaded." /> : null}
      {state === "ready" && visible.length === 0 ? (
        <EmptyInline label="No notices in this view." />
      ) : null}

      {groups.map(([label, rows]) => (
        <section className="space-y-2" key={label}>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</h3>
          <div className="grid gap-3">
            {rows.map((notice) => (
              <NoticeCard
                action={
                  notice.isRead ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-muted-foreground">
                      <Check className="size-3.5" /> Read
                    </span>
                  ) : (
                    <button
                      className="shrink-0 rounded-full bg-role-team-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-role-team transition hover:bg-role-team/15"
                      onClick={() => void markRead(notice.id)}
                      type="button"
                    >
                      Mark read
                    </button>
                  )
                }
                category={notice.category}
                content={notice.content}
                isNew={!notice.isRead}
                isUrgent={notice.isUrgent}
                key={notice.id}
                title={notice.title}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});
