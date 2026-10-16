import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { PersonAvatar } from "@/components/ui/avatar";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import {
  addPostComment,
  type CommunityComment,
  deleteCommunityComment,
  voteOnComment,
} from "@/lib/community-api";
import {
  feedTime,
  hiddenCommentIds,
  MAX_COMMENT_BODY,
  nextVote,
  replyCounts,
} from "@/lib/community";
import { openConfirm } from "@/lib/confirm";
import { toastError, toastInfo, toastSuccess } from "@/lib/toast";

/**
 * The comment tree, ported from the web's `CommentThread`.
 *
 * The server returns the tree **already flattened into display order** with a
 * `depth` on each row, capped at 5 — so this indents by `depth` and never rebuilds
 * the tree. Rebuilding or re-sorting it would cut replies away from what they
 * answer.
 *
 * ## Votes echo locally
 *
 * The arrow responds to the tap and the refetch behind it reconciles. Tapping the
 * arrow already chosen clears the vote, which is both the web's behaviour and the
 * server's (`value: 0` deletes the row). `lib/community.ts`'s `nextVote` owns the
 * arithmetic, including the flip that moves a score by two.
 *
 * ## Indentation is capped in pixels as well as in depth
 *
 * `depth` stops at 5 server-side, but 5 × 26dp is 130dp of a 320dp screen. The
 * step shrinks to 14dp here, so a deep argument still leaves the text readable —
 * the same intent as the web's cap, at a phone's width.
 */

const INDENT_STEP = 14;

