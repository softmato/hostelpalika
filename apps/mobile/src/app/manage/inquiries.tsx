import { useCallback, useMemo, useState } from "react";
import { Linking, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Avatar } from "@/components/ui/avatar";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  type InquiryStatus,
  type ManagedInquiry,
  setInquiryStatus,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { humanizeEnum } from "@/lib/format";
import { groupNotifications } from "@/lib/notification-groups";
import {
  type InquiryBucket,
  inquiryActions,
  inquiryCounts,
  inquiriesIn,
} from "@/lib/inquiries";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Leads — the queue behind the red count on Home.
 *
 * ## Why this screen exists at all
 *
 * Home's `New inquiries` tile used to open the **Residents** tab, and that was
 * wrong in the way that is hardest to notice: it looked like it worked. The
 * roster is a directory of people who already live here, an inquiry is somebody
 * asking whether they could — so the tap landed on a list that did not contain
 * the thing it was counting, and the red badge that sent you there had no way of
 * being cleared once you arrived. A count nobody can act on trains people to
 * stop looking at counts.
 *
 * `(admin)/alerts` does carry leads, as one of four kinds in a triage feed. That
 * is the right home for *is anything waiting*, and the wrong one for working
 * through fifteen of them: the feed is ranked by consequence, so leads sit under
 * every SOS, complaint and payment claim, and nothing there says how many have
 * been answered.
 *
 * ## Marking one read is a real write, not a local flag
 *
 * There is no `read` field on an inquiry, and adding a client-side one would
 * make the app disagree with the web portal about the same lead. "Mark read"
 * writes `CONTACTED` — the server's own word for *somebody has picked this up* —
 * which is what removes it from the `status=NEW` pull the Home count is built
 * from. So the badge clears because the record changed, not because this screen
 * hid something.
 *
 * See `lib/inquiries.ts` for why five statuses are shown under three segments,
 * and why the buttons on a card depend on where the lead already is.
 *
 * ## No compose button
 *
 * A lead arrives from the public site or a referral link. There is no route that
 * creates one from the hostel side, and a hostel typing in somebody who rang the
 * doorbell is registering a resident, which is `manage/resident/new`.
 */

const SEGMENTS: { bucket: InquiryBucket; label: string }[] = [
  { bucket: "new", label: "New" },
  { bucket: "working", label: "Working" },
  { bucket: "done", label: "Done" },
];

