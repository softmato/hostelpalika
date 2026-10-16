"use client";

import { EyeOff, Flag, MessageSquare } from "@/components/icons";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  MetricCard,
  type PortalTone,
  SoftBadge,
  TabBar,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";

/**
 * The community moderation queue, shared by the hostel portal and the platform
 * portal.
 *
 * Both read the same service through the same filters; the only difference is
 * scope, and scope is decided server-side from the caller's role — a hostel
 * admin reaches their own hostel's posts, a platform moderator reaches every
 * space including the public one that belongs to no hostel.
 *
 * Nothing here is a feed. The feed is `/community`; this is the list of posts
 * people reported, plus the two verdicts a moderator can reach: take it down,
 * or say it is fine.
 */

export type ModeratedPost = {
  authorName: string;
  body: string;
  commentCount: number;
  createdAt?: string;
  flaggedAt?: string;
  flaggedReason?: string;
  hiddenReason?: string;
  hostelName: string | null;
  id: string;
  isAnnouncement: boolean;
  reactionCount: number;
  reportCount?: number;
  spaceType: "PUBLIC" | "HOSTEL";
  status: "VISIBLE" | "HIDDEN";
};

type ModerationPayload = {
  posts: ModeratedPost[];
  summary: { flagged: number; hidden: number; total: number };
};

type Filter = "flagged" | "hidden" | "all";

export function CommunityModerationPanel({
  endpoint,
  tone,
}: {
  /** Base moderation endpoint, e.g. `/api/v1/platform/community`. */
  endpoint: string;
  tone: PortalTone;
}) {
  const [filter, setFilter] = useState<Filter>("flagged");
  const [message, setMessage] = useState("");
  const invalidate = useInvalidateResources();

  const url = `${endpoint}?filter=${filter}`;
  const resource = usePortalResource<ModerationPayload>(url, {
    errorMessage: "Could not load reported posts.",
  });

  const posts = useMemo(() => resource.data?.posts ?? [], [resource.data]);
  const summary = resource.data?.summary;

  const moderate = useCallback(
    async (postId: string, hide: boolean) => {
      const reason = window
        .prompt(
          hide
            ? "Why are you taking this post down? The author is not shown this."
            : "Note for the audit log — why is this post fine?",
        )
        ?.trim();

      if (!reason) {
        return;
      }

      try {
        await browserApi(`${endpoint}/${postId}/hide`, {
          body: JSON.stringify({ reason }),
          method: hide ? "PATCH" : "DELETE",
        });
        setMessage(hide ? "Post hidden." : "Post cleared.");
        invalidate(url);
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not moderate the post.",
        );
      }
    },
    [endpoint, invalidate, url],
  );

  return (
    <div className="space-y-4">
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      {resource.message ? (
        <p className="text-sm text-muted-foreground">{resource.message}</p>
      ) : null}

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard
            icon={Flag}
            label="Awaiting review"
            tone="amber"
            value={summary.flagged}
          />
          <MetricCard icon={EyeOff} label="Taken down" tone="rose" value={summary.hidden} />
          <MetricCard
            icon={MessageSquare}
            label="Posts in scope"
            value={summary.total}
          />
        </div>
      ) : null}

      <TabBar
        onChange={(key) => setFilter(key as Filter)}
        tabs={[
          { count: summary?.flagged, key: "flagged", label: "Reported" },
          { count: summary?.hidden, key: "hidden", label: "Taken down" },
          { key: "all", label: "All posts" },
        ]}
        tone={tone}
        value={filter}
      />

      <Panel title={filter === "flagged" ? "Reported posts" : "Posts"}>
        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "ready" && posts.length === 0 ? (
          <EmptyState
            label={
              filter === "flagged"
                ? "Nothing is waiting for review."
                : "No posts in this view."
            }
          />
        ) : null}

        <div className="space-y-3">
          {posts.map((post) => (
            <div className="rounded-lg border border-border p-4" key={post.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">
                    {post.authorName}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {post.spaceType === "PUBLIC" ? "Public space" : post.hostelName}
                      {post.createdAt
                        ? ` · ${new Date(post.createdAt).toLocaleDateString()}`
                        : ""}
                    </span>
                  </p>
                  <p className="mt-1 whitespace-pre-line break-words text-sm text-muted-foreground">
                    {post.body}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {post.reportCount ? (
                    <SoftBadge tone="rose">{`${post.reportCount} reports`}</SoftBadge>
                  ) : null}
                  {post.status === "HIDDEN" ? (
                    <SoftBadge tone="slate">Hidden</SoftBadge>
                  ) : null}
                  {post.isAnnouncement ? (
                    <SoftBadge tone="amber">Announcement</SoftBadge>
                  ) : null}
                </div>
              </div>

              {post.flaggedReason ? (
                <p className="mt-3 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                  Queued: {post.flaggedReason}
                </p>
              ) : null}
              {post.hiddenReason ? (
                <p className="mt-2 rounded-md bg-muted p-2 text-xs text-foreground">
                  Hidden: {post.hiddenReason}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
                  onClick={() => void moderate(post.id, post.status === "VISIBLE")}
                  type="button"
                >
                  {post.status === "VISIBLE" ? "Take down" : "Restore"}
                </button>
                {post.status === "VISIBLE" && post.flaggedAt ? (
                  <button
                    className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
                    onClick={() => void moderate(post.id, false)}
                    type="button"
                  >
                    This is fine
                  </button>
                ) : null}
                <Link
                  className="text-sm font-semibold text-brand-teal hover:underline"
                  href={`/community/${post.id}`}
                  target="_blank"
                >
                  Open in community
                </Link>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
