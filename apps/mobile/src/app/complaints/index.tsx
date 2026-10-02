import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { complaintCategoryLabel, complaintStanding } from "@/lib/complaints";
import { type Complaint, type ComplaintList } from "@/lib/complaints-api";
import { residentQuery } from "@/lib/resident-queries";

/**
 * Everything this resident has raised.
 *
 * ## Open first, then the rest
 *
 * Sorted newest-first by the server, which is right within a group and wrong
 * across them: a complaint resolved this morning would sit above the one that
 * has been ignored for a week. So open complaints are lifted to the top and the
 * closed ones keep their own order underneath — the list is a worklist, and the
 * thing still waiting is the thing to see first.
 *
 * ## No pager
 *
 * The route takes no query, so the response is always the newest 100. A pager
 * would be a control the server ignores. See `lib/complaints-api.ts`.
 */

const OPEN_STATUSES = new Set(["IN_PROGRESS", "PENDING"]);

/** Awaiting the resident's own confirmation — the only row with something to do. */
function needsResident(complaint: Complaint) {
  return complaint.status === "RESOLVED" && !complaint.confirmedAt;
}

function rank(complaint: Complaint) {
  if (needsResident(complaint)) {
    return 0;
  }

  return OPEN_STATUSES.has(complaint.status) ? 1 : 2;
}

export default function ComplaintsScreen() {
  const query = residentQuery.complaints();
  const complaints = useResource<ComplaintList>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const [showClosed, setShowClosed] = useState(true);

  const rows = useMemo(() => {
    const all = complaints.data?.complaints ?? [];

    // A copy: `sort` mutates, and this array belongs to the resource's state.
    return [...all].sort((left, right) => rank(left) - rank(right));
  }, [complaints.data]);

  const open = rows.filter((complaint) => OPEN_STATUSES.has(complaint.status));
  const visible = showClosed
    ? rows
    : rows.filter(
        (complaint) =>
          OPEN_STATUSES.has(complaint.status) || needsResident(complaint),
      );

  const header = (
    <AppBar
      accent
      centerTitle
      showBack
      subtitle={
        complaints.data
          ? open.length > 0
            ? `${open.length} still open`
            : "Nothing open"
          : undefined
      }
      title="Complaints"
    />
  );

  if (complaints.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (complaints.error || !complaints.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={complaints.error ?? "Your complaints could not be loaded."}
          onRetry={complaints.reload}
        />
      </Screen>
    );
  }

  return (
    <Screen
      floating={
        <FloatingButton
          icon="add"
          label="Raise a complaint"
          onPress={() => router.push("/complaints/new")}
        />
      }
      header={header}
      onRefresh={complaints.refresh}
      refreshing={complaints.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        {rows.length === 0 ? (
          <EmptyState title="No complaints yet" />
        ) : (
          <>
            {/* Only worth a control once there is something it would hide. */}
            {rows.length > open.length ? (
              <ScrollView
                contentContainerClassName="gap-2"
                horizontal
                showsHorizontalScrollIndicator={false}
              >
                <FilterChip
                  active={showClosed}
                  label="All"
                  onPress={() => setShowClosed(true)}
                />
                <FilterChip
                  active={!showClosed}
                  label="Needs attention"
                  onPress={() => setShowClosed(false)}
                />
              </ScrollView>
            ) : null}

            {visible.length === 0 ? (
              <EmptyState title="Nothing needs you" />
            ) : (
              <Card padding="px-4 py-1">
                {visible.map((complaint, index) => (
                  <View key={complaint.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ComplaintRow complaint={complaint} />
                  </View>
                ))}
              </Card>
            )}
          </>
        )}
      </View>
    </Screen>
  );
}

function FilterChip({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      className={`rounded-full border px-3.5 py-2 active:opacity-70 ${
        active ? "border-primary bg-primary" : "border-border"
      }`}
      onPress={onPress}
    >
      <Text
        className={`text-sm font-medium ${
          active ? "text-primary-foreground" : "text-foreground"
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const CATEGORY_LOOK: Record<
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

/**
 * One complaint: its category's tile, the title, one line of where it stands.
 * A resolution waiting on the resident gets the badge — the one thing this list
 * can ask *them* to do.
 */
function ComplaintRow({ complaint }: { complaint: Complaint }) {
  const dates = useDates();
  const standing = complaintStanding(complaint);
  const look = CATEGORY_LOOK[complaint.category] ?? CATEGORY_LOOK.OTHER!;

  return (
    <ListRow
      icon={look.icon}
      iconBgColor={
        OPEN_STATUSES.has(complaint.status) || standing.action
          ? look.bg
          : "#8E8E93"
      }
      onPress={() => router.push(`/complaints/${complaint.id}`)}
      right={
        standing.action ? (
          <Badge label="Confirm fix" tone="warning" />
        ) : complaint.isOverdue ? (
          <Badge label="Overdue" tone="danger" />
        ) : (
          <StatusPill status={complaint.status} />
        )
      }
      subtitle={`${complaintCategoryLabel(complaint.category)} · ${dates.relativeDay(complaint.createdAt)}`}
      title={complaint.title}
    />
  );
}
