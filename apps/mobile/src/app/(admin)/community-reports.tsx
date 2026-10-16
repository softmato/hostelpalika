import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { ReportedPostCard } from "@/components/admin-moderation";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import {
  type AdminModeratedPost,
  type AdminModerationFilter,
  clearReportedPost,
  hideReportedPost,
  postHostelAnnouncement,
} from "@/lib/admin-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * The reported-posts queue, and the one thing only staff can write.
 *
 * ## Why it is a route and not the Community tab itself
 *
 * The tab is the feed, and staff read the feed like everybody else — they have
 * a hostel to keep up with too. What they additionally hold is a queue and a
 * megaphone, and neither belongs in a scroll of posts: a queue is worked
 * through top to bottom and then abandoned until it refills, which is the
 * opposite rhythm to browsing. So the tab keeps a badged shield in its bar and
 * this screen holds the work.
 *
 * ## Announcements live here, not on the board
 *
 * An announcement is not a post with a flag set — it is pinned above the
 * hostel's space and only staff can write one, which makes it a *power*, and
 * the powers belong together behind one door. It is the bar's action rather
 * than a section at the bottom because "the mess is closed tonight" is the most
 * time-critical thing an admin writes from a phone, and a button under a
 * forty-card queue is not reachable in the moment that matters.
 *
 * ## Both verdicts require a reason
 *
 * The server demands 3–500 characters either way, and it is right to: hiding a
 * post and clearing one both write an audit entry that another person reads
 * later. The sheet asks rather than sending a canned string, because "Cleared
 * by admin" in an audit log is the same as no log at all.
 */
type Pending = { action: "clear" | "hide"; post: AdminModeratedPost };

const FILTERS = [
  { label: "Reported", value: "flagged" as const },
  { label: "Taken down", value: "hidden" as const },
  { label: "All", value: "all" as const },
];