export function CommentThread({
  canPost,
  comments,
  onChanged,
  postId,
}: {
  canPost: boolean;
  comments: CommunityComment[];
  onChanged: () => void;
  postId: string;
}) {
  const { colors } = useAppTheme();

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [localVotes, setLocalVotes] = useState<
    Record<string, { score: number; value: number }>
  >({});

  const hidden = useMemo(
    () => hiddenCommentIds(comments, collapsed),
    [collapsed, comments],
  );
  const replies = useMemo(() => replyCounts(comments), [comments]);

  const vote = useCallback(
    async (comment: CommunityComment, direction: 1 | -1) => {
      if (!canPost) {
        toastInfo("Account needed", "Sign in to vote on comments.");
        return;
      }

      const current = localVotes[comment.id]?.value ?? comment.viewerVote;
      const base = localVotes[comment.id]?.score ?? comment.score;
      const next = nextVote(current, base, direction);

      setLocalVotes((votes) => ({
        ...votes,
        [comment.id]: { score: next.score, value: next.value },
      }));

      try {
        await voteOnComment(postId, comment.id, next.value);
      } catch (caught) {
        setLocalVotes((votes) => ({
          ...votes,
          [comment.id]: { score: base, value: current },
        }));
        toastError("Could not vote", readApiError(caught));
      }
    },
    [canPost, localVotes, postId],
  );

  /*
   * The reply button had no state at all: no spinner, and nothing stopping a
   * second tap posting the same reply twice while the first was still in the
   * air. Both are the same flag.
   */
  const [replying, setReplying] = useState(false);

  const submitReply = useCallback(
    async (parentId: string) => {
      const body = replyDraft.trim();

      if (!body) {
        return;
      }

      setReplying(true);

      try {
        await addPostComment(postId, { body, parentId });
        setReplyDraft("");
        setReplyingTo(null);
        onChanged();
      } catch (caught) {
        toastError("Could not reply", readApiError(caught));
      } finally {
        setReplying(false);
      }
    },
    [onChanged, postId, replyDraft],
  );

  const removeComment = useCallback(
    (commentId: string) =>
      openConfirm({
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: async () => {
          try {
            await deleteCommunityComment(postId, commentId);
            toastSuccess("Comment deleted");
            onChanged();
          } catch (caught) {
            toastError("Could not delete", readApiError(caught));
          }
        },
        title: "Delete this comment?",
      }),
    [onChanged, postId],
  );

  return (
    <View className="gap-3">
      {comments
        .filter((comment) => !hidden.has(comment.id))
        .map((comment) => {
          const isCollapsed = collapsed.has(comment.id);
          const replyCount = replies.get(comment.id) ?? 0;
          const score = localVotes[comment.id]?.score ?? comment.score;
          const viewerVote = localVotes[comment.id]?.value ?? comment.viewerVote;

          return (
            <View
              className={comment.depth > 0 ? "border-l border-border pl-2.5" : ""}
              key={comment.id}
              style={{ marginLeft: comment.depth * INDENT_STEP }}
            >
              <View className="flex-row gap-2.5">
                <PersonAvatar
                  image={comment.authorImage}
                  name={comment.authorName}
                  size="sm"
                />

                <View className="flex-1 gap-1">
                  <View className="flex-row items-center gap-2">
                    <Text variant="label">{comment.authorName}</Text>
                    <Text variant="caption">{feedTime(comment.createdAt)}</Text>
                  </View>

                  {isCollapsed ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        setCollapsed((ids) => {
                          const next = new Set(ids);
                          next.delete(comment.id);
                          return next;
                        })
                      }
                    >
                      <Text variant="caption">
                        {replyCount === 1
                          ? "1 reply hidden — tap to expand"
                          : `${replyCount} replies hidden — tap to expand`}
                      </Text>
                    </Pressable>
                  ) : comment.isDeleted ? (
                    <Text className="italic" variant="caption">
                      Comment deleted
                    </Text>
                  ) : (
                    <>
                      <Text>{comment.body}</Text>

                      <View className="flex-row items-center gap-4">
                        <View className="flex-row items-center gap-1.5">
                          <Pressable
                            accessibilityLabel="Upvote"
                            accessibilityRole="button"
                            accessibilityState={{ selected: viewerVote === 1 }}
                            hitSlop={8}
                            onPress={() => void vote(comment, 1)}
                          >
                            <Glyph
                              color={viewerVote === 1 ? colors.primary : colors.mutedForeground}
                              name="arrow-up"
                              size={15}
                            />
                          </Pressable>

                          <Text variant="caption">{score}</Text>

                          <Pressable
                            accessibilityLabel="Downvote"
                            accessibilityRole="button"
                            accessibilityState={{ selected: viewerVote === -1 }}
                            hitSlop={8}
                            onPress={() => void vote(comment, -1)}
                          >
                            <Glyph
                              color={
                                viewerVote === -1 ? colors.destructive : colors.mutedForeground
                              }
                              name="arrow-down"
                              size={15}
                            />
                          </Pressable>
                        </View>

                        {canPost ? (
                          <Pressable
                            accessibilityRole="button"
                            hitSlop={6}
                            onPress={() => {
                              setReplyDraft("");
                              setReplyingTo((id) =>
                                id === comment.id ? null : comment.id,
                              );
                            }}
                          >
                            <Text variant="caption">Reply</Text>
                          </Pressable>
                        ) : null}

                        {comment.isMine ? (
                          <Pressable
                            accessibilityLabel="Delete comment"
                            accessibilityRole="button"
                            hitSlop={6}
                            onPress={() => removeComment(comment.id)}
                          >
                            <Glyph
                              color={colors.mutedForeground}
                              name="trash"
                              size={15}
                            />
                          </Pressable>
                        ) : null}

                        {replyCount > 0 ? (
                          <Pressable
                            accessibilityRole="button"
                            hitSlop={6}
                            onPress={() =>
                              setCollapsed((ids) => new Set(ids).add(comment.id))
                            }
                          >
                            <Text className="text-primary" variant="caption">
                              Collapse
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>

                      {replyingTo === comment.id ? (
                        <View className="mt-1">
                          <CommentInput
                            autoFocus
                            busy={replying}
                            onChangeText={setReplyDraft}
                            onSend={() => void submitReply(comment.id)}
                            placeholder="Write a reply…"
                            value={replyDraft}
                          />
                        </View>
                      ) : null}
                    </>
                  )}
                </View>
              </View>
            </View>
          );
        })}
    </View>
  );
}

/**
 * The comment and reply field: a filled pill with its send button inside it,
 * instead of a bordered box with a button stacked under it.
 */
export function CommentInput({
  autoFocus,
  busy,
  onChangeText,
  onSend,
  placeholder,
  value,
}: {
  autoFocus?: boolean;
  busy: boolean;
  onChangeText: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  value: string;
}) {
  const { colors } = useAppTheme();
  const ready = value.trim().length > 0 && !busy;

  return (
    <View
      className="flex-row items-end gap-2 rounded-3xl pl-4 pr-1.5"
      style={{ backgroundColor: colors.muted, minHeight: 44, paddingVertical: 4 }}
    >
      <TextInput
        autoFocus={autoFocus}
        className="flex-1 text-base text-foreground"
        maxLength={MAX_COMMENT_BODY}
        multiline
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        style={{ maxHeight: 110, paddingBottom: 8, paddingTop: 8 }}
        value={value}
      />

      <Pressable
        accessibilityLabel="Send"
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: !ready }}
        className="h-9 w-9 items-center justify-center rounded-full active:opacity-80"
        disabled={!ready}
        onPress={onSend}
        style={{ backgroundColor: ready ? colors.primary : "transparent" }}
      >
        {busy ? (
          <ActivityIndicator color={colors.primary} size="small" />
        ) : (
          <Glyph
            color={ready ? colors.primaryForeground : colors.mutedForeground}
            name="send"
            size={15}
          />
        )}
      </Pressable>
    </View>
  );
}
