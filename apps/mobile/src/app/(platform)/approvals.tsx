import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { AdminSearchBar } from "@/components/admin-search-bar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { useResource } from "@/hooks/use-resource";
import {
  hostelStatusTone,
  isAwaitingReview,
  listPlatformHostels,
  type PlatformHostel,
  statusLabel,
} from "@/lib/platform-admin-api";

/**
 * Hostels — the web's Hostel Approvals and Listings in one list: the queue of
 * decisions first (Review), then every stage, and the archived ones apart
 * (a separate read, as on the web). A row opens the hostel, where every action
 * the web offers for its stage lives.
 */

const FILTERS = [
  { key: "review", label: "Review", match: isAwaitingReview },
  { key: "live", label: "Live", match: (hostel: PlatformHostel) => hostel.status === "PUBLISHED" },
  { key: "approved", label: "Approved", match: (hostel: PlatformHostel) => hostel.status === "APPROVED" },
  { key: "suspended", label: "Suspended", match: (hostel: PlatformHostel) => Boolean(hostel.suspension) },
  { key: "rejected", label: "Rejected", match: (hostel: PlatformHostel) => hostel.status === "REJECTED" },
  { key: "all", label: "All", match: () => true },
  { key: "archived", label: "Archived", match: () => true },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const loadLive = () => listPlatformHostels(false);
const loadArchived = () => listPlatformHostels(true);

function HostelRow({ hostel }: { hostel: PlatformHostel }) {
  const badge = hostel.suspension
    ? { label: hostel.suspension.stage === "SUSPENDED" ? "Suspended" : "Notice", tone: "danger" as const }
    : { label: statusLabel(hostel.status), tone: hostelStatusTone(hostel.status) };

  return (
    <ListRow
      icon="hostel"
      onPress={() => router.push(`/manage/platform/hostel/${hostel.id}`)}
      right={<Badge label={badge.label} tone={badge.tone} />}
      subtitle={[hostel.location.area, hostel.owner?.name].filter(Boolean).join(" · ") || undefined}
      title={hostel.name}
    />
  );
}

export default function PlatformHostelsScreen() {
  const [filter, setFilter] = useState<FilterKey>("review");
  const [search, setSearch] = useState("");
  const live = useResource(loadLive, { cacheKey: "platform:hostels" });
  const archived = useResource(loadArchived, { cacheKey: "platform:hostels:archived" });
  const source = filter === "archived" ? archived : live;

  const counts = useMemo(() => {
    const all = live.data ?? [];
    return Object.fromEntries(FILTERS.map((entry) => [entry.key, entry.key === "archived" ? undefined : all.filter(entry.match).length]));
  }, [live.data]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rule = FILTERS.find((entry) => entry.key === filter)!;
    return (source.data ?? []).filter(
      (hostel) =>
        rule.match(hostel) &&
        (!needle ||
          [hostel.name, hostel.location.area, hostel.location.city, hostel.owner?.name, hostel.owner?.phone, hostel.owner?.email, hostel.hostelCode]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(needle))),
    );
  }, [filter, search, source.data]);

  return (
    <Screen
      header={<AdminSearchBar onQueryChange={setSearch} placeholder="Name, area, owner, phone" query={search} title="Hostels" />}
      insideTabs
      onRefresh={source.refresh}
      refreshing={source.refreshing}
      scroll
    >
      <View className="gap-4">
        <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
          {FILTERS.map((entry) => (
            <Chip
              key={entry.key}
              label={counts[entry.key] !== undefined ? `${entry.label} · ${counts[entry.key]}` : entry.label}
              onPress={() => setFilter(entry.key)}
              tone={filter === entry.key ? "brand" : "neutral"}
            />
          ))}
        </ScrollView>

        {source.loading ? (
          <SkeletonRows rows={6} />
        ) : source.error ? (
          <ErrorState message={source.error} onRetry={source.reload} />
        ) : rows.length === 0 ? (
          <EmptyCard
            description={search ? "Try another name, area or phone." : filter === "review" ? "No hostel is waiting on a decision." : "No hostel in this list."}
            title={search ? "No match" : "Nothing here"}
          />
        ) : (
          <Card padding="px-4 py-1">
            {rows.map((hostel, index) => (
              <View key={hostel.id}>
                {index > 0 ? <RowDivider /> : null}
                <HostelRow hostel={hostel} />
              </View>
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}
