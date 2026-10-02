import { Image } from "expo-image";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { VoiceNotePlayer } from "@/components/voice-note-player";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError, readApiErrorCode } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import {
  complaintCategoryLabel,
  complaintStanding,
  confirmNote,
  threadEntries,
} from "@/lib/complaints";
import {
  type Complaint,
  type ComplaintList,
  confirmComplaintResolution,
} from "@/lib/complaints-api";
import { formatDueLabel } from "@/lib/format";
import { residentQuery } from "@/lib/resident-queries";
import { toastSuccess } from "@/lib/toast";
import { privateAssetSource } from "@/lib/uploads";

/**
 * One complaint, its files and its thread.
 *
 * ## Why this loads a list
 *
 * There is no `/resident/complaints/[id]`, and there does not need to be:
 * `listResidentComplaints` returns every complaint with its attachments and its
 * complete `updates` thread inline. So this fetches the same list the previous
 * screen did and finds its row. That also makes the screen deep-linkable from a
 * push notification, which a screen fed by route params would not be.
 *
 * ## The thread is read-only
 *
 * `complaintReplySchema` exists but its only route is the admin one, so there is
 * no reply box. A text field that posted nowhere would be worse than its absence.
 */

export default function ComplaintDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const query = residentQuery.complaints();
  const complaints = useResource<ComplaintList>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const complaint =
    complaints.data?.complaints.find((row) => row.id === id) ?? null;
  const header = <AppBar showBack title="Complaint" />;

  if (complaints.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  if (complaints.error) {
    return (
      <Screen header={header}>
        <ErrorState message={complaints.error} onRetry={complaints.reload} />
      </Screen>
    );
  }

  /*
   * Loaded, but this id is not in the list. The honest reading is that it is not
   * this resident's complaint (or no longer exists) — not that the fetch failed —
   * so it does not offer a retry that would do the same thing again.
   */
  if (!complaint) {
    return (
      <Screen header={header}>
        <ErrorState message="This complaint is not on your account." />
      </Screen>
    );
  }

  return (
    <ComplaintDetail
      complaint={complaint}
      onChanged={(next) =>
        complaints.setData((current) =>
          current
            ? {
                ...current,
                complaints: current.complaints.map((row) =>
                  row.id === next.id ? next : row,
                ),
              }
            : current,
        )
      }
      onRefresh={complaints.refresh}
      refreshing={complaints.refreshing}
    />
  );
}

