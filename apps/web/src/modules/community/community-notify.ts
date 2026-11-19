import type { Types } from "mongoose";

import { resolveHostelCookUserIds } from "@/modules/food/kitchen-notify";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";
import { NotificationPreferenceModel } from "@hostel/db/models/NotificationPreference";
import { ResidentModel } from "@hostel/db/models/Resident";

/** How much of the post rides in the push body before it is cut. */
const PREVIEW_CHARS = 110;

/**
 * Everyone who lives or works in a hostel and has an account: owner, admins,
 * wardens, cooks and active residents. De-duplicated, because one person can be
 * on more than one of those lists.
 */
export async function resolveHostelCommunityUserIds(
  hostelId: Types.ObjectId | string,
): Promise<string[]> {
  const [staff, cooks, residents] = await Promise.all([
    resolveHostelStaffUserIds(hostelId),
    resolveHostelCookUserIds(hostelId),
    ResidentModel.find({
      hostelId,
      isDeleted: false,
      status: "ACTIVE",
      userId: { $ne: null },
    })
      .select({ userId: 1 })
      .lean<{ userId?: Types.ObjectId }[]>(),
  ]);

  return [
    ...new Set([
      ...staff,
      ...cooks,
      ...residents
        .map((resident) => resident.userId?.toString())
        .filter((userId): userId is string => Boolean(userId)),
    ]),
  ];
}

export function postPreview(body: string) {
  const text = body.replace(/\s+/g, " ").trim();

  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/**
 * The `mutedCategories` key behind Settings → "New community posts". Separate
 * from `COMMUNITY`, which silences replies and reactions on your own posts.
 */
export const COMMUNITY_POST_MUTE_KEY = "COMMUNITY_POST";

/** Rows are written in slices so a platform-wide post is not one giant burst. */
const FAN_OUT_BATCH = 50;

async function usersMutingNewPosts(userIds: string[]) {
  const rows = await NotificationPreferenceModel.find({
    mutedCategories: COMMUNITY_POST_MUTE_KEY,
    userId: { $in: userIds },
  })
    .select({ userId: 1 })
    .lean<{ userId: unknown }[]>();

  return new Set(rows.map((row) => String(row.userId)));
}

/**
 * A hostel's new post goes to that hostel as a bell row and a push. The push
 * reads "Sita posted" over the post's words, and the post id routes the tap to
 * that post's own screen.
 *
 * A public-space post (author with no hostel) notifies nobody. It used to reach
 * every active account, so one fresh sign-up could push its own title and text
 * to the whole platform, once per post.
 *
 * Anyone who muted new community posts still gets the bell row, just no push.
 * Staff announcements ignore that mute — they are the hostel speaking.
 *
 * Never throws — a failed notification must not fail the post.
 */
export async function notifyHostelOfNewPost(input: {
  authorName: string;
  authorUserId: string;
  body: string;
  hostelId: Types.ObjectId | string | null | undefined;
  hostelName?: string | null;
  isAnnouncement?: boolean;
  postId: string;
}) {
  if (!input.hostelId) return;

  try {
    const audience = await resolveHostelCommunityUserIds(input.hostelId);
    const recipients = audience.filter((userId) => userId !== input.authorUserId);
    const muted = input.isAnnouncement
      ? new Set<string>()
      : await usersMutingNewPosts(recipients).catch(() => new Set<string>());
    const where = input.hostelName ?? "your hostel";

    for (let start = 0; start < recipients.length; start += FAN_OUT_BATCH) {
      await Promise.allSettled(
        recipients.slice(start, start + FAN_OUT_BATCH).map((userId) =>
          createInAppNotification({
            body: postPreview(input.body),
            category: "COMMUNITY",
            data: { postId: input.postId },
            hostelId: input.hostelId?.toString(),
            priority: input.isAnnouncement ? "HIGH" : "NORMAL",
            push: !muted.has(userId),
            title: input.isAnnouncement
              ? `Announcement in ${where}`
              : `${input.authorName} posted`,
            userId,
          }),
        ),
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "community_post_notify_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown error",
        postId: input.postId,
      }),
    );
  }
}
