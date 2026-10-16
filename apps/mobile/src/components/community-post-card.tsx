import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Pressable, Share, View } from "react-native";

import { CommentInput, CommentThread } from "@/components/community-comment-thread";
import { ReactionBar } from "@/components/community-reaction-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { API_BASE_URL } from "@/lib/api";
import { openAssetViewer } from "@/lib/asset-viewer";
import { readApiError } from "@/lib/api-contract";
import {
  addPostComment,
  type CommunityMedia,
  type CommunityPost,
  communityMediaUrl,
  deleteCommunityPost,
  type CommunityComment,
  reactToPost,
  type ReactionTally,
  reportPost,
  type ReactionType,
} from "@/lib/community-api";
import {
  communityQuery,
  prefetchCommunityComments,
  seedCommunityPost,
} from "@/lib/community-queries";
import { fetchQuery, readQuery, subscribeQuery } from "@/lib/query-cache";
import {
  commentCountLabel,
  feedTime,
  MAX_REPORT_REASON,
  nextReaction,
  reactionTally,
  reportReasonError,
  spaceBadge,
} from "@/lib/community";
import { toastError, toastInfo, toastSuccess } from "@/lib/toast";

/**
 * One post, ported from `apps/web/src/app/_components/community-post-card.tsx`.
 *
 * Same anatomy: avatar, author, space badge, relative time, announcement flag, an
 * options menu, the body, the media grid, then the reaction row with comment and
 * share, then the thread when opened.
 *
 * ## Comments are not fetched until the thread is opened
 *
 * The web's reasoning holds harder on a phone: a feed of twenty posts must not
 * fetch twenty comment trees nobody asked for. Fetched on first expand and kept
 * after that.
 *
 * ## All six reactions, as compact emoji
 *
 * The web renders four labelled pills and leaves `LOVE`/`SUPPORT` unoffered. Six
 * emoji at this size fit a 320dp row, and shipping four of six values the API
 * accepts is a narrowing that tends to become permanent.
 *
 * The row itself is `<ReactionBar>`, which draws each emoji with **its own**
 * count from `reactionCounts` and animates the one that was tapped. The card's
 * job is the optimistic bookkeeping behind it, below.
 *
 * ## Video is opened, not played inline
 *
 * `expo-video` is not a dependency, and a tile with a play triangle that does
 * nothing is worse than no triangle. Community media is `PUBLIC`, so the asset URL
 * opens in the OS player with no token — and the web does not autoplay either.
 */

