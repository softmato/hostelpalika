import type { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  type AdminComplaint,
  replyToComplaint,
  setComplaintStatus,
} from "@/lib/admin-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { humanizeEnum } from "@/lib/format";
import { groupNotifications } from "@/lib/notification-groups";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Complaints — every one the hostel has, for the staff who answer them.
 *
 * The home tile used to land on Today, whose complaint section only lists the
 * ones already past their reply time. This is the whole queue: date-grouped
 * rows with a coloured trade tile, and a sheet that replies, marks in progress,
 * resolves or rejects without a trip to the web portal.
 */

type Filter = "all" | "closed" | "late" | "open";

const OPEN = ["PENDING", "IN_PROGRESS"];

const CATEGORY_ICON: Record<
  string,
  { bg: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  FOOD: { bg: "#FF9500", icon: "restaurant-outline" },
  MAINTENANCE: { bg: "#30B0C7", icon: "construct-outline" },
  NOISE: { bg: "#AF52DE", icon: "volume-high-outline" },
  OTHER: { bg: "#8E8E93", icon: "chatbox-ellipses-outline" },
  PAYMENT: { bg: "#34C759", icon: "cash-outline" },
  ROOM: { bg: "#5E5CE6", icon: "bed-outline" },
  SAFETY: { bg: "#FF3B30", icon: "shield-outline" },
  STAFF: { bg: "#007AFF", icon: "people-outline" },
};

export default function ManageComplaintsScreen() {
  const dates = useDates();
  const [filter, setFilter] = useState<Filter>("open");
  const [open, setOpen] = useState<AdminComplaint | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const query = adminQuery.complaints();
  const list = useResource<AdminComplaint[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const all = useMemo(() => list.data ?? [], [list.data]);
  const counts = useMemo(
    () => ({
      all: all.length,
      closed: all.filter((row) => !OPEN.includes(row.status)).length,
      late: all.filter((row) => row.isOverdue).length,
      open: all.filter((row) => OPEN.includes(row.status)).length,
    }),
    [all],
  );

  const groups = useMemo(() => {
    const visible = all.filter((row) =>
      filter === "open"
        ? OPEN.includes(row.status)
        : filter === "late"
          ? row.isOverdue
          : filter === "closed"
            ? !OPEN.includes(row.status)
            : true,
    );

    // The server sorts by status before date; headings want newest first.
    return groupNotifications(
      [...visible].sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      ),
    );
  }, [all, filter]);

  const show = (row: AdminComplaint) => {
    setReply("");
    setOpen(row);
  };

  const act = async (
    kind: "IN_PROGRESS" | "REJECTED" | "RESOLVED" | "reply",
    success: string,
  ) => {
    if (!open) {
      return;
    }

    const text = reply.trim();

    if ((kind === "reply" || kind === "REJECTED") && text.length < 2) {
      toastError(
        kind === "reply" ? "Write a reply" : "Say why",
        "The resident is shown this.",
      );
      return;
    }

    setBusy(kind);

    try {
      await (kind === "reply"
        ? replyToComplaint(open.id, text)
        : setComplaintStatus(
            open.id,
            kind,
            text.length >= 2 ? text : undefined,
          ));
      toastSuccess(success);
      setOpen(null);
      list.refresh();
    } catch (error) {
      toastError("That didn't go through", readApiError(error));
    } finally {
      setBusy(null);
    }
  };

  const header = <AppBar accent centerTitle showBack title="Complaints" />;
  const isOpen = open ? OPEN.includes(open.status) : false;

  return (
    <Screen
      header={header}
      onRefresh={list.refresh}
      refreshing={list.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        <Segmented
          onChange={setFilter}
          options={[
            { count: counts.open, label: "Open", value: "open" },
            { count: counts.late, label: "Late", value: "late" },
            { count: counts.closed, label: "Closed", value: "closed" },
            { count: counts.all, label: "All", value: "all" },
          ]}
          value={filter}
        />

        {list.loading ? <SkeletonRows rows={5} /> : null}
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : null}

        {!list.loading && !list.error && groups.length === 0 ? (
          <EmptyCard
            description={
              filter === "late"
                ? "Everything has been answered in time."
                : undefined
            }
            title="No complaints here"
          />
        ) : null}

        {groups.map((group) => (
          <View className="gap-2" key={group.bucket}>
            <Text
              className="px-0.5 font-semibold uppercase tracking-wider"
              variant="caption"
            >
              {group.label}
            </Text>
            <Card padding="px-4 py-1">
              {group.rows.map((row, index) => {
                const look =
                  CATEGORY_ICON[row.category] ?? CATEGORY_ICON.OTHER!;

                return (
                  <View key={row.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ListRow
                      icon={look.icon}
                      iconBgColor={look.bg}
                      onPress={() => show(row)}
                      right={
                        row.isOverdue ? (
                          <Badge label="Late" tone="danger" />
                        ) : (
                          <StatusPill status={row.status} />
                        )
                      }
                      subtitle={`${humanizeEnum(row.category)} · ${dates.ago(row.createdAt)}`}
                      title={row.title}
                    />
                  </View>
                );
              })}
            </Card>
          </View>
        ))}
      </View>

      <Sheet
        footer={
          isOpen ? (
            <View className="flex-row gap-2">
              <Button
                className="flex-1"
                disabled={busy !== null}
                label="Send reply"
                loading={busy === "reply"}
                onPress={() => void act("reply", "Reply sent")}
                variant="outline"
              />
              <Button
                className="flex-1"
                disabled={busy !== null}
                label="Resolve"
                loading={busy === "RESOLVED"}
                onPress={() => void act("RESOLVED", "Marked resolved")}
              />
            </View>
          ) : undefined
        }
        onClose={() => setOpen(null)}
        open={open !== null}
        title={open?.title ?? ""}
      >
        {open ? (
          <View className="gap-4 pb-2">
            <View className="flex-row flex-wrap gap-2">
              <StatusPill status={open.status} />
              {open.isOverdue ? <Badge label="Late" tone="danger" /> : null}
              {open.isAnonymous ? (
                <Badge label="Anonymous" tone="neutral" />
              ) : null}
            </View>

            <Card className="gap-1">
              <FactRow label="About" value={humanizeEnum(open.category)} />
              <FactRow label="Raised" value={dates.dateTime(open.createdAt)} />
              <FactRow
                label="Reply due"
                value={dates.dateTime(open.slaDueAt)}
              />
            </Card>

            {open.description ? (
              <Text style={{ lineHeight: 26 }}>{open.description}</Text>
            ) : null}

            {open.adminResponse ? (
              <View className="gap-1 rounded-xl bg-muted p-3">
                <Text variant="label">Your last reply</Text>
                <Text variant="muted">{open.adminResponse}</Text>
              </View>
            ) : null}

            {isOpen ? (
              <>
                <Input
                  label="Reply to the resident"
                  multiline
                  onChangeText={setReply}
                  placeholder="We have called the plumber for tomorrow"
                  style={{ height: 88 }}
                  value={reply}
                />
                <View className="flex-row flex-wrap gap-2">
                  {open.status === "PENDING" ? (
                    <Chip
                      busy={busy === "IN_PROGRESS"}
                      icon="time-outline"
                      label="Mark in progress"
                      onPress={() =>
                        void act("IN_PROGRESS", "Marked in progress")
                      }
                    />
                  ) : null}
                  <Chip
                    busy={busy === "REJECTED"}
                    icon="close-circle-outline"
                    label="Reject with the reply as reason"
                    onPress={() => void act("REJECTED", "Complaint rejected")}
                  />
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