export default function AdminCommunityReportsScreen() {
  const [filter, setFilter] = useState<AdminModerationFilter>("flagged");

  const query = adminQuery.moderation(filter);
  const queue = useResource(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [announcing, setAnnouncing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [saving, setSaving] = useState(false);

  const { refresh: refreshQueue } = queue;

  const submitVerdict = useCallback(async () => {
    if (!pending) {
      return;
    }

    const note = reason.trim();

    // The server's own bound, checked here so the sheet does not close on a
    // round trip that was always going to 422.
    if (note.length < 3) {
      toastError(
        "Say why",
        "Another person reads this decision later, so it is recorded with a reason.",
      );
      return;
    }

    setSaving(true);

    try {
      if (pending.action === "hide") {
        await hideReportedPost(pending.post.id, note);
        toastSuccess("Post taken down", "It is off the feed and its reports are closed.");
      } else {
        await clearReportedPost(pending.post.id, note);
        toastSuccess(
          pending.post.status === "HIDDEN" ? "Post restored" : "Post cleared",
          "Its open reports were dismissed.",
        );
      }

      setPending(null);
      setReason("");
      refreshQueue();
    } catch (caught) {
      toastError("That didn't go through", readApiError(caught));
    } finally {
      setSaving(false);
    }
  }, [pending, reason, refreshQueue]);

  const submitAnnouncement = useCallback(async () => {
    const body = announcement.trim();

    if (body.length < 1) {
      toastError("Nothing to post", "An announcement needs something in it.");
      return;
    }

    setSaving(true);

    try {
      await postHostelAnnouncement(body);
      toastSuccess("Announcement posted", "It is pinned to the top of your hostel's space.");
      setAnnouncing(false);
      setAnnouncement("");
      refreshQueue();
    } catch (caught) {
      toastError("That didn't go through", readApiError(caught));
    } finally {
      setSaving(false);
    }
  }, [announcement, refreshQueue]);

  const summary = queue.data?.summary;

  const header = (
    <AppBar
      actions={
        <IconButton
          label="Post an announcement"
          name="megaphone"
          onPress={() => setAnnouncing(true)}
        />
      }
      /*
       * An explicit destination rather than `router.back()`: this is a screen
       * inside the tab navigator, whose default `backBehavior` is `firstRoute`,
       * so plain back would land on Home rather than on the tab that opened it.
       */
      onBack={() => router.navigate("/(admin)/community")}
      showBack
      subtitle="Posts your residents reported"
      title="Reports"
    />
  );

  if (queue.loading) {
    return (
      <Screen header={header} insideTabs>
        <View className="gap-3">
          <Skeleton height={40} radius={20} />
          <SkeletonRows rows={3} />
        </View>
      </Screen>
    );
  }

  if (queue.error || !queue.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={queue.error ?? "Reported posts could not be loaded."}
          onRetry={queue.reload}
        />
      </Screen>
    );
  }

  const posts = queue.data.posts;

  return (
    <>
      <Screen
        header={header}
        insideTabs
        onRefresh={queue.refresh}
        refreshing={queue.refreshing}
        scroll
      >
        <View className="gap-4 pt-1">
          <Segmented
            onChange={setFilter}
            /*
             * Counts on the two that have one. `All` gets none on purpose — the
             * summary's `total` is every post in the hostel's space, which as a
             * number beside "Reported 3" reads like a third queue rather than
             * like the size of the archive behind it.
             */
            options={FILTERS.map((entry) => ({
              ...entry,
              count:
                entry.value === "flagged"
                  ? summary?.flagged
                  : entry.value === "hidden"
                    ? summary?.hidden
                    : undefined,
            }))}
            value={filter}
          />

          {posts.length === 0 ? (
            <EmptyCard
              description={
                filter === "flagged"
                  ? "Nothing your residents reported is waiting on a decision."
                  : filter === "hidden"
                    ? "Nothing has been taken down."
                    : "Nobody has posted in your hostel's space yet."
              }
              title={filter === "flagged" ? "Nothing to review" : "Nothing here"}
            />
          ) : (
            <View className="gap-3">
              {posts.map((post) => (
                <ReportedPostCard
                  busy={saving}
                  key={post.id}
                  onClear={(target) => {
                    setReason("");
                    setPending({ action: "clear", post: target });
                  }}
                  onHide={(target) => {
                    setReason("");
                    setPending({ action: "hide", post: target });
                  }}
                  post={post}
                  showStatus={filter === "all"}
                />
              ))}
            </View>
          )}
        </View>
      </Screen>

      <Sheet
        footer={
          <Button
            label={pending?.action === "hide" ? "Take it down" : "Clear it"}
            loading={saving}
            onPress={() => void submitVerdict()}
            variant={pending?.action === "hide" ? "danger" : "primary"}
          />
        }
        onClose={() => setPending(null)}
        open={Boolean(pending)}
        title={pending?.action === "hide" ? "Take this post down" : "Clear this post"}
      >
        <View className="gap-3">
          <Text variant="muted">
            {pending?.action === "hide"
              ? "The post comes off the feed and its open reports are closed. The author is not shown your reason — it is for the record and for whoever looks at this next."
              : "The post stays up, its flag is cleared and its open reports are dismissed. Your reason goes to the record, not to the people who reported it."}
          </Text>

          <Input
            label="Reason"
            maxLength={500}
            multiline
            numberOfLines={3}
            onChangeText={setReason}
            placeholder={
              pending?.action === "hide"
                ? "e.g. Names a resident and accuses them"
                : "e.g. Sarcasm, not a threat — reported in error"
            }
            value={reason}
          />
        </View>
      </Sheet>

      <Sheet
        footer={
          <Button
            label="Publish"
            loading={saving}
            onPress={() => void submitAnnouncement()}
          />
        }
        onClose={() => setAnnouncing(false)}
        open={announcing}
        title="Official announcement"
      >
        <View className="gap-3">
          <Text variant="muted">
            Pinned to the top of your hostel&apos;s community space and marked as coming
            from the hostel. Residents can react and reply to it like any other post.
          </Text>

          <Input
            label="Announcement"
            maxLength={4000}
            multiline
            numberOfLines={5}
            onChangeText={setAnnouncement}
            placeholder="e.g. The water tank is being cleaned on Sunday morning."
            value={announcement}
          />
        </View>
      </Sheet>
    </>
  );
}
