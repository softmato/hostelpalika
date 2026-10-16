import { router } from "expo-router";

import { useReportedCount } from "@/components/admin-moderation";
import { CommunityBoard } from "@/components/community-board";
import { IconButton } from "@/components/ui/icon-button";

/**
 * Community, as a tab in every signed-in role — plus the one thing staff have
 * that members do not.
 *
 * The board is the same board: the feed is platform-wide, so a warden, a cook
 * and a resident read one conversation rather than three role-shaped copies of
 * it. What the admin group adds is a door in the bar to `/community-reports`,
 * because until now this tab gave an admin the *member* view of a space they
 * are responsible for policing, while the portal has carried a moderation queue
 * the whole time.
 *
 * The badge is the queue's own `flagged` count, and it is why the control is
 * here rather than one level down on More: reported posts arrive without
 * warning and nobody goes looking for them.
 */
export default function AdminCommunityScreen() {
  const reported = useReportedCount();

  return (
    <CommunityBoard
      actions={
        /*
         * Hidden entirely while the count is null — the moderation route being
         * unreachable is not the same as there being nothing to review, and a
         * shield that opens an error screen is worse than no shield. Zero still
         * shows it: an empty queue is a fact worth being able to check.
         */
        reported === null ? null : (
          <IconButton
            badge={reported}
            label={
              reported > 0 ? `Reported posts, ${reported} waiting` : "Reported posts"
            }
            name="shield-checkmark"
            onPress={() => router.push("/(admin)/community-reports")}
          />
        )
      }
      insideTabs
    />
  );
}
