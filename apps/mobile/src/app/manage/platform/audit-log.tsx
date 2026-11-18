import { useMemo, useState } from "react";
import { View } from "react-native";

import { Quiet, Rows } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { listAuditLog } from "@/lib/platform-admin-api";

/** Audit log — who did what, newest first (web `platform-audit-logs-page`). Read only. */
export default function AuditLogScreen() {
  const dates = useDates();
  const log = useResource(listAuditLog, { cacheKey: "platform:audit-log" });
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (log.data ?? []).filter((row) => !needle || [row.action, row.actorLabel, row.entityType, row.hostelLabel].some((value) => value?.toLowerCase().includes(needle)));
  }, [log.data, search]);

  return (
    <Screen header={<AppBar showBack title="Audit log" />} onRefresh={log.refresh} refreshing={log.refreshing} scroll>
      <View className="gap-4">
        <Input onChangeText={setSearch} placeholder="Search action, person, hostel" value={search} />
        {log.loading ? (
          <SkeletonRows rows={8} />
        ) : log.error ? (
          <ErrorState message={log.error} onRetry={log.reload} />
        ) : rows.length === 0 ? (
          <Quiet icon="search" tone="neutral">
            No entry matches.
          </Quiet>
        ) : (
          <Rows inset={false}>
            {rows.map((row) => (
              <ListRow
                key={row.id}
                right={
                  <Text className="text-xs" variant="muted">
                    {row.createdAt ? dates.ago(row.createdAt) : ""}
                  </Text>
                }
                subtitle={[row.actorLabel, row.hostelLabel ?? row.entityType].filter(Boolean).join(" · ")}
                title={row.action.replace(/[._]/g, " ").toLowerCase()}
              />
            ))}
          </Rows>
        )}
      </View>
    </Screen>
  );
}
