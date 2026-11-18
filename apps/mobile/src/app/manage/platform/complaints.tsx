import { useMemo, useState } from "react";
import { View } from "react-native";

import { Figures, Quiet, Rows, TintRow } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { listPlatformComplaints, statusLabel } from "@/lib/platform-admin-api";

/**
 * Complaints across every hostel (web `platform-complaints-page`) — read only:
 * the hostel answers its own residents. This is where the owner sees which
 * hostels let complaints run past their SLA.
 */
export default function PlatformComplaintsScreen() {
  const dates = useDates();
  const list = useResource(listPlatformComplaints, { cacheKey: "platform:complaints" });
  const [filter, setFilter] = useState<"overdue" | "open" | "all">("overdue");
  const counts = list.data?.statusCounts ?? {};
  const all = useMemo(() => list.data?.complaints ?? [], [list.data]);
  const overdue = all.filter((row) => row.isOverdue).length;

  const rows = useMemo(() => {
    if (filter === "overdue") return all.filter((row) => row.isOverdue);
    if (filter === "open") return all.filter((row) => !row.resolvedAt && row.status !== "RESOLVED" && row.status !== "CLOSED");
    return all;
  }, [all, filter]);

  return (
    <Screen header={<AppBar showBack title="Complaints" />} onRefresh={list.refresh} refreshing={list.refreshing} scroll>
      <View className="gap-5">
        <Figures
          items={[
            { label: "Open", loading: list.loading, value: (counts.PENDING ?? 0) + (counts.IN_PROGRESS ?? 0) },
            { label: "Past SLA", loading: list.loading, tone: overdue ? "danger" : undefined, value: overdue },
            { label: "Resolved", loading: list.loading, tone: "success", value: counts.RESOLVED ?? 0 },
          ]}
        />
        <Segmented
          onChange={setFilter}
          options={[
            { count: overdue, label: "Past SLA", value: "overdue" },
            { label: "Open", value: "open" },
            { label: "All", value: "all" },
          ]}
          value={filter}
        />
        {list.loading ? (
          <SkeletonRows rows={5} />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : rows.length === 0 ? (
          <Quiet>{filter === "overdue" ? "Every hostel is inside its SLA." : "No complaint here."}</Quiet>
        ) : (
          <Rows>
            {rows.map((row) => (
              <TintRow
                icon="chatbox-alert"
                key={row.id}
                subtitle={[row.hostelName, row.category, row.createdAt ? dates.ago(row.createdAt) : null].filter(Boolean).join(" · ")}
                title={row.title}
                tone={row.isOverdue ? "danger" : row.resolvedAt ? "success" : "warning"}
                value={statusLabel(row.status)}
              />
            ))}
          </Rows>
        )}
      </View>
    </Screen>
  );
}
