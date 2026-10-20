"use client";

import { formatHostelDate, formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { ExternalLink, Flag, Megaphone, MoreHorizontal, Play, Trash2 } from "@/components/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommunityReportDialog } from "@/app/_components/community-report-dialog";
import { type LightboxItem } from "@/components/media-lightbox";
import { useMediaViewer } from "@/components/media-viewer";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { toast } from "@/stores/toast-store";

export const COMMUNITY_ENDPOINT = "/api/v1/community";

export type CommunityMedia = {
  assetId: string;
  kind: "IMAGE" | "VIDEO";
};

export type CommunityPost = {
  authorImage: string | null;
  authorName: string;
  body: string;
  commentCount: number;
  createdAt?: string;
  hostelId: string | null;
  hostelName: string | null;
  id: string;
  isAnnouncement: boolean;
  isMine: boolean;
  media: CommunityMedia[];
  reactionCount: number;
  spaceType: "PUBLIC" | "HOSTEL";
  viewerReaction: string | null;
  visibility: "PUBLIC" | "HOSTEL_ONLY";
};

type CommunityComment = {
  authorImage: string | null;
  authorName: string;
  body: string;
  createdAt?: string;
  depth: number;
  id: string;
  /** A removed comment kept only as a placeholder for the replies under it. */
  isDeleted?: boolean;
  isMine: boolean;
  parentId: string | null;
  score: number;
  viewerVote: number;
};

/** The four the rail shows as pills. The API accepts two more; these are the ones people use. */
const REACTIONS: Array<{ emoji: string; label: string; type: string }> = [
  { emoji: "👍", label: "Like", type: "LIKE" },
  { emoji: "😄", label: "Haha", type: "LAUGH" },
  { emoji: "😢", label: "Sad", type: "SAD" },
  { emoji: "😠", label: "Angry", type: "ANGRY" },
];

/**
 * "3h", "2d" — a feed is read in glances, and a full timestamp in every card is
 * noise. The exact time stays in the `title` attribute for anyone who wants it.
 */
function relativeTime(value?: string) {
  if (!value) {
    return "";
  }

  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);

  if (seconds < 60) {
    return "now";
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }

  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }

  if (seconds < 604800) {
    return `${Math.floor(seconds / 86400)}d`;
  }

  return formatHostelDate(value);
}

/** Deterministic per name, so the same person keeps the same colour everywhere. */
const AVATAR_TONES = [
  "bg-[#163a2a] text-white",
  "bg-[#c9ead2] text-[#163a2a]",
  "bg-[#f0e3c8] text-[#7a5b1a]",
  "bg-[#e0d6f0] text-[#4a2e7a]",
  "bg-[#f0c8d6] text-[#7a1a3f]",
];

