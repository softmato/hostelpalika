import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Grid, StatTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import {
  type AttendanceDay,
  groupByMonth,
  type ResidentAttendance,
  sourceNote,
  summarize,
  zoneLabel,
  zoneTone,
} from "@/lib/attendance";
import {
  deleteLocationHistory,
  setLocationConsent,
} from "@/lib/attendance-api";
import { openConfirm } from "@/lib/confirm";
import { residentQuery } from "@/lib/resident-queries";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * What the app has recorded about where you were.
 *
 * ## This screen ships before any pinging does
 *
 * Deliberate sequencing, and the reason it is Phase 1 of §3.1 while the
 * geofencing is Phase 2: a resident must be able to **see and delete** what is
 * held about them before the app starts producing more of it. Shipping the
 * collection first and the controls later is the order that makes a privacy
 * feature an afterthought.
 *
 * ## Zones, never coordinates
 *
 * `getResidentAttendance` returns `{ day, source, zone }` and nothing else. The
 * server holds a distance; it does not hold a lat/lng, and neither does this
 * app — see `lib/attendance-api.ts` and `lib/location.ts`, which hold the same
 * line for the same reason.
 *
 * ## Being away is not a warning
 *
 * `docs/DESIGN.md`: *"'Outside Hostel' is a neutral status, not a warning —
 * students leaving the hostel is normal life, not a red flag."* So no row on
 * this screen is red, no figure is framed as a shortfall, and there is
 * deliberately **no percentage** — a location log read as an attendance grade is
 * exactly the surveillance framing the design rules out. `lib/attendance.ts`
 * holds those rules with the tests.
 *
 * ## Two separate decisions, two separate controls
 *
 * *Stop recording* and *delete what was recorded* are not the same thing and are
 * not offered as one. Withdrawing consent leaves the history; erasing the
 * history does not withdraw consent. The server models them separately
 * (`ConsentLog` versus `AttendanceLogModel`), residents ask for them separately,
 * and collapsing them into one switch would mean somebody who wanted to stop
 * being tracked silently destroyed their own record — or the reverse.
 */
export default function AttendanceScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  const query = residentQuery.attendance();
  const attendance = useResource<ResidentAttendance>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [busy, setBusy] = useState(false);

  const header = <AppBar showBack title="Location & attendance" />;

  const toggleConsent = useCallback(
    async (granted: boolean) => {
      setBusy(true);

      try {
        const saved = await setLocationConsent(granted);

        /*
          The switch is the whole answer: the POST confirms the consent it was
          given, and the day list below it is a record of what was already
          recorded — turning recording off does not rewrite it.
        */
        attendance.setData((current) =>
          current ? { ...current, consentGranted: saved.granted } : current,
        );
        toastSuccess(
          granted ? "Location recording is on" : "Location recording is off",
          granted
            ? undefined
            : "Nothing new will be recorded. What is already stored stays until you delete it.",
        );
      } catch (caught) {
        toastError("That did not save", readApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [attendance],
  );

  const erase = useCallback(() => {
    openConfirm({
      confirmLabel: "Delete history",
      destructive: true,
      message: "Every stored day is erased, including your hostel's copy. This cannot be undone.",
      onConfirm: async () => {
        try {
          await deleteLocationHistory();
          toastSuccess("Your location history was deleted.");
          await attendance.refresh();
        } catch (caught) {
          toastError("Could not delete that", readApiError(caught));
        }
      },
      title: "Delete your location history?",
    });
  }, [attendance]);

  if (attendance.loading) {
    return (
      <Screen header={header} scroll>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={1} />
          <SkeletonTiles columns={2} />
          <SkeletonCard rows={5} />
        </View>
      </Screen>
    );
  }

  if (attendance.error || !attendance.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={attendance.error ?? "Your attendance could not be loaded."}
          onRetry={attendance.reload}
        />
      </Screen>
    );
  }

  const { attendance: days, consentGranted } = attendance.data;
  const months = groupByMonth(days);
  const stats = summarize(days);

  return (
    <Screen
      header={header}
      onRefresh={attendance.refresh}
      refreshing={attendance.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card className="gap-3">
          <ListRow
            right={
              <Toggle
                accessibilityLabel="Record my location for attendance"
                disabled={busy}
                onChange={(next) => void toggleConsent(next)}
                value={consentGranted}
              />
            }
            subtitle={consentGranted ? "On" : "Off — nothing new is recorded"}
            title="Record my location"
          />

          {/*
            Said in full, in plain words, on the screen that switches it on —
            not buried in a policy nobody opens. Each line answers a question a
            resident actually asks, in the order they ask it.
          */}
          <View className="gap-2 border-t border-border pt-3">
            {[
              "Only in, nearby or away — never your location",
              "Follows your phone, not you",
              "Being away is fine and never flagged",
            ].map((line) => (
              <View className="flex-row items-center gap-2" key={line}>
                <Ionicons color={colors.success} name="checkmark-circle" size={16} />
                <Text className="flex-1" variant="muted">
                  {line}
                </Text>
              </View>
            ))}
          </View>
        </Card>

        {days.length > 0 ? (
          <Grid gap={10} maxColumns={2} minCellWidth={140}>
            <StatTile
              icon="home-outline"
              label="At the hostel"
              tone="brand"
              trend={`of ${stats.recorded} days recorded`}
              value={String(stats.inside)}
            />
            <StatTile
              icon="calendar-outline"
              label="Days recorded"
              tone="neutral"
              trend="Last 60 days"
              value={String(stats.recorded)}
            />
          </Grid>
        ) : null}

        {months.length === 0 ? (
          <Card>
            <EmptyState
              compact
              description={consentGranted ? "Days appear here as they are recorded." : undefined}
              title="No days recorded"
            />
          </Card>
        ) : (
          months.map((month) => (
            <View key={month.period}>
              {/* Heading outside the card — NOTES §5. */}
              <SectionHeader title={dates.period(month.period)} />
              <Card>
                {month.days.map((entry, index) => (
                  <View key={entry.day}>
                    {index > 0 ? <RowDivider /> : null}
                    <DayRow entry={entry} />
                  </View>
                ))}
              </Card>
            </View>
          ))
        )}

        {days.length > 0 ? (
          <View className="gap-2">
            <Button label="Delete my location history" onPress={erase} variant="danger" />
            <Text className="text-center" variant="caption">
              Turning recording off keeps these days. This erases them.
            </Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function DayRow({ entry }: { entry: AttendanceDay }) {
  const dates = useDates();

  const note = sourceNote(entry.source);
  const tone = zoneTone(entry.zone);

  return (
    <ListRow
      right={
        /*
          `neutral` gets no badge at all rather than a grey one. Being away is
          the ordinary case, and a pill on every second row turns a calm list
          into something that looks like a compliance report.

          `brand` becomes the badge's `success` here, which is a mapping and not
          a change of mind: `<Badge>`'s tones are colour tokens and it has no
          brand green, while `zoneTone`'s vocabulary is about *meaning* — and
          that vocabulary deliberately refuses to call being inside a "success",
          because it would make being out a failure. The adapter lives here, at
          the presentation edge, so the domain rule stays intact and tested.
        */
        tone === "neutral" ? undefined : (
          <Badge
            label={zoneLabel(entry.zone)}
            tone={tone === "brand" ? "success" : "warning"}
          />
        )
      }
      subtitle={note ?? undefined}
      title={dates.dateLong(entry.day)}
      value={tone === "neutral" ? zoneLabel(entry.zone) : undefined}
    />
  );
}
