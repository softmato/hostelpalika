import { View } from "react-native";

import { LogRow } from "@/components/platform-system";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { FactRow, Grid, StatTile } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { getProcess, megabytes, uptime } from "@/lib/platform-api";

/**
 * Process — the web's System › Process: the API process that answered, read from
 * its runtime (uptime, version, goroutines, memory, GC, Mongo), then the stored
 * boot, jobs, database, redis and panic lines.
 */
export default function ProcessScreen() {
  const dates = useDates();
  const process = useResource(getProcess, { cacheKey: "platform:process" });
  const data = process.data;

  return (
    <Screen header={<AppBar accent centerTitle showBack title="Process" />} onRefresh={process.refresh} refreshing={process.refreshing} scroll>
      <View className="gap-5 pt-1">
        {process.loading ? (
          <>
            <SkeletonTiles columns={2} />
            <SkeletonCard rows={6} />
          </>
        ) : process.error || !data ? (
          <ErrorState message={process.error ?? "Could not read the process."} onRetry={process.reload} />
        ) : (
          <>
            <Grid maxColumns={2}>
              {[
                <StatTile icon="time" key="up" label="Up" trend={dates.dateTime(data.instance.startedAt)} value={uptime(data.instance.uptimeSeconds)} />,
                <StatTile icon="pulse" key="go" label="Goroutines" value={String(data.runtime.goroutines)} />,
                <StatTile icon="hardware-chip" key="heap" label="Heap" trend={`${megabytes(data.runtime.sysBytes)} from the OS`} value={megabytes(data.runtime.heapAllocBytes)} />,
                <StatTile
                  icon="server"
                  key="mongo"
                  label="Mongo"
                  tone={data.mongo.ok ? "success" : "danger"}
                  trend={`${data.mongo.poolInUse ?? 0} in use`}
                  value={data.mongo.ok ? `${data.mongo.pingMs.toFixed(1)} ms` : "down"}
                />,
              ]}
            </Grid>

            <View>
              <SectionHeader title="Instance" />
              <Card>
                <FactRow label="Host" value={data.instance.hostname} />
                <FactRow label="PID" value={String(data.instance.pid)} />
                <FactRow label="Go" value={data.instance.goVersion} />
                <FactRow label="Commit" value={data.instance.commit ? data.instance.commit.slice(0, 12) : "—"} />
                <FactRow label="CPUs" value={`${data.instance.goMaxProcs} of ${data.instance.numCPU}`} />
                <FactRow label="GC runs" value={String(data.runtime.numGC)} />
                <FactRow label="Last GC pause" value={`${data.runtime.lastPauseMs.toFixed(2)} ms`} />
                <FactRow label="GC pause total" value={`${data.runtime.pauseTotalMs.toFixed(0)} ms`} />
              </Card>
            </View>

            <View>
              <SectionHeader title="Boot, jobs, database, redis, panics" />
              {data.recent.length === 0 ? (
                <EmptyCard description="Boot and job lines are stored as the server writes them." title="Nothing stored yet" />
              ) : (
                <Card padding="px-4 py-1">
                  {data.recent.map((entry, index) => (
                    <View key={entry.id}>
                      {index > 0 ? <RowDivider /> : null}
                      <LogRow entry={entry} />
                    </View>
                  ))}
                </Card>
              )}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}