export default function ManageInquiriesScreen() {
  const dates = useDates();

  // Warmed on portal entry: Home's "New inquiries" tile carries the count that
  // sends people here, so this is a queue an owner opens because they were
  // already told there was something in it.
  const query = adminQuery.inquiries();
  const inquiries = useResource<ManagedInquiry[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [bucket, setBucket] = useState<InquiryBucket>("new");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState<ManagedInquiry | null>(null);

  const rows = useMemo(() => inquiries.data ?? [], [inquiries.data]);
  const counts = useMemo(() => inquiryCounts(rows), [rows]);
  const groups = useMemo(() => groupNotifications(inquiriesIn(rows, bucket)), [bucket, rows]);
  const answered = rows.length - counts.new;

  const { refresh } = inquiries;

  const move = useCallback(
    async (inquiry: ManagedInquiry, status: InquiryStatus) => {
      setBusyId(inquiry.id);

      try {
        await setInquiryStatus(inquiry.id, status);
        toastSuccess(
          `Marked ${humanizeEnum(status).toLowerCase()}`,
          status === "CONTACTED"
            ? "It has left the new-inquiry count on Home."
            : undefined,
        );
        setOpen(null);
        await refresh();
      } catch (error) {
        toastError("Could not update", readApiError(error, "That did not save."));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const header = <AppBar accent centerTitle showBack title="Leads" />;

  if (inquiries.error) {
    return (
      <Screen header={header}>
        {/*
          The server's own wording. A warden without the grant is told about the
          permission rather than shown an empty queue, which would read as "no
          one has enquired" — the mistake `PermissionCard` exists to prevent.
        */}
        <ErrorState message={inquiries.error} onRetry={inquiries.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      onRefresh={inquiries.refresh}
      refreshing={inquiries.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        {rows.length > 0 ? (
          <Card>
            <Meter
              label={`${answered} of ${rows.length} leads picked up`}
              percent={Math.round((answered / rows.length) * 100)}
            />
          </Card>
        ) : null}

        <Segmented
          onChange={setBucket}
          options={SEGMENTS.map((segment) => ({
            count: counts[segment.bucket],
            label: segment.label,
            value: segment.bucket,
          }))}
          value={bucket}
        />

        {/* Skeletons, not a spinner — NOTES §9. */}
        {inquiries.loading ? <SkeletonRows rows={4} /> : null}

        {!inquiries.loading && groups.length === 0 ? (
          <EmptyCard title={bucket === "new" ? "Nothing waiting" : "Nothing here"} />
        ) : null}

        {groups.map((group) => (
          <View className="gap-2" key={group.bucket}>
            <Text className="px-0.5 font-semibold uppercase tracking-wider" variant="caption">
              {group.label}
            </Text>
            <Card padding="px-4 py-1">
              {group.rows.map((inquiry, index) => (
                <View key={inquiry.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    left={<Avatar name={inquiry.name} size="sm" />}
                    onPress={() => setOpen(inquiry)}
                    right={<StatusPill status={inquiry.status} />}
                    subtitle={
                      [
                        inquiry.preferredRoomType ? humanizeEnum(inquiry.preferredRoomType) : null,
                        inquiry.budgetRange || null,
                        inquiry.createdAt ? dates.ago(inquiry.createdAt) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || undefined
                    }
                    title={inquiry.name || "Someone"}
                  />
                </View>
              ))}
            </Card>
          </View>
        ))}
      </View>

      <Sheet onClose={() => setOpen(null)} open={open !== null} title={open?.name || "Lead"}>
        {open ? (
          <LeadSheet busy={busyId === open.id} inquiry={open} onMove={move} />
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** One lead, opened: what they asked, how to reach them, where it goes next. */
function LeadSheet({
  busy,
  inquiry,
  onMove,
}: {
  busy: boolean;
  inquiry: ManagedInquiry;
  onMove: (inquiry: ManagedInquiry, status: InquiryStatus) => Promise<void>;
}) {
  const actions = inquiryActions(inquiry.status);

  return (
    <View className="gap-4 pb-2">
      <View className="flex-row flex-wrap gap-2">
        <StatusPill status={inquiry.status} />
        {inquiry.preferredRoomType ? (
          <Text variant="caption">{humanizeEnum(inquiry.preferredRoomType)}</Text>
        ) : null}
        {inquiry.budgetRange ? <Text variant="caption">{inquiry.budgetRange}</Text> : null}
      </View>

      {inquiry.message ? <Text>{inquiry.message}</Text> : null}

      {/* The number is the action — no dead Call button for a lead without one. */}
      <View className="flex-row gap-2">
        {inquiry.phone ? (
          <Button
            className="flex-1"
            label="Call"
            onPress={() => void Linking.openURL(`tel:${inquiry.phone}`)}
            variant="outline"
          />
        ) : null}
        {inquiry.email ? (
          <Button
            className="flex-1"
            label="Email"
            onPress={() => void Linking.openURL(`mailto:${inquiry.email}`)}
            variant="outline"
          />
        ) : null}
      </View>

      {actions.length > 0 ? (
        <View className="flex-row gap-2">
          {actions.map((action, index) => (
            <Button
              className="flex-1"
              disabled={busy}
              key={action.status}
              label={action.label}
              loading={busy && index === 0}
              onPress={() => void onMove(inquiry, action.status)}
              variant={index === 0 ? "primary" : "ghost"}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