function ComplaintDetail({
  complaint,
  onChanged,
  onRefresh,
  refreshing,
}: {
  complaint: Complaint;
  onChanged: (complaint: Complaint) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const dates = useDates();

  const standing = complaintStanding(complaint);
  const entries = threadEntries(complaint);
  const [confirming, setConfirming] = useState(false);

  const due =
    complaint.status === "PENDING" || complaint.status === "IN_PROGRESS"
      ? formatDueLabel(complaint.slaDueAt)
      : null;

  return (
    <Screen
      footer={
        standing.action === "confirm" ? (
          <Button
            label="Confirm it is fixed"
            onPress={() => setConfirming(true)}
          />
        ) : undefined
      }
      header={<AppBar accent centerTitle showBack title="Complaint" />}
      onRefresh={onRefresh}
      refreshing={refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card padding="p-5" className="gap-5">
          <View className="flex-row items-start gap-2">
            <Text className="flex-1" variant="subtitle">
              {complaint.title}
            </Text>
            <StatusPill status={complaint.status} />
          </View>

          {complaint.description ? (
            <Text style={{ lineHeight: 26 }}>{complaint.description}</Text>
          ) : null}

          {/*
            The recording sits inside the card with the description rather than
            in the attachments section below, because for a complaint raised by
            speaking it *is* the description — the photographs are the evidence
            beside it. Somebody opening their own complaint should find their own
            words where the words go.
          */}
          {complaint.voiceNoteAssetId ? (
            <VoiceNotePlayer assetId={complaint.voiceNoteAssetId} />
          ) : null}

          <View className="flex-row flex-wrap items-center gap-2">
            <Badge label={complaintCategoryLabel(complaint.category)} />
            {complaint.isOverdue ? (
              <Badge label="Overdue" tone="danger" />
            ) : null}
            {complaint.isAnonymous ? <Badge label="Anonymous" /> : null}
          </View>

          <View className="gap-1 border-t border-border pt-3">
            <Text variant="label">{standing.headline}</Text>
            <Text variant="caption">
              Raised {dates.dateTime(complaint.createdAt)}
              {due ? ` · ${due}` : ""}
            </Text>
          </View>
        </Card>

        {complaint.attachments.length > 0 ? (
          <AttachmentGallery complaint={complaint} />
        ) : null}

        <View>
          <SectionHeader subtitle="Updates from your hostel" title="History" />

          <View className="gap-2">
            {entries.map((entry) => (
              <Card padding="p-5" className="gap-3" key={entry.id}>
                <View className="flex-row items-center gap-2">
                  <Text
                    className={entry.mine ? "text-primary" : undefined}
                    variant="label"
                  >
                    {entry.actor}
                  </Text>
                  <View className="flex-1" />
                  <Text variant="caption">{dates.dateTime(entry.at)}</Text>
                </View>

                <Text style={{ lineHeight: 24 }}>{entry.body}</Text>
                {entry.note ? <Text variant="muted">{entry.note}</Text> : null}
              </Card>
            ))}
          </View>
        </View>
      </View>

      <ConfirmSheet
        complaintId={complaint.id}
        onClose={() => setConfirming(false)}
        onConfirmed={onChanged}
        open={confirming}
      />
    </Screen>
  );
}

/**
 * The attachments.
 *
 * These are **private** `FileAsset`s: `files/[assetId]/url` 401s without a
 * principal and then 302s to a presigned R2 URL, so the bearer token has to ride
 * on the image request. `privateAssetSource` is the one place that is assembled —
 * see its comment for what R2 does if the header reaches *it*.
 */
function AttachmentGallery({ complaint }: { complaint: Complaint }) {
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  const { colors } = useAppTheme();

  /*
   * Handed to the global viewer whole, not one photo at a time: someone who
   * attached four pictures of the same leak wants to swipe between them, and
   * the sheet this replaced opened exactly one and trapped you there.
   */
  const items = complaint.attachments.map((attachment) => ({
    assetId: attachment.fileAssetId,
    caption: dates.dateTime(complaint.createdAt),
    title: complaint.title,
  }));

  return (
    <View>
      <SectionHeader
        subtitle={
          complaint.attachments.length === 1
            ? "1 photo"
            : `${complaint.attachments.length} photos`
        }
        title="Attached"
      />

      <View className="flex-row flex-wrap gap-2">
        {complaint.attachments.map((attachment, index) => (
          <Pressable
            accessibilityLabel="Open photo"
            accessibilityRole="imagebutton"
            className="active:opacity-80"
            key={attachment.id}
            onPress={() => openAssetViewer(items, index)}
          >
            <Image
              contentFit="cover"
              // THUMBNAIL, which the route serves when a variant exists and
              // silently falls back to the original when it does not — so this
              // is free rather than a bet on the optimizer having run.
              source={privateAssetSource(
                attachment.fileAssetId,
                token,
                "THUMBNAIL",
              )}
              style={{
                backgroundColor: colors.muted,
                borderRadius: 12,
                height: 96,
                width: 96,
              }}
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * Confirming a fix, with an optional note.
 *
 * `note` is optional-but-min-2 on the server, so `confirmNote` decides between
 * omitting the field and refusing a single character. A `409
 * COMPLAINT_NOT_RESOLVED` should be unreachable — the button only exists when
 * `canConfirmResolution` is true — but it is handled anyway, because the one way
 * to get there is a staff member re-opening the complaint between the fetch and
 * the tap, and "that is not resolved any more" is the useful thing to say.
 */
function ConfirmSheet({
  complaintId,
  onClose,
  onConfirmed,
  open,
}: {
  complaintId: string;
  onClose: () => void;
  onConfirmed: (complaint: Complaint) => void;
  open: boolean;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const parsed = confirmNote(note);

    if (parsed.error) {
      setError(parsed.error);
      return;
    }

    setError(null);
    setBusy(true);

    try {
      const complaint = await confirmComplaintResolution(complaintId, parsed);

      onConfirmed(complaint);
      toastSuccess(
        "Thanks — closed out",
        "Your hostel can see you confirmed it.",
      );
      setNote("");
      onClose();
    } catch (caught) {
      if (readApiErrorCode(caught) === "COMPLAINT_NOT_RESOLVED") {
        setError(
          "Your hostel has re-opened this, so there is nothing to confirm yet.",
        );
      } else {
        setError(readApiError(caught));
      }
    } finally {
      setBusy(false);
    }
  }, [complaintId, note, onClose, onConfirmed]);

  return (
    <Sheet
      footer={
        <Button label="Confirm" loading={busy} onPress={() => void submit()} />
      }
      onClose={onClose}
      open={open}
      title="Confirm it is fixed"
    >
      <View className="gap-3">
        <Text variant="muted">
          This tells your hostel the fix worked. If it did not, leave this and
          say so — they can re-open it.
        </Text>

        <Input
          error={error}
          label="Anything to add? (optional)"
          maxLength={1000}
          multiline
          onChangeText={setNote}
          placeholder="Tap was replaced on Tuesday."
          style={{ height: 88, paddingTop: 12, textAlignVertical: "top" }}
          value={note}
        />
      </View>
    </Sheet>
  );
}
