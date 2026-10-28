import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { type AttendanceSettings, updateAttendanceSettings } from "@/lib/admin-manage-api";
import { type AdminSettingsData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";

function toNumber(value: string) {
  const parsed = Number(value.trim());

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Settings → Attendance: the tracking switch, then the geofence and how long
 * its records are kept, edited here and saved together. Was a card of facts
 * plus a sheet inside Settings.
 */
export default function AttendanceSettingsScreen() {
  const query = adminQuery.settings();
  const settings = useResource<AdminSettingsData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const { setData } = settings;
  const attendance = settings.data?.attendance ?? null;

  // Seeded once from the cached answer; a refresh behind it does not wipe edits.
  const [draft, setDraft] = useState<AttendanceSettings | null>(attendance);
  const [saving, setSaving] = useState(false);
  const form = draft ?? attendance;

  const header = <AppBar accent centerTitle showBack title="Attendance" />;

  if (settings.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={5} />
      </Screen>
    );
  }

  if (settings.error || !attendance || !form) {
    return (
      <Screen header={header}>
        <ErrorState
          message={settings.error ?? "Only the hostel owner can change this."}
          onRetry={settings.reload}
        />
      </Screen>
    );
  }

  const edit = (patch: Partial<AttendanceSettings>) => setDraft({ ...form, ...patch });

  async function setTracking(enabled: boolean) {
    edit({ enabled });

    try {
      const next = await updateAttendanceSettings({ enabled });

      setData((current) => (current ? { ...current, attendance: next } : current));
    } catch (error) {
      edit({ enabled: !enabled });
      toastError("Could not change that", readApiError(error));
    }
  }

  async function save() {
    if (!form) return;

    if (form.nearbyZoneRadiusMeters <= form.insideZoneRadiusMeters) {
      toastError("Check the geofence", "Nearby has to be larger than inside.");
      return;
    }

    setSaving(true);

    try {
      const next = await updateAttendanceSettings(form);

      setData((current) => (current ? { ...current, attendance: next } : current));
      toastSuccess("Attendance settings saved");
      router.back();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen
      footer={<Button label="Save" loading={saving} onPress={() => void save()} />}
      header={header}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card padding="px-4 py-1">
          <ListRow
            icon="location"
            right={
              <Toggle
                accessibilityLabel="Attendance tracking enabled"
                onChange={(enabled) => void setTracking(enabled)}
                value={form.enabled}
              />
            }
            subtitle={
              form.enabled
                ? `${form.pingTimes.length} check-in(s) a day`
                : "Residents are not asked to check in"
            }
            title="Tracking"
          />
        </Card>

        <View className="gap-3">
          <Input
            hint="10–500 m. Inside this circle counts as being in the hostel."
            keyboardType="number-pad"
            label="Inside radius (m)"
            onChangeText={(value) => edit({ insideZoneRadiusMeters: toNumber(value) })}
            value={String(form.insideZoneRadiusMeters)}
          />
          <Input
            hint="20–2000 m, larger than the inside radius."
            keyboardType="number-pad"
            label="Nearby radius (m)"
            onChangeText={(value) => edit({ nearbyZoneRadiusMeters: toNumber(value) })}
            value={String(form.nearbyZoneRadiusMeters)}
          />
          <Input
            hint="Up to six, as HH:mm, separated by commas."
            label="Check-in times"
            onChangeText={(value) =>
              edit({
                pingTimes: value
                  .split(",")
                  .map((time) => time.trim())
                  .filter(Boolean)
                  .slice(0, 6),
              })
            }
            placeholder="06:00, 22:00"
            value={form.pingTimes.join(", ")}
          />
          <Input
            hint="1–90 days away before the hostel and the guardian are told."
            keyboardType="number-pad"
            label="Alert after (days)"
            onChangeText={(value) => edit({ absenceAlertDays: toNumber(value) })}
            value={String(form.absenceAlertDays)}
          />
          <Input
            hint="30–1095. Older check-in rows are deleted."
            keyboardType="number-pad"
            label="Keep records for (days)"
            onChangeText={(value) => edit({ retentionDays: toNumber(value) })}
            value={String(form.retentionDays)}
          />
        </View>

        <Text variant="caption">Only the zone is kept — never where the phone was.</Text>
      </View>
    </Screen>
  );
}
