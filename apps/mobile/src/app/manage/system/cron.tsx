import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { LogRow } from "@/components/platform-system";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Chip, FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { openConfirm } from "@/lib/confirm";
import { type CronJob, type CronRun, listCronJobs, listCronRuns, listLogs, runCronJob, runTone } from "@/lib/platform-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Cron — the web's System › Cron: one row per job (schedule, last run, next run,
 * the *missed* flag, Run now), then the run history from `cronruns`, filterable
 * by job, status and trigger. A run opens its error, counts and its own log
 * lines (the runner logs each run under its run id as the request id).
 */

const STATUSES = ["failed", "timeout", "running", "skipped", "ok"] as const;
const TRIGGERS = ["schedule", "manual", "http"] as const;
type RunFilters = Partial<Record<"job" | "status" | "trigger", string>>;

function RunLines({ runId }: { runId: string }) {
  const load = useCallback(() => listLogs({ requestId: runId }), [runId]);
  const lines = useResource(load, { cacheKey: `platform:cron:lines:${runId}` });

  if (lines.loading) return <SkeletonRows rows={3} />;
  if (lines.error) return <ErrorState message={lines.error} onRetry={lines.reload} />;
  if (!lines.data?.entries.length) return <Text variant="muted">No stored lines for this run.</Text>;

  return (
    <Card padding="px-4 py-1">
      {lines.data.entries.map((entry, index) => (
        <View key={entry.id}>
          {index > 0 ? <RowDivider /> : null}
          <LogRow entry={entry} />
        </View>
      ))}
    </Card>
  );
}