export function CommunityPostCard({
  canPost,
  onChanged,
  post,
  /** True on the permalink screen: the thread starts open and "Open post" is gone. */
  standalone = false,
}: {
  canPost: boolean;
  onChanged: () => void;
  post: CommunityPost;
  standalone?: boolean;
}) {
  const { colors } = useAppTheme();

  const [expanded, setExpanded] = useState(standalone);
  /*
   * Seeded from the cache when this card is the permalink's own.
   *
   * `CommunityPostCard`'s "Open post" row warms the thread on its way out, so
   * the screen it pushes usually has it before it mounts — and painting that in
   * the *first* render rather than an effect later is the difference between a
   * post that opens with its conversation under it and one that opens with a
   * line saying it is loading.
   */
  const [comments, setComments] = useState<CommunityComment[] | null>(() =>
    standalone
      ? (readQuery<CommunityComment[]>(communityQuery.comments(post.id).key)?.data ??
        null)
      : null,
  );
  const [draft, setDraft] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  /*
   * Reaction state is echoed locally so the pill responds to the tap. The parent's
   * refetch reconciles; without this the row is dead for a whole round trip on a
   * connection where that is half a second.
   *
   * The per-type tally is echoed for the same reason and is the one people watch:
   * the number sitting beside the emoji they just pressed. `?? {}` covers a
   * payload from a server that predates the breakdown — the row then draws bare
   * emoji rather than crashing on an undefined index.
   *
   * `post.reactionCount`, the total, is **not** mirrored: the tray prints the
   * six numbers it is made of, so echoing their sum would be a seventh piece of
   * state kept in step with the other six for nothing to read.
   */
  const [reaction, setReaction] = useState<ReactionType | null>(post.viewerReaction);
  const [counts, setCounts] = useState<ReactionTally>(post.reactionCounts ?? {});

  const requireAccount = useCallback(() => {
    toastInfo("Account needed", "Sign in to join the conversation.");
  }, []);

  /*
   * Through the query cache, so touch-down on the comment count is worth
   * something: `prefetchCommunityComments` starts this exact request under this
   * exact key, and `fetchQuery` joins the one already in flight rather than
   * issuing a second. The tap that follows a hundred milliseconds later finds
   * the thread arriving instead of starting.
   *
   * It is a `fetchQuery`, not a cache read: the thread is the part of a post
   * most likely to have moved since it was last looked at, and a comment posted
   * from here calls this again to see its own reply. Re-opening a thread the
   * card already has does not come back through here at all — `toggleThread`
   * stops at `comments === null`.
   */
  const loadComments = useCallback(async () => {
    const query = communityQuery.comments(post.id);

    try {
      /*
        The await is its own statement and the `setComments` follows it, rather
        than the one-liner this was. `react-hooks/set-state-in-effect` traces
        into the callee, and the standalone effect below calls this — written
        inline, the analyser reads the setState as synchronous and calls the
        effect a cascading render. Same shape, and the same reason, as
        `use-resource`'s own `run`.
      */
      const thread = await fetchQuery(query.key, query.load, query.topics);

      setComments(thread);
    } catch (caught) {
      toastError("Could not load comments", readApiError(caught));
    }
  }, [post.id]);

  /*
   * The standalone card opens expanded, and until now nothing filled it: the
   * permalink screen — where a share link and every community push land — drew
   * "Loading comments…" for ever, because the only thing that ever called
   * `loadComments` was a toggle that screen does not show.
   *
   * ## Why this subscribes rather than calling `loadComments`
   *
   * `loadComments` sets state, and an effect that calls it is a cascading render
   * by `react-hooks/set-state-in-effect` — which traces into the callee and does
   * not care that the write is behind an `await`. So the effect does the two
   * things the rule is written *for* instead: it asks an external system for the
   * answer, and it subscribes for updates from it.
   *
   * `fetchQuery` files the thread under the key this card's own prefetch warms,
   * and the subscription hands it back. That also keeps two cards on one post in
   * step — a reply typed on the feed's copy appears on the permalink's without
   * either knowing the other is mounted.
   */
  useEffect(() => {
    if (!standalone) {
      return undefined;
    }

    const query = communityQuery.comments(post.id);

    const stop = subscribeQuery(query.key, () =>
      setComments(readQuery<CommunityComment[]>(query.key)?.data ?? null),
    );

    /*
      A revalidate even when the seed above found something: the thread is the
      part of a post most likely to have moved since it was cached, and this is
      the screen someone opened *to read it*. `fetchQuery` joins the request the
      card's prefetch already started rather than issuing a second.
    */
    void fetchQuery(query.key, query.load, query.topics).catch((caught: unknown) =>
      toastError("Could not load comments", readApiError(caught)),
    );

    return stop;
  }, [post.id, standalone]);

  const toggleThread = useCallback(() => {
    const opening = !expanded;

    setExpanded(opening);

    if (opening && comments === null) {
      void loadComments();
    }
  }, [comments, expanded, loadComments]);

  /**
   * Touch-down on the comment count.
   *
   * Only when the thread is both shut and unread — a second open renders what
   * the card is already holding, so warming it would be a request for something
   * nobody is going to ask for.
   */
  const warmComments = useCallback(() => {
    if (!expanded && comments === null) {
      prefetchCommunityComments(post.id);
    }
  }, [comments, expanded, post.id]);

  const react = useCallback(
    async (type: ReactionType) => {
      if (!canPost) {
        requireAccount();
        return;
      }

      const previous = { counts, reaction };

      setReaction(nextReaction(reaction, type).reaction);
      setCounts(reactionTally(counts, reaction, type));

      try {
        await reactToPost(post.id, type);
      } catch (caught) {
        setReaction(previous.reaction);
        setCounts(previous.counts);
        toastError("Could not react", readApiError(caught));
      }
    },
    [canPost, counts, post.id, reaction, requireAccount],
  );

  const comment = useCallback(async () => {
    const body = draft.trim();

    if (!body) {
      return;
    }

    /*
     * The flag is what stops the same comment being posted twice as much as it
     * is what draws the spinner: the button had neither, and a thread reloaded
     * over a slow connection is exactly where a second tap happens.
     */
    setCommenting(true);

    try {
      await addPostComment(post.id, { body });
      setDraft("");
      await loadComments();
      onChanged();
    } catch (caught) {
      toastError("Could not comment", readApiError(caught));
    } finally {
      setCommenting(false);
    }
  }, [draft, loadComments, onChanged, post.id]);

  const share = useCallback(async () => {
    try {
      await Share.share({
        message: `${post.body.slice(0, 120)}\n\n${communityPostLink(post.id)}`,
      });
    } catch {
      // Dismissing the sheet is not an error worth reporting.
    }
  }, [post.body, post.id]);

  const remove = useCallback(() => {
    setMenuOpen(false);

    Alert.alert("Delete this post?", "It comes down for everyone.", [
      { style: "cancel", text: "Cancel" },
      {
        onPress: () => {
          void deleteCommunityPost(post.id)
            .then(() => {
              toastSuccess("Post deleted");
              onChanged();
            })
            .catch((caught: unknown) =>
              toastError("Could not delete", readApiError(caught)),
            );
        },
        style: "destructive",
        text: "Delete",
      },
    ]);
  }, [onChanged, post.id]);

  return (
    <View className="gap-3 py-4">
      <View className="flex-row items-start gap-3">
        <PersonAvatar image={post.authorImage} name={post.authorName} />

        <View className="flex-1">
          <Text
            numberOfLines={1}
            style={{ fontSize: 15, fontWeight: "700" }}
          >
            {post.authorName}
          </Text>

          {/*
            One grey line — "Public · 4 Aug" — rather than a pill for the space
            beside the time. The space is context, not status: at pill weight it
            competed with the author's own name for the eye, and on a public feed
            it says "Public" on nearly every card, which is a lot of chrome to
            repeat twenty times down a scroll. `numberOfLines` keeps a long
            hostel name from pushing the time onto a second row.

            Announcement stays a pill. That one *is* status, it is rare, and it
            is the only thing in this header worth interrupting a scan for.
          */}
          <View className="mt-0.5 flex-row flex-wrap items-center gap-1.5">
            <Text numberOfLines={1} variant="caption">
              {spaceBadge(post)} · {feedTime(post.createdAt)}
            </Text>
            {post.isAnnouncement ? <Badge label="Announcement" tone="warning" /> : null}
          </View>
        </View>

        <Pressable
          accessibilityLabel="Post options"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => setMenuOpen(true)}
        >
          <Glyph
            color={colors.mutedForeground}
            name="ellipsis-horizontal"
            size={18}
          />
        </Pressable>
      </View>

      <Text>{post.body}</Text>

      <MediaGrid media={post.media} />

      <ReactionBar
        counts={counts}
        onReact={(type) => void react(type)}
        viewerReaction={reaction}
      />

      {/*
        The tray carries the per-type numbers, so this row carries the two
        actions and nothing else. The **total** is deliberately not printed
        beside them: `reactionCount` is one per person across all six types, and
        a "9 reactions" sitting under a tray whose own numbers add up to nine is
        the same fact twice.
      */}
      <View className="-mx-2 flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          className="flex-row items-center gap-2 rounded-full px-3 py-2.5 active:opacity-70"
          hitSlop={6}
          onPress={toggleThread}
          onPressIn={warmComments}
        >
          <Glyph
            color={colors.mutedForeground}
            name="chatbubble"
            size={16}
          />
          <Text variant="caption">{commentCountLabel(post.commentCount)}</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          className="flex-row items-center gap-2 rounded-full px-3 py-2.5 active:opacity-70"
          hitSlop={6}
          onPress={() => void share()}
        >
          <Glyph color={colors.mutedForeground} name="arrow-redo" size={16} />
          <Text variant="caption">Share</Text>
        </Pressable>
      </View>

      {expanded ? (
        <View className="gap-4 pt-1">
          {canPost ? (
            <CommentInput
              busy={commenting}
              onChangeText={setDraft}
              onSend={() => void comment()}
              placeholder="Add a comment…"
              value={draft}
            />
          ) : (
            <Text variant="caption">Sign in to comment.</Text>
          )}

          {comments === null ? (
            <Text variant="caption">Loading comments…</Text>
          ) : comments.length === 0 ? (
            <Text variant="caption">No comments yet. Say the first thing.</Text>
          ) : (
            <CommentThread
              canPost={canPost}
              comments={comments}
              onChanged={() => {
                void loadComments();
                onChanged();
              }}
              postId={post.id}
            />
          )}
        </View>
      ) : null}

      <Sheet bare onClose={() => setMenuOpen(false)} open={menuOpen} title="Post">
        {standalone ? null : (
          <SheetRow
            label="Open post"
            onPress={() => {
              setMenuOpen(false);

              /*
                The screen is handed what this card already has, so it opens
                drawn rather than loading: the post is *filed*, not fetched —
                `GET /community/<id>` decorates one post with the same function
                the feed decorated this row with — and only the thread, which
                that screen shows open, is actually requested.
              */
              seedCommunityPost(post);
              prefetchCommunityComments(post.id);

              router.push(`/community/${post.id}`);
            }}
            subtitle="Its own screen, with the thread open"
          />
        )}

        {post.isMine ? (
          <SheetRow label="Delete post" onPress={remove} subtitle="For everyone" />
        ) : (
          <SheetRow
            label="Report post"
            onPress={() => {
              setMenuOpen(false);

              if (!canPost) {
                requireAccount();
                return;
              }

              setReportOpen(true);
            }}
            subtitle="A moderator will take a look"
          />
        )}
      </Sheet>

      <ReportSheet
        onClose={() => setReportOpen(false)}
        open={reportOpen}
        postId={post.id}
      />
    </View>
  );
}