function avatarTone(name: string) {
  let hash = 0;

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }

  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function Avatar({
  image,
  name,
  size = 38,
}: {
  image: string | null;
  name: string;
  size?: number;
}) {
  // The photo route needs a session; a signed-out reader gets the initial.
  const [failed, setFailed] = useState(false);

  if (image && !failed) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element -- author photos are
         served from an authenticated route the image optimizer cannot reach. */
      <img
        alt=""
        className="shrink-0 rounded-full object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
        src={image}
        style={{ height: size, width: size }}
      />
    );
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold",
        avatarTone(name),
      )}
      style={{ fontSize: size * 0.36, height: size, width: size }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function mediaUrl(assetId: string, variant = "ORIGINAL") {
  return `/api/v1/files/${assetId}/url?variant=${variant}`;
}

/**
 * One image fills the card; several tile into a grid. Videos are never
 * autoplayed — a feed that starts talking to you is a feed you close.
 *
 * Every tile opens the same full-screen viewer the admin portal uses for
 * hostel photos ({@link useMediaViewer}) rather than playing inline, so a
 * video's own controls never fight the click for attention.
 */
function MediaGrid({ media }: { media: CommunityMedia[] }) {
  const { open: openViewer } = useMediaViewer();

  if (media.length === 0) {
    return null;
  }

  const single = media.length === 1;
  const items: LightboxItem[] = media.map((item) => ({
    kind: item.kind === "VIDEO" ? "video" : "image",
    src: mediaUrl(item.assetId, "ORIGINAL"),
  }));

  return (
    <div
      className={cn(
        "mt-3 grid gap-1.5 overflow-hidden rounded-xl",
        single ? "grid-cols-1" : "grid-cols-2",
      )}
    >
      {media.map((item, index) => {
        const isVideo = item.kind === "VIDEO";
        // An odd last tile spans both columns rather than leaving a hole.
        const spansBoth = !single && media.length % 2 === 1 && index === media.length - 1;

        return (
          <button
            className={cn(
              "group relative block cursor-zoom-in overflow-hidden rounded-lg bg-black",
              !single && (spansBoth ? "col-span-2 h-56" : "h-44"),
            )}
            key={item.assetId}
            onClick={() => openViewer(items, index)}
            type="button"
          >
            {isVideo ? (
              <video
                className={cn(
                  "w-full object-cover",
                  single ? "max-h-[520px] object-contain" : "h-full",
                )}
                muted
                playsInline
                preload="metadata"
                src={mediaUrl(item.assetId)}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- see Avatar.
              <img
                alt=""
                className={cn(
                  "w-full object-cover transition group-hover:brightness-95",
                  single ? "max-h-[520px] object-contain" : "h-full",
                )}
                loading="lazy"
                src={mediaUrl(item.assetId, single ? "LARGE" : "MEDIUM")}
              />
            )}
            {isVideo ? (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-black/45 transition group-hover:bg-black/60">
                  <Play className="size-5 fill-white text-white" />
                </span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function SpaceBadge({ post }: { post: CommunityPost }) {
  if (post.spaceType === "PUBLIC") {
    return (
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-[12px] font-semibold text-muted-foreground">
        Public
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-teal-soft px-2.5 py-0.5 text-[12px] font-semibold text-brand-teal">
      {post.hostelName}
      {post.visibility === "HOSTEL_ONLY" ? (
        <span className="text-[10px] opacity-70">· members only</span>
      ) : null}
    </span>
  );
}

/** A comment and its whole reply subtree — what collapsing one hides. */
function descendantIds(comments: CommunityComment[], rootId: string) {
  const ids = new Set<string>();
  const collect = (parentId: string) => {
    for (const comment of comments) {
      if (comment.parentId === parentId && !ids.has(comment.id)) {
        ids.add(comment.id);
        collect(comment.id);
      }
    }
  };

  collect(rootId);

  return ids;
}

function CommentThread({
  canInteract,
  comments,
  onChanged,
  postId,
}: {
  canInteract: boolean;
  comments: CommunityComment[];
  onChanged: () => void;
  postId: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  // Votes echo locally the moment they are clicked; the refetch behind them
  // reconciles. Without this the arrow feels dead for a whole round trip.
  const [localVotes, setLocalVotes] = useState<
    Record<string, { score: number; viewerVote: number }>
  >({});

  const hidden = useMemo(() => {
    const ids = new Set<string>();

    for (const id of collapsed) {
      for (const descendant of descendantIds(comments, id)) {
        ids.add(descendant);
      }
    }

    return ids;
  }, [collapsed, comments]);

  const replyCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const comment of comments) {
      if (comment.parentId) {
        counts.set(comment.parentId, (counts.get(comment.parentId) ?? 0) + 1);
      }
    }

    return counts;
  }, [comments]);

  const vote = useCallback(
    async (comment: CommunityComment, direction: 1 | -1) => {
      if (!canInteract) {
        toast.info({
          description: "Sign in to vote on comments.",
          title: "Account needed",
        });
        return;
      }

      const current = localVotes[comment.id]?.viewerVote ?? comment.viewerVote;
      const base = localVotes[comment.id]?.score ?? comment.score;
      // Clicking the arrow you already picked clears the vote.
      const next = current === direction ? 0 : direction;

      setLocalVotes((votes) => ({
        ...votes,
        [comment.id]: { score: base - current + next, viewerVote: next },
      }));

      try {
        await browserApi(
          `${COMMUNITY_ENDPOINT}/${postId}/comments/${comment.id}/vote`,
          { body: JSON.stringify({ value: next }), method: "POST" },
        );
      } catch (error) {
        setLocalVotes((votes) => ({
          ...votes,
          [comment.id]: { score: base, viewerVote: current },
        }));
        toast.error({
          title: error instanceof Error ? error.message : "Could not vote.",
        });
      }
    },
    [canInteract, localVotes, postId],
  );

  const submitReply = useCallback(
    async (parentId: string) => {
      const body = replyDraft.trim();

      if (!body) {
        return;
      }

      try {
        await browserApi(`${COMMUNITY_ENDPOINT}/${postId}/comments`, {
          body: JSON.stringify({ body, parentId }),
          method: "POST",
        });
        setReplyDraft("");
        setReplyingTo(null);
        onChanged();
      } catch (error) {
        toast.error({
          title: error instanceof Error ? error.message : "Could not reply.",
        });
      }
    },
    [onChanged, postId, replyDraft],
  );

  const removeComment = useCallback(
    async (commentId: string) => {
      if (!window.confirm("Delete this comment?")) {
        return;
      }

      try {
        await browserApi(`${COMMUNITY_ENDPOINT}/${postId}/comments/${commentId}`, {
          method: "DELETE",
        });
        toast.success({ title: "Comment deleted" });
        onChanged();
      } catch (error) {
        toast.error({
          title: error instanceof Error ? error.message : "Could not delete.",
        });
      }
    },
    [onChanged, postId],
  );

  return (
    <>
      {comments
        .filter((comment) => !hidden.has(comment.id))
        .map((comment) => {
          const isCollapsed = collapsed.has(comment.id);
          const replies = replyCounts.get(comment.id) ?? 0;
          const score = localVotes[comment.id]?.score ?? comment.score;
          const viewerVote = localVotes[comment.id]?.viewerVote ?? comment.viewerVote;

          return (
            <div
              className={cn(
                "mb-2.5 pl-3.5",
                comment.depth > 0 && "border-l-2 border-border",
              )}
              key={comment.id}
              style={{ marginLeft: comment.depth * 26 }}
            >
              <div className="flex gap-2.5">
                <Avatar
                  image={comment.authorImage}
                  name={comment.authorName}
                  size={30}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-bold text-foreground">
                      {comment.authorName}
                    </span>
                    <span
                      className="text-[12.5px] text-muted-foreground"
                      title={
                        comment.createdAt
                          ? formatHostelDateTime(comment.createdAt)
                          : ""
                      }
                    >
                      {relativeTime(comment.createdAt)}
                    </span>
                  </div>

                  {isCollapsed ? (
                    <button
                      className="mt-0.5 text-[13px] italic text-muted-foreground"
                      onClick={() =>
                        setCollapsed((ids) => {
                          const next = new Set(ids);
                          next.delete(comment.id);
                          return next;
                        })
                      }
                      type="button"
                    >
                      comment collapsed — click to expand
                    </button>
                  ) : comment.isDeleted ? (
                    <p className="my-1 text-[13px] italic text-muted-foreground">
                      Comment deleted
                    </p>
                  ) : (
                    <>
                      <p className="my-1 whitespace-pre-line break-words text-sm leading-relaxed text-foreground">
                        {comment.body}
                      </p>
                      <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-1.5 rounded-full bg-muted px-1 py-0.5">
                          <button
                            aria-label="Upvote"
                            className={cn(
                              "px-1 text-xs transition",
                              viewerVote === 1
                                ? "text-brand-teal"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => void vote(comment, 1)}
                            type="button"
                          >
                            ▲
                          </button>
                          <span className="min-w-3.5 text-center text-[12.5px] font-bold text-foreground">
                            {score}
                          </span>
                          <button
                            aria-label="Downvote"
                            className={cn(
                              "px-1 text-xs transition",
                              viewerVote === -1
                                ? "text-destructive"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => void vote(comment, -1)}
                            type="button"
                          >
                            ▼
                          </button>
                        </div>

                        {canInteract ? (
                          <button
                            className="text-[12.5px] font-semibold text-muted-foreground transition hover:text-foreground"
                            onClick={() => {
                              setReplyDraft("");
                              setReplyingTo((id) =>
                                id === comment.id ? null : comment.id,
                              );
                            }}
                            type="button"
                          >
                            Reply
                          </button>
                        ) : null}

                        {comment.isMine ? (
                          <button
                            aria-label="Delete comment"
                            className="flex items-center gap-1 text-[12.5px] font-semibold text-muted-foreground transition hover:text-destructive"
                            onClick={() => void removeComment(comment.id)}
                            type="button"
                          >
                            <Trash2 className="size-3.5" />
                            Delete
                          </button>
                        ) : null}

                        {replies > 0 ? (
                          <button
                            className="text-[12.5px] font-semibold text-brand-teal"
                            onClick={() =>
                              setCollapsed((ids) => new Set(ids).add(comment.id))
                            }
                            type="button"
                          >
                            [–] collapse
                          </button>
                        ) : null}
                      </div>

                      {replyingTo === comment.id ? (
                        <div className="mt-2 flex items-start gap-2">
                          <textarea
                            autoFocus
                            className="min-h-[36px] flex-1 resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13.5px] text-foreground outline-none focus:border-brand-teal"
                            maxLength={2000}
                            onChange={(event) => setReplyDraft(event.target.value)}
                            placeholder="Write a reply…"
                            value={replyDraft}
                          />
                          <button
                            className="shrink-0 rounded-lg bg-brand-teal px-3 py-2 text-[12.5px] font-bold text-white transition hover:brightness-110"
                            onClick={() => void submitReply(comment.id)}
                            type="button"
                          >
                            Reply
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
    </>
  );
}

export function CommunityPostCard({
  canInteract,
  onChanged,
  post,
  /** True on the permalink page, where comments are open and there is no "open" action. */
  standalone = false,
}: {
  canInteract: boolean;
  onChanged: () => void;
  post: CommunityPost;
  standalone?: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(standalone);
  const [commentDraft, setCommentDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Through the shared query cache, and idle until the thread is opened — a
  // feed of twenty posts must not fetch twenty comment trees nobody asked for.
  const commentsUrl = expanded ? `${COMMUNITY_ENDPOINT}/${post.id}/comments` : null;
  const commentResource = usePortalResource<{ comments: CommunityComment[] }>(
    commentsUrl,
    { errorMessage: "Could not load comments." },
  );
  const comments = commentResource.data?.comments ?? null;

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const requireAccount = useCallback(() => {
    toast.info({
      description: "Sign in to join the conversation.",
      title: "Account needed",
    });
  }, []);

  const loadComments = commentResource.refreshAsync;

  const react = useCallback(
    async (type: string) => {
      if (!canInteract) {
        requireAccount();
        return;
      }

      try {
        await browserApi(`${COMMUNITY_ENDPOINT}/${post.id}/reactions`, {
          body: JSON.stringify({ type }),
          method: "POST",
        });
        onChanged();
      } catch (error) {
        toast.error({
          title: error instanceof Error ? error.message : "Could not react.",
        });
      }
    },
    [canInteract, onChanged, post.id, requireAccount],
  );

  const toggleComments = useCallback(() => setExpanded((open) => !open), []);

  const addComment = useCallback(async () => {
    const body = commentDraft.trim();

    if (!body) {
      return;
    }

    try {
      await browserApi(`${COMMUNITY_ENDPOINT}/${post.id}/comments`, {
        body: JSON.stringify({ body }),
        method: "POST",
      });
      setCommentDraft("");
      await loadComments();
      onChanged();
    } catch (error) {
      toast.error({
        title: error instanceof Error ? error.message : "Could not comment.",
      });
    }
  }, [commentDraft, loadComments, onChanged, post.id]);

  const share = useCallback(async () => {
    const url = `${window.location.origin}/community/${post.id}`;

    // The share sheet is the right affordance on a phone; everywhere else,
    // copying the link is what "share" actually means.
    if (navigator.share) {
      try {
        await navigator.share({ text: post.body.slice(0, 120), url });
      } catch {
        // Dismissing the sheet is not an error worth reporting.
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      toast.success({ title: "Link copied" });
    } catch {
      toast.error({ title: "Could not copy the link." });
    }
  }, [post.body, post.id]);

  const submitReport = useCallback(
    async (reason: string) => {
      try {
        await browserApi(`${COMMUNITY_ENDPOINT}/${post.id}/report`, {
          body: JSON.stringify({ reason }),
          method: "POST",
        });
        toast.success({
          description: "A moderator will take a look.",
          title: "Reported",
        });
      } catch (error) {
        toast.error({
          title: error instanceof Error ? error.message : "Could not report.",
        });
      } finally {
        setReportOpen(false);
      }
    },
    [post.id],
  );

  const sessionUser = useSessionStore((state) => state.user);

  const removeOwn = useCallback(async () => {
    setMenuOpen(false);

    if (!window.confirm("Delete this post? It comes down for everyone.")) {
      return;
    }

    try {
      await browserApi(`${COMMUNITY_ENDPOINT}/${post.id}`, { method: "DELETE" });
      toast.success({ title: "Post deleted" });
      onChanged();
    } catch (error) {
      toast.error({
        title: error instanceof Error ? error.message : "Could not delete.",
      });
    }
  }, [onChanged, post.id]);

  return (
    <article className="mb-4 rounded-2xl border border-border bg-background p-5">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <Avatar image={post.authorImage} name={post.authorName} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-foreground">
              {post.authorName}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <SpaceBadge post={post} />
              <span
                className="text-[13px] text-muted-foreground"
                title={post.createdAt ? formatHostelDateTime(post.createdAt) : ""}
              >
                {relativeTime(post.createdAt)}
              </span>
              {post.isAnnouncement ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-bold text-warning">
                  <Megaphone className="size-3" />
                  Announcement
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="relative shrink-0" ref={menuRef}>
          <button
            aria-label="Post options"
            className="rounded-full px-2 py-1 text-lg leading-none text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            <MoreHorizontal className="size-4" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-8 z-30 w-[190px] overflow-hidden rounded-xl border border-border bg-background shadow-[0_10px_28px_rgba(0,0,0,0.14)]">
              {standalone ? null : (
                <button
                  className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-[13.5px] font-medium text-foreground transition hover:bg-muted"
                  onClick={() => {
                    setMenuOpen(false);
                    router.push(`/community/${post.id}`);
                  }}
                  type="button"
                >
                  <ExternalLink className="size-4" />
                  Open dedicated screen
                </button>
              )}
              {post.isMine ? (
                <button
                  className="flex w-full items-center gap-2 px-4 py-3 text-[13.5px] font-medium text-destructive transition hover:bg-destructive/10"
                  onClick={() => void removeOwn()}
                  type="button"
                >
                  <Trash2 className="size-4" />
                  Delete post
                </button>
              ) : (
                <button
                  className="flex w-full items-center gap-2 px-4 py-3 text-[13.5px] font-medium text-destructive transition hover:bg-destructive/10"
                  onClick={() => {
                    setMenuOpen(false);

                    if (!canInteract) {
                      requireAccount();
                      return;
                    }

                    setReportOpen(true);
                  }}
                  type="button"
                >
                  <Flag className="size-4" />
                  Report
                </button>
              )}
            </div>
          ) : null}
        </div>
      </header>

      <p className="whitespace-pre-line break-words text-[15px] leading-relaxed text-foreground">
        {post.body}
      </p>

      <MediaGrid media={post.media} />

      <footer className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {REACTIONS.map((reaction) => {
          const active = post.viewerReaction === reaction.type;

          return (
            <button
              aria-label={reaction.label}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] font-bold transition",
                active
                  ? "bg-brand-teal-soft text-brand-teal"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
              key={reaction.type}
              onClick={() => void react(reaction.type)}
              title={reaction.label}
              type="button"
            >
              <span className="text-sm leading-none">{reaction.emoji}</span>
              {active ? post.reactionCount : ""}
            </button>
          );
        })}

        <button
          className="flex items-center gap-1.5 rounded-full bg-muted px-3.5 py-2 text-[13.5px] font-semibold text-foreground transition hover:brightness-95"
          onClick={toggleComments}
          type="button"
        >
          💬 {post.commentCount}
        </button>

        <button
          className="flex items-center gap-1.5 rounded-full bg-muted px-3.5 py-2 text-[13.5px] font-semibold text-foreground transition hover:brightness-95"
          onClick={() => void share()}
          type="button"
        >
          ↻ Share
        </button>
      </footer>

      {expanded ? (
        <div className="mt-3.5 border-t border-border pt-3.5">
          {canInteract ? (
            <div className="mb-4 flex items-start gap-2.5">
              <Avatar
                image={sessionUser?.image ?? null}
                name={sessionUser?.name ?? "You"}
                size={32}
              />
              <div className="flex-1">
                <textarea
                  className="min-h-[22px] w-full resize-none bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted-foreground"
                  maxLength={2000}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  placeholder="Add a comment…"
                  value={commentDraft}
                />
                <div className="flex justify-end">
                  <button
                    className="rounded-lg bg-brand-teal px-3.5 py-1.5 text-[13px] font-bold text-white transition hover:brightness-110 disabled:opacity-50"
                    disabled={!commentDraft.trim()}
                    onClick={() => void addComment()}
                    type="button"
                  >
                    Comment
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="mb-3 text-xs text-muted-foreground">
              <Link className="font-semibold text-brand-teal" href="/login">
                Sign in
              </Link>{" "}
              to comment.
            </p>
          )}

          {comments === null ? (
            <p className="text-xs text-muted-foreground">Loading comments…</p>
          ) : comments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No comments yet. Say the first thing.
            </p>
          ) : (
            <CommentThread
              canInteract={canInteract}
              comments={comments}
              onChanged={() => {
                void loadComments();
                onChanged();
              }}
              postId={post.id}
            />
          )}
        </div>
      ) : null}

      {reportOpen ? (
        <CommunityReportDialog
          onCancel={() => setReportOpen(false)}
          onSubmit={submitReport}
        />
      ) : null}
    </article>
  );
}
