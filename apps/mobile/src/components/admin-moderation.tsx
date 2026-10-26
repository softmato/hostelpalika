import { Image } from "expo-image";

import { Pressable, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";

import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { type AdminModeratedPost } from "@/lib/admin-api";
import { openAssetViewer } from "@/lib/asset-viewer";
import { communityMediaUrl } from "@/lib/community-api";
import { useDates } from "@/hooks/use-dates";
import { adminQuery } from "@/lib/admin-queries";

/**
 * What a hostel's staff can do to their own community space, on a phone.
 *
 * ## Why this exists at all
 *
 * The admin group had a Community tab from the day Community got a tab in every
 * role, and it rendered `<CommunityBoard />` — the resident's feed, unchanged.
 * So an admin could read and post like anybody else and could do nothing about
 * a reported post, while the portal has carried a moderation queue the whole
 * time (`community-moderation-panel.tsx`, reading the same service this does).
 * A tab that spends a fifth of the bar showing an admin the member view of a
 * screen they are supposed to police is worse than no tab.
 *
 * ## The queue is a *decision* list, not a feed
 *
 * Every card here ends in a verdict, which is the whole difference from the
 * board next door: no reactions, no comment thread, no share. Two buttons, and
 * both of them write an audit entry.
 */

/* -------------------------------------------------------------------------- */
/* The badge on the Community tab                                             */
/* -------------------------------------------------------------------------- */

/**
 * How many posts are waiting on somebody, for the entry point that opens them.
 *
 * Fetched with `filter=flagged` and read off `summary`, not off `posts.length`:
 * the summary counts the whole queue while the list is one page, so a hostel
 * with thirty reported posts would otherwise badge the first page's twenty.
 *
 * Tolerant by construction — `useResource` holds the error and this returns
 * null for it, so a moderation route that is down or refused costs the Community
 * tab a badge rather than a screen. Null and zero are deliberately different:
 * null hides the control, zero shows it unbadged.
 */
const FLAGGED = adminQuery.moderation("flagged");

export function useReportedCount() {
  // The same key the moderation screen itself reads, so opening it from this
  // badge paints the queue that was already counted.
  const queue = useResource(FLAGGED.load, {
    cacheKey: FLAGGED.key,
    topics: FLAGGED.topics,
  });

  return queue.error ? null : (queue.data?.summary.flagged ?? null);
}

/* -------------------------------------------------------------------------- */
/* One reported post                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The picture, at thumbnail size, tappable into the full viewer.
 *
 * The web panel does not render media at all — its hand-written `ModeratedPost`
 * type simply omits the field the serializer returns. On a moderation screen
 * that is the wrong thing to drop: a post gets reported *for* its image at
 * least as often as for its words, and a moderator deciding from the caption
 * alone is deciding blind.
 *
 * `MEDIUM` rather than `ORIGINAL`, because a row of full-resolution photos on a
 * queue that can be forty long is a lot of bytes for something most of which is
 * scrolled past.
 */
function ReportedMedia({ media }: { media: AdminModeratedPost["media"] }) {
  const images = media.filter((item) => item.kind !== "VIDEO");

  if (media.length === 0) {
    return null;
  }

  return (
    <View className="flex-row flex-wrap gap-2">
      {media.map((item) => (
        <Pressable
          accessibilityLabel={item.kind === "VIDEO" ? "Video attachment" : "Open image"}
          accessibilityRole="imagebutton"
          className="active:opacity-70"
          key={item.assetId}
          onPress={() =>
            openAssetViewer(
              images.map((image) => ({
                assetId: image.assetId,
                url: communityMediaUrl(image.assetId, "ORIGINAL"),
              })),
              Math.max(
                0,
                images.findIndex((image) => image.assetId === item.assetId),
              ),
            )
          }
        >
          <Image
            cachePolicy="memory-disk"
            className="h-20 w-20 rounded-xl bg-muted"
            contentFit="cover"
            source={{ uri: communityMediaUrl(item.assetId, "MEDIUM") }}
            transition={200}
          />

          {item.kind === "VIDEO" ? (
            <View className="absolute inset-0 items-center justify-center">
              <View className="h-7 w-7 items-center justify-center rounded-full bg-black/55">
                <Glyph color="#ffffff" name="play" size={14} />
              </View>
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * A note in the moderator's own colour — why this is in front of them.
 *
 * `flaggedReason` is the triage model's sentence rather than a reporter's
 * words (`community-triage.ts` writes it), so it is labelled as what queued the
 * post, not as what somebody said. The distinction matters when the verdict is
 * "this is fine": the moderator is overruling a classifier, not a person.
 */
function ReasonNote({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: "muted" | "warning";
}) {
  return (
    <View
      className={`rounded-xl px-3 py-2 ${
        tone === "warning" ? "bg-warning-soft" : "bg-muted"
      }`}
    >
      <Text
        className={`text-xs ${tone === "warning" ? "text-warning" : "text-muted-foreground"}`}
      >
        <Text
          className={`text-xs font-semibold ${
            tone === "warning" ? "text-warning" : "text-foreground"
          }`}
        >
          {`${label}: `}
        </Text>
        {text}
      </Text>
    </View>
  );
}

/**
 * One post, and the two verdicts that can be reached about it.
 *
 * ## Why the status is not a pill on the row
 *
 * The screen above this one is filtered, so in the Reported list every post is
 * reported and in the Taken down list every post is hidden — a pill repeating
 * that is a word per row carrying no information. It appears only in **All**,
 * where the list is mixed and the status is the one thing a scan needs.
 *
 * ## The action's *label* changes, its route does not
 *
 * `Take down` and `Restore` are opposite verdicts and opposite endpoints. `This
 * is fine` and `Restore` are the *same* endpoint — both clear the flag, set the
 * post visible and dismiss its open reports — and differ only in what the
 * moderator was looking at when they pressed it. Saying "restore" over a post
 * that was never hidden would be nonsense, which is the whole reason the label
 * is computed from `status` rather than fixed.
 */
export function ReportedPostCard({
  busy,
  onClear,
  onHide,
  post,
  showStatus,
}: {
  busy: boolean;
  onClear: (post: AdminModeratedPost) => void;
  onHide: (post: AdminModeratedPost) => void;
  post: AdminModeratedPost;
  /** Only in the mixed list — see the note above. */
  showStatus: boolean;
}) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const hidden = post.status === "HIDDEN";

  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="shrink">
          <Text numberOfLines={1} variant="label">
            {post.authorName}
          </Text>
          <Text numberOfLines={1} variant="caption">
            {[
              post.spaceType === "PUBLIC" ? "Public space" : post.hostelName,
              post.createdAt ? dates.relativeDay(post.createdAt) : null,
              post.commentCount > 0 ? `${post.commentCount} comments` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>

        <View className="shrink-0 flex-row flex-wrap items-center justify-end gap-1.5">
          {post.isAnnouncement ? <Badge label="Official" tone="warning" /> : null}
          {showStatus && hidden ? <Badge label="Taken down" tone="neutral" /> : null}
          {post.reportCount ? (
            <View className="flex-row items-center gap-1 rounded-full bg-destructive/10 px-2 py-1">
              <Glyph color={colors.destructive} name="flag" size={11} />
              <Text className="text-xs font-bold text-destructive">
                {String(post.reportCount)}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/*
        Six lines, then it stops. A moderation queue is scanned before it is
        read, and a 4000-character post left uncapped pushes every card after it
        off the screen — the one shape guaranteed to stop somebody working
        through the list. The full text is a tap away in the feed.
      */}
      <Text className="text-sm leading-5 text-foreground" numberOfLines={6}>
        {post.body}
      </Text>

      <ReportedMedia media={post.media} />

      {post.flaggedReason ? (
        <ReasonNote label="Queued" text={post.flaggedReason} tone="warning" />
      ) : null}

      {post.hiddenReason ? (
        <ReasonNote label="Taken down" text={post.hiddenReason} tone="muted" />
      ) : null}

      <View className="flex-row gap-2">
        {hidden ? null : (
          <Button
            className="flex-1"
            disabled={busy}
            haptic={false}
            label="Take down"
            onPress={() => onHide(post)}
            size="sm"
            variant="danger"
          />
        )}

        <Button
          className="flex-1"
          disabled={busy}
          label={hidden ? "Restore" : "This is fine"}
          onPress={() => onClear(post)}
          size="sm"
          variant="outline"
        />
      </View>
    </View>
  );
}
