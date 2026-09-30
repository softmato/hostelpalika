import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import {
  type AttendanceAlert,
  type AttendanceZone,
  getResidentAttendanceHistory,
  type HostelAttendance,
  overrideAttendance,
  resolveAttendanceAlert,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Attendance — the web portal's location attendance, on the phone.
 *
 * Where each resident is today by zone (never a coordinate), the open absence
 * alerts, and per resident a 60-day grid with a manual override for the day
 * their phone was off. Tonight's roll call is a different thing and lives on
 * `manage/roll-call`.
 */

const ZONES: readonly { label: string; value: AttendanceZone }[] = [
  { label: "Inside", value: "INSIDE" },
  { label: "Nearby", value: "NEARBY" },
  { label: "Outside", value: "OUTSIDE" },
  { label: "Unknown", value: "UNKNOWN" },
];

const ZONE_TONE = {
  INSIDE: "success",
  NEARBY: "warning",
  OUTSIDE: "danger",
  UNKNOWN: "neutral",
} as const;

type Data = { alerts: AttendanceAlert[]; attendance: HostelAttendance };
type Row = HostelAttendance["today"][number];

export default function ManageAttendanceScreen() {
  const query = adminQuery.attendance();
  const data = useResource<Data>(query.load, { cacheKey: query.key, topics: query.topics });
  const [picked, setPicked] = useState<Row | null>(null);
  const [resolving, setResolving] = useState<AttendanceAlert | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const openAlerts = useMemo(
    () => (data.data?.alerts ?? []).filter((alert) => alert.status === "OPEN"),
    [data.data],
  );

  const resolve = useCallback(async () => {
    if (!resolving) {
      return;
    }

    setBusy(true);

    try {
      await resolveAttendanceAlert(resolving.id, note.trim() || undefined);
      toastSuccess("Alert resolved");
      setResolving(null);
      setNote("");
      await data.refresh();
    } catch (error) {
      toastError("Could not resolve", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [data, note, resolving]);

  const header = <AppBar accent centerTitle showBack title="Attendance" />;

  if (data.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonTiles />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (data.error || !data.data) {
    return (
      <Screen header={header}>
        <ErrorState message={data.error ?? "Attendance could not be loaded."} onRetry={data.reload} />
      </Screen>
    );
  }

  const { summary, today } = data.data.attendance;

  return (
    <Screen header={header} onRefresh={data.refresh} refreshing={data.refreshing} scroll>
      <View className="gap-5 pt-1">
        <View className="flex-row gap-3">
          <StatTile icon="home-outline" label="Inside" tone="success" value={String(summary.INSIDE ?? 0)} />
          <StatTile icon="walk-outline" label="Nearby" tone="warning" value={String(summary.NEARBY ?? 0)} />
          <StatTile icon="navigate-outline" label="Outside" tone="danger" value={String(summary.OUTSIDE ?? 0)} />
        </View>

        {openAlerts.length > 0 ? (
          <View>
            <SectionHeader subtitle="Away several days in a row" title="Absence alerts" />
            <Card padding="px-4 py-1">
              {openAlerts.map((alert, index) => (
                <View key={alert.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon="alert-circle-outline"
                    onPress={() => setResolving(alert)}
                    right={<Badge label="Resolve" tone="warning" />}
                    subtitle={`Away ${alert.consecutiveDays} days in a row`}
                    title={alert.residentName}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader subtitle="Exact locations are never stored" title="Today" />
          {today.length === 0 ? (
            <EmptyCard description="Active residents appear here once they are admitted." title="Nobody to track" />
          ) : (
            <Card padding="px-4 py-1">
              {today.map((row, index) => (
                <View key={row.resident.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    onPress={() => setPicked(row)}
                    right={
                      <Badge
                        label={ZONES.find((zone) => zone.value === row.zone)?.label ?? row.zone}
                        tone={ZONE_TONE[row.zone]}
                      />
                    }
                    subtitle={row.resident.roomType || undefined}
                    title={row.resident.fullName}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>
      </View>

      <ResidentSheet onClose={() => setPicked(null)} onSaved={() => void data.refresh()} row={picked} />

      <Sheet
        footer={<Button label="Resolve" loading={busy} onPress={() => void resolve()} />}
        onClose={() => setResolving(null)}
        open={resolving !== null}
        title={resolving ? `Resolve · ${resolving.residentName}` : "Resolve"}
      >
        <View className="gap-3 pb-2">
          <Input
            label="What happened"
            multiline
            onChangeText={setNote}
            placeholder="Optional — went home for Dashain"
            value={note}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

/** A resident's 60 days as a grid, plus today's override. Days with no reading stay blank. */
function ResidentSheet({
  onClose,
  onSaved,
  row,
}: {
  onClose: () => void;
  onSaved: () => void;
  row: Row | null;
}) {
  const { colors } = useAppTheme();
  const residentId = row?.resident.id ?? "";
  const history = useResource(
    useCallback(
      () => (residentId ? getResidentAttendanceHistory(residentId) : Promise.resolve([])),
      [residentId],
    ),
  );
  const [zone, setZone] = useState<AttendanceZone | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const byDay = useMemo(
    () => new Map((history.data ?? []).map((entry) => [entry.day.slice(0, 10), entry.zone])),
    [history.data],
  );

  const [days] = useState(() => {
    const now = Date.now();

    return Array.from({ length: 60 }, (_, index) =>
      new Date(now - (59 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    );
  });

  const fill: Record<AttendanceZone, string> = {
    INSIDE: colors.success,
    NEARBY: colors.warning,
    OUTSIDE: colors.destructive,
    UNKNOWN: colors.mutedForeground,
  };

  const save = useCallback(async () => {
    if (!row || !zone) {
      return;
    }

    if (reason.trim().length < 3) {
      toastError("Say why", "An override needs a reason.");
      return;
    }

    setSaving(true);

    try {
      await overrideAttendance(row.resident.id, { reason: reason.trim(), zone });
      toastSuccess("Today updated", row.resident.fullName);
      setZone(null);
      setReason("");
      onSaved();
      onClose();
    } catch (error) {
      toastError("Could not update", readApiError(error));
    } finally {
      setSaving(false);
    }
  }, [onClose, onSaved, reason, row, zone]);

  return (
    <Sheet
      footer={
        zone ? <Button label="Set today" loading={saving} onPress={() => void save()} /> : undefined
      }
      onClose={() => {
        setZone(null);
        setReason("");
        onClose();
      }}
      open={row !== null}
      title={row?.resident.fullName ?? "Resident"}
    >
      <View className="gap-4 pb-2">
        <Text variant="label">Last 60 days</Text>
        {history.loading ? (
          <Skeleton height={120} />
        ) : (
          <View className="flex-row flex-wrap gap-1">
            {days.map((day) => {
              const dayZone = byDay.get(day);

              return (
                <View
                  accessibilityLabel={`${day}: ${dayZone ?? "no reading"}`}
                  key={day}
                  style={{
                    backgroundColor: dayZone ? fill[dayZone] : "transparent",
                    borderColor: colors.border,
                    borderRadius: 4,
                    borderWidth: 1,
                    height: 22,
                    opacity: dayZone === "UNKNOWN" ? 0.35 : 1,
                    width: 22,
                  }}
                />
              );
            })}
          </View>
        )}

        <ChoiceChips
          columns={4}
          label="Correct today"
          onToggle={(next) => setZone(next)}
          options={ZONES}
          value={zone}
        />
        {zone ? (
          <Input
            label="Why"
            onChangeText={setReason}
            placeholder="Phone was off, seen at breakfast"
            value={reason}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
