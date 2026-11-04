import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { HealthStrip, LogRow } from "@/components/platform-system";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import {
  getLogLevels,
  getLogSummary,
  type LogEntry,
  type LogFilters,
  LOG_LEVELS,
  listLogs,
  setLogLevels,
} from "@/lib/platform-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Logs — the web's System › Logs (`platform-system-page.tsx`) on the phone: the
 * health strip, level and category chips with counts, filters, a row opening the
 * full entry with *Whole request*, and the stored level per category.
 */

const TEXT_FILTERS = [
  { key: "q", label: "Text" },
  { key: "route", label: "Route" },
  { key: "requestId", label: "Request id" },
  { key: "userId", label: "User id" },
  { key: "hostelId", label: "Hostel id" },
] as const;

export default function LogsScreen() {
  const [filters, setFilters] = useState<LogFilters>({});
  const [cursor, setCursor] = useState<string[]>([]);
  const [open, setOpen] = useState<LogEntry | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [draft, setDraft] = useState<LogFilters>({});
  const [levelFor, setLevelFor] = useState<string | null>(null);
  const page = cursor[cursor.length - 1];
  const key = `platform:logs:${JSON.stringify(filters)}:${page ?? ""}`;
  const load = useCallback(() => listLogs(filters, page), [filters, page]);
  const logs = useResource(load, { cacheKey: key });
  const summary = useResource(getLogSummary, { cacheKey: "platform:logs:summary" });
  const levels = useResource(getLogLevels, { cacheKey: "platform:logs:levels" });
  const [saving, setSaving] = useState(false);

  const toggle = (name: "category" | "level", value: string) => {
    setCursor([]);
    setFilters((current) => {
      const next = { ...current };
      if (current[name] === value) delete next[name];
      else next[name] = value;
      return next;
    });
  };
  const countOf = (pick: (row: { category: string; level: string }) => boolean) =>
    summary.data?.counts.filter(pick).reduce((sum, row) => sum + row.count, 0) ?? 0;
  const activeText = TEXT_FILTERS.filter(({ key: name }) => filters[name]);

  const saveLevel = async (category: string, level: string) => {
    setSaving(true);
    try {
      await setLogLevels({ ...(levels.data ?? {}), [category]: level });
      toastSuccess(`${category} now logs at ${level}.`);
      setLevelFor(null);
      levels.reload();
    } catch (error) {
      toastError("Could not change the level", error instanceof Error ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const refresh = () => {
    logs.refresh();
    summary.refresh();
  };

  return (
    <Screen header={<AppBar accent centerTitle showBack title="Logs" />} onRefresh={refresh} refreshing={logs.refreshing} scroll>
      <View className="gap-5 pt-1">
        <HealthStrip />

        <View className="gap-2">
          <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
            {LOG_LEVELS.map((level) => (
              <Chip
                key={level}
                label={summary.data ? `${level} ${countOf((row) => row.level === level)}` : level}
                onPress={() => toggle("level", level)}
                tone={filters.level === level ? "brand" : "neutral"}
              />
            ))}
            <Chip icon="filter" label={activeText.length ? `Filters ${activeText.length}` : "Filters"} onPress={() => { setDraft(filters); setFiltering(true); }} tone={activeText.length ? "brand" : "neutral"} />
          </ScrollView>
          <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
            {(summary.data?.categories ?? []).map((category) => (
              <Chip
                key={category}
                label={`${category} ${countOf((row) => row.category === category)}`}
                onPress={() => toggle("category", category)}
                tone={filters.category === category ? "brand" : "neutral"}
              />
            ))}
          </ScrollView>
          {filters.requestId ? (
            <Chip icon="close" label={`Request ${filters.requestId.slice(0, 12)}`} onPress={() => { setCursor([]); setFilters(({ requestId: _drop, ...rest }) => rest); }} tone="brand" />
          ) : null}
        </View>

        {logs.loading ? (
          <SkeletonRows rows={8} />
        ) : logs.error ? (
          <ErrorState message={logs.error} onRetry={logs.reload} />
        ) : !logs.data?.entries.length ? (
          <EmptyCard description="Change or clear a filter to see more." title="No log lines match" />
        ) : (
          <Card padding="px-4 py-1">
            {logs.data.entries.map((entry, index) => (
              <View key={entry.id}>
                {index > 0 ? <RowDivider /> : null}
                <LogRow entry={entry} onPress={() => setOpen(entry)} />
              </View>
            ))}
          </Card>
        )}

        {cursor.length || logs.data?.nextCursor ? (
          <View className="flex-row gap-3">
            {cursor.length ? <Button className="flex-1" label="Newer" onPress={() => setCursor((c) => c.slice(0, -1))} variant="outline" /> : null}
            {logs.data?.nextCursor ? <Button className="flex-1" label="Older" onPress={() => setCursor((c) => [...c, logs.data!.nextCursor!])} variant="outline" /> : null}
          </View>
        ) : null}

        {summary.data?.dropped ? (
          <Text variant="muted">{summary.data.dropped} lines dropped by the store since start.</Text>
        ) : null}

        {summary.data && levels.data ? (
          <View>
            <SectionHeader subtitle="Lines below this level are not stored" title="Level per category" />
            <Card padding="px-4 py-1">
              {summary.data.categories.map((category, index) => (
                <View key={category}>
                  {index > 0 ? <RowDivider /> : null}
                  <Pressable accessibilityRole="button" className="flex-row items-center justify-between py-3 active:opacity-70" onPress={() => setLevelFor(category)}>
                    <Text className="font-mono">{category}</Text>
                    <Text variant="muted">{levels.data?.[category] ?? "default"}</Text>
                  </Pressable>
                </View>
              ))}
            </Card>
          </View>
        ) : null}
      </View>

      <Sheet onClose={() => setOpen(null)} open={open !== null} title={open ? `${open.level} · ${open.category}` : ""}>
        {open ? (
          <View className="gap-3">
            <Text>{open.message}</Text>
            <View>
              {[
                ["Time", open.at],
                ["Request id", open.requestId],
                ["Route", open.method && open.route ? `${open.method} ${open.route}` : open.route],
                ["Status", open.status],
                ["Duration", open.durationMs !== undefined ? `${open.durationMs} ms` : undefined],
                ["User", open.userId],
                ["Hostel", open.hostelId],
              ]
                .filter(([, value]) => value !== undefined && value !== "")
                .map(([label, value]) => (
                  <FactRow key={String(label)} label={String(label)} value={String(value)} />
                ))}
            </View>
            {open.attrs && Object.keys(open.attrs).length ? (
              <View className="rounded-xl bg-muted p-3">
                <Text className="font-mono text-xs">{JSON.stringify(open.attrs, null, 2)}</Text>
              </View>
            ) : null}
            {open.requestId ? (
              <Button
                icon="layers"
                label="Whole request"
                onPress={() => {
                  setCursor([]);
                  setFilters({ requestId: open.requestId });
                  setOpen(null);
                }}
                variant="outline"
              />
            ) : null}
          </View>
        ) : null}
      </Sheet>

      <Sheet
        footer={
          <Button
            label="Apply"
            onPress={() => {
              setCursor([]);
              setFilters((current) => {
                const next: LogFilters = { ...(current.level ? { level: current.level } : {}), ...(current.category ? { category: current.category } : {}) };
                for (const { key: name } of TEXT_FILTERS) {
                  const value = draft[name]?.trim();
                  if (value) next[name] = value;
                }
                return next;
              });
              setFiltering(false);
            }}
          />
        }
        onClose={() => setFiltering(false)}
        open={filtering}
        title="Filter logs"
      >
        <View className="gap-3">
          {TEXT_FILTERS.map(({ key: name, label }) => (
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              key={name}
              label={label}
              onChangeText={(value: string) => setDraft((current) => ({ ...current, [name]: value }))}
              value={draft[name] ?? ""}
            />
          ))}
        </View>
      </Sheet>

      <Sheet fitContent onClose={() => setLevelFor(null)} open={levelFor !== null} title={levelFor ? `Store ${levelFor} from` : ""}>
        {levelFor
          ? ["default", ...LOG_LEVELS].map((level) => (
              <SheetRow
                disabled={saving}
                key={level}
                label={level}
                onPress={() => void saveLevel(levelFor, level)}
                selected={(levels.data?.[levelFor] ?? "default") === level}
              />
            ))
          : null}
      </Sheet>
    </Screen>
  );
}