export default function CronScreen() {
  const dates = useDates();
  const [filters, setFilters] = useState<RunFilters>({});
  const [cursor, setCursor] = useState<string[]>([]);
  const [open, setOpen] = useState<CronRun | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const page = cursor[cursor.length - 1];
  const jobs = useResource(listCronJobs, { cacheKey: "platform:cron:jobs" });
  const loadRuns = useCallback(() => listCronRuns(filters, page), [filters, page]);
  const runs = useResource(loadRuns, { cacheKey: `platform:cron:runs:${JSON.stringify(filters)}:${page ?? ""}` });

  const toggle = (name: keyof RunFilters, value: string) => {
    setCursor([]);
    setFilters((current) => {
      const next = { ...current };
      if (current[name] === value) delete next[name];
      else next[name] = value;
      return next;
    });
  };

  const runNow = (job: CronJob) =>
    openConfirm({
      confirmLabel: "Run now",
      message: `Starts ${job.name} on the server now, the same as its schedule would.`,
      onConfirm: async () => {
        setRunning(job.name);
        try {
          await runCronJob(job.name);
          toastSuccess(`${job.name} ran.`);
        } catch (error) {
          toastError(`${job.name} failed`, error instanceof Error ? error.message : undefined);
        } finally {
          setRunning(null);
          jobs.reload();
          runs.reload();
        }
      },
      title: `Run ${job.name}?`,
    });

  const refresh = () => {
    jobs.refresh();
    runs.refresh();
  };

  return (
    <Screen header={<AppBar accent centerTitle showBack title="Cron" />} onRefresh={refresh} refreshing={jobs.refreshing || runs.refreshing} scroll>
      <View className="gap-5 pt-1">
        <View>
          <SectionHeader subtitle="Tap a job to see only its runs" title="Jobs" />
          {jobs.loading ? (
            <SkeletonRows rows={6} />
          ) : jobs.error ? (
            <ErrorState message={jobs.error} onRetry={jobs.reload} />
          ) : (
            <Card padding="px-4 py-1">
              {(jobs.data ?? []).map((job, index) => (
                <View key={job.name}>
                  {index > 0 ? <RowDivider /> : null}
                  <View className="flex-row items-center gap-3 py-3">
                    <Pressable accessibilityRole="button" className="flex-1 gap-1 active:opacity-70" onPress={() => toggle("job", job.name)}>
                      <Text className={`font-mono ${filters.job === job.name ? "text-primary" : ""}`} numberOfLines={1}>
                        {job.name}
                      </Text>
                      <View className="flex-row flex-wrap items-center gap-1.5">
                        {job.missed ? <Badge label="missed" tone="danger" /> : null}
                        <Badge label={job.lastRun ? job.lastRun.status : "never run"} tone={job.lastRun ? runTone(job.lastRun.status) : "neutral"} />
                        <Text className="text-xs" variant="muted">
                          {job.schedule ?? "on demand"}
                        </Text>
                      </View>
                      <Text className="text-xs" variant="muted">
                        {job.lastRun ? dates.dateTime(job.lastRun.startedAt) : "—"}
                        {job.nextRunAt ? ` · next ${dates.dateTime(job.nextRunAt)}` : ""}
                      </Text>
                    </Pressable>
                    {job.schedule ? (
                      <Button disabled={running !== null} label="Run now" loading={running === job.name} onPress={() => runNow(job)} size="sm" variant="outline" />
                    ) : null}
                  </View>
                </View>
              ))}
            </Card>
          )}
        </View>

        <View className="gap-2">
          <SectionHeader title="Runs" />
          <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
            {filters.job ? <Chip icon="close" label={filters.job} onPress={() => toggle("job", filters.job!)} tone="brand" /> : null}
            {STATUSES.map((status) => (
              <Chip key={status} label={status} onPress={() => toggle("status", status)} tone={filters.status === status ? "brand" : "neutral"} />
            ))}
            {TRIGGERS.map((trigger) => (
              <Chip key={trigger} label={trigger} onPress={() => toggle("trigger", trigger)} tone={filters.trigger === trigger ? "brand" : "neutral"} />
            ))}
          </ScrollView>
        </View>

        {runs.loading ? (
          <SkeletonRows rows={6} />
        ) : runs.error ? (
          <ErrorState message={runs.error} onRetry={runs.reload} />
        ) : !runs.data?.runs.length ? (
          <EmptyCard description="Runs appear here as the scheduler or Run now starts them." title="No runs match" />
        ) : (
          <Card padding="px-4 py-1">
            {runs.data.runs.map((row, index) => (
              <View key={row.runId}>
                {index > 0 ? <RowDivider /> : null}
                <Pressable accessibilityRole="button" className="gap-1 py-3 active:opacity-70" onPress={() => setOpen(row)}>
                  <View className="flex-row items-center gap-2">
                    <Badge label={row.status} tone={runTone(row.status)} />
                    <Text className="flex-1 font-mono text-xs" numberOfLines={1}>
                      {row.job}
                    </Text>
                    <Text className="text-xs" variant="muted">
                      {row.trigger}
                    </Text>
                  </View>
                  {row.error ? (
                    <Text className="text-xs text-destructive" numberOfLines={1}>
                      {row.error}
                    </Text>
                  ) : null}
                  <Text className="text-xs" variant="muted">
                    {row.durationMs !== null ? `${row.durationMs} ms · ` : ""}
                    {dates.dateTime(row.startedAt)}
                  </Text>
                </Pressable>
              </View>
            ))}
          </Card>
        )}

        {cursor.length || runs.data?.nextCursor ? (
          <View className="flex-row gap-3">
            {cursor.length ? <Button className="flex-1" label="Newer" onPress={() => setCursor((c) => c.slice(0, -1))} variant="outline" /> : null}
            {runs.data?.nextCursor ? <Button className="flex-1" label="Older" onPress={() => setCursor((c) => [...c, runs.data!.nextCursor!])} variant="outline" /> : null}
          </View>
        ) : null}
      </View>

      <Sheet onClose={() => setOpen(null)} open={open !== null} tall title={open ? open.job : ""}>
        {open ? (
          <View className="gap-4">
            {open.error ? <Text className="text-destructive">{open.error}</Text> : null}
            <View>
              <FactRow label="Status" value={open.status} />
              <FactRow label="Trigger" value={open.trigger} />
              <FactRow label="Started" value={dates.dateTime(open.startedAt)} />
              <FactRow label="Ended" value={open.endedAt ? dates.dateTime(open.endedAt) : "—"} />
              <FactRow label="Duration" value={open.durationMs !== null ? `${open.durationMs} ms` : "—"} />
              <FactRow label="Instance" value={open.instance} />
              <FactRow label="Run id" value={open.runId} />
            </View>
            {open.counts ? (
              <View className="rounded-xl bg-muted p-3">
                <Text className="font-mono text-xs">{JSON.stringify(open.counts, null, 2)}</Text>
              </View>
            ) : null}
            <RunLines runId={open.runId} />
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