/**
 * The permalink a share points at: the web's `/community/<id>` page on the
 * server this app talks to. The app claims that path (Android intent filter,
 * iOS `apple-app-site-association`), so on a phone with the app it opens
 * `app/community/[postId].tsx`; anywhere else it opens the web page.
 */
function communityPostLink(postId: string) {
  return `${API_BASE_URL}/community/${postId}`;
}

/**
 * One image fills the width; several tile in two columns with an odd last tile
 * spanning both — the web's arrangement, which stops a three-image post leaving a
 * hole.
 */
function MediaGrid({ media }: { media: CommunityMedia[] }) {
  const { colors } = useAppTheme();

  if (media.length === 0) {
    return null;
  }

  const single = media.length === 1;

  /*
   * Images go to the in-app viewer; a video still leaves for the OS, because the
   * viewer draws stills and a play button that opened a frozen frame would be
   * worse than the browser. The viewer's collection is therefore the **images
   * only** — passing every item would make the counter say "3 of 5" and then
   * skip two pages that cannot be drawn.
   */
  const images = media.filter((item) => item.kind !== "VIDEO");
  const imageItems = images.map((item) => ({
    url: communityMediaUrl(item.assetId, "ORIGINAL"),
  }));

  return (
    <View className="flex-row flex-wrap gap-1.5">
      {media.map((item, index) => {
        const spansBoth = !single && media.length % 2 === 1 && index === media.length - 1;
        const isVideo = item.kind === "VIDEO";

        return (
          <Pressable
            accessibilityLabel={isVideo ? "Play video" : "Open image"}
            accessibilityRole="imagebutton"
            className="overflow-hidden rounded-xl active:opacity-90"
            key={item.assetId}
            onPress={() => {
              if (isVideo) {
                // PUBLIC assets, so the OS can fetch this with no credential of ours.
                void Linking.openURL(communityMediaUrl(item.assetId, "ORIGINAL"));

                return;
              }

              openAssetViewer(
                imageItems,
                images.findIndex((image) => image.assetId === item.assetId),
              );
            }}
            style={{
              height: single ? 240 : spansBoth ? 150 : 120,
              width: single || spansBoth ? "100%" : "48.5%",
            }}
          >
            <Image
              contentFit="cover"
              source={{
                uri: communityMediaUrl(item.assetId, single ? "LARGE" : "MEDIUM"),
              }}
              style={{ backgroundColor: colors.muted, height: "100%", width: "100%" }}
            />

            {isVideo ? (
              <View
                className="absolute inset-0 items-center justify-center"
                style={{ pointerEvents: "none" }}
              >
                <View
                  className="h-12 w-12 items-center justify-center rounded-full"
                  style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
                >
                  <Glyph color="#ffffff" name="play" size={22} />
                </View>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function ReportSheet({
  onClose,
  open,
  postId,
}: {
  onClose: () => void;
  open: boolean;
  postId: string;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const problem = reportReasonError(reason);

    if (problem) {
      setError(problem);
      return;
    }

    setError(null);
    setBusy(true);

    try {
      await reportPost(postId, reason.trim());
      toastSuccess("Reported", "A moderator will take a look.");
      setReason("");
      onClose();
    } catch (caught) {
      setError(readApiError(caught));
    } finally {
      setBusy(false);
    }
  }, [onClose, postId, reason]);

  return (
    <Sheet
      footer={
        /*
          The kit's button, not a hand-rolled `Pressable` on the destructive
          fill. The copy of it that used to live here swapped its label for
          "Reporting…" and drew nothing that moved, so a slow network read as a
          button that had stopped working — and it had to restate the danger
          tone and the white ink itself to do it.
        */
        <Button
          label="Report"
          loading={busy}
          onPress={() => void submit()}
          variant="danger"
        />
      }
      onClose={onClose}
      open={open}
      title="Report this post"
    >
      <View className="gap-2">
        <Text variant="muted">
          Tell a moderator what is wrong with it. Reports are not shown to the
          author.
        </Text>
        <Input
          error={error}
          maxLength={MAX_REPORT_REASON}
          multiline
          onChangeText={setReason}
          placeholder="Spam, abuse, something misleading…"
          style={{ height: 88, paddingTop: 12, textAlignVertical: "top" }}
          value={reason}
        />
      </View>
    </Sheet>
  );
}
