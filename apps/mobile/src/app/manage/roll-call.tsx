import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { AdminRollCallCard } from "@/components/admin-rollcall-card";
import { NightStatusPromptCard } from "@/components/night-status-prompt-card";
import { AppBar } from "@/components/ui/app-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { CardRow, ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState, PermissionCard } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { type AdminNightStatusRow, overrideNightStatus } from "@/lib/admin-api";
import {
  type AdminRollCallData,
  adminQuery,
  MAX_ROLL_CALL_PAGES,
} from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import {
  type AttendanceSettings,
} from "@/lib/admin-manage-api";
import { humanizeEnum } from "@/lib/format";
import {
  filterRollCall,
  OVERRIDE_OPTIONS,
  ROLL_CALL_SEGMENTS,
  rollCallCounts,
  rollCallTone,
  type RollCallSegment,
} from "@/lib/roll-call";
import { toastError, toastSuccess } from "@/lib/toast";
import { askingEndsAt } from "@hostel/night/night-window";

/**
 * Tonight's roll call, in full — and the screen that now owns it.
 *
 * ## Why this exists, when Today already had a roll call
 *
 * It did not, quite. `(admin)/today.tsx` showed the summary card and then the
 * **unverified** rows, capped at twelve with a "show more" underneath, and that
 * is a digest of a roster rather than the roster. A warden who wanted to check
 * *who* is marked outside tonight, or to undo a status recorded in error, or to
 * find one person among forty by name, could do none of it — the only rows on
 * screen were the ones nobody had touched yet.
 *
 * So the roll call moved here whole, the way `manage/notices` owns notices and
 * `manage/food` owns the menu. Today keeps the summary card and links into
 * this; it does not keep a second copy of the list, because two screens that
 * both write night status is exactly the duplication the tab bar's own note
 * warns about.
 *
 * ## Five segments, and `To check` is the one you land on
 *
 * The roster is mostly settled by midnight and entirely settled by morning, so
 * `All` as the default view would be a screen that is correct and useless. The
 * segment order and the reasoning behind dropping SOS from it live in
 * `lib/roll-call.ts`, with the tests.
 *
 * ## Every page, fetched up front
 *
 * `listAdminNightStatus` builds the whole roster before it pages, so the
 * summary is true at any page size — but `statuses` is not, and a roster screen
 * that stops at a hundred people is worse than one that admits it cannot show
 * them. This is bounded by residents-per-hostel, which the service's own note
 * puts in the hundreds, so it is two requests in the worst realistic case.
 */
/*
 * `RollCallData`, the page-walk and the 403 rule moved to
 * `lib/admin-queries.ts` as `adminQuery.rollCall()`. The portal warms it on
 * entry, because this screen is one tap from Home in two places — the Manage
 * grid and Today — and walking ten pages of roster is the slowest read in the
 * portal.
 */

export default function ManageRollCallScreen() {
  const dates = useDates();
  const rollQuery = adminQuery.rollCall();
  const roll = useResource<AdminRollCallData>(rollQuery.load, {
    cacheKey: rollQuery.key,
    topics: rollQuery.topics,
  });

  /*
   * The prompt's hour, read beside the roster so "Edit time" sits where a
   * warden notices nobody has answered yet. A failed read (a staff role
   * without settings access) hides the row rather than the board.
   */
  const promptQuery = adminQuery.attendanceSettings();
  const promptSettings = useResource<AttendanceSettings>(promptQuery.load, {
    cacheKey: promptQuery.key,
    topics: promptQuery.topics,
  });
  const [editingTime, setEditingTime] = useState(false);

  const [segment, setSegment] = useState<RollCallSegment>("unverified");
  const [query, setQuery] = useState("");

  /** The resident whose night status is being overridden. */
  const [marking, setMarking] = useState<AdminNightStatusRow | null>(null);
  const [markStatus, setMarkStatus] = useState<string>("INSIDE_HOSTEL");
  const [markReason, setMarkReason] = useState("");
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => roll.data?.night?.statuses ?? [], [roll.data]);
  const counts = useMemo(() => rollCallCounts(rows), [rows]);
  const visible = useMemo(() => filterRollCall(rows, { query, segment }), [query, rows, segment]);
  const accounted = counts.all - counts.unverified;

  const { refresh: refreshRoll } = roll;

  const submitMark = useCallback(async () => {
    if (!marking) {
      return;
    }

    const reason = markReason.trim();

    // The server's own bound. Checked here so the sheet does not close on a
    // round trip that was always going to 422.
    if (reason.length < 3) {
      toastError(
        "Say why",
        "This writes over what the resident said about themselves, so it is recorded with a reason.",
      );
      return;
    }

    setSaving(true);

    try {
      await overrideNightStatus(marking.resident.id, { reason, status: markStatus });
      toastSuccess(`${marking.resident.fullName} marked ${humanizeEnum(markStatus)}`);
      setMarking(null);
      setMarkReason("");
      refreshRoll();
    } catch (caught) {
      toastError("That didn't go through", readApiError(caught));
    } finally {
      setSaving(false);
    }
  }, [markReason, markStatus, marking, refreshRoll]);

  const open = useCallback((row: AdminNightStatusRow) => {
    /*
     * Opens on `INSIDE_HOSTEL` rather than on what the row already says. The
     * overwhelming majority of these taps are a warden confirming somebody is
     * in the building, and pre-selecting the current value would mean the
     * common case is a select that has to be changed before it can be saved.
     */
    setMarkStatus("INSIDE_HOSTEL");
    setMarkReason("");
    setMarking(row);
  }, []);

  const header = (
    <AppBar
      accent
      centerTitle
      showBack
      subtitle={dates.dateLong(new Date())}
      title="Night status"
    />
  );

  if (roll.loading) {
    return (
      <Screen header={header}>
        {/* The banner, then the roster. Skeletons, not a spinner — see DESIGN.md. */}
        <View className="gap-4 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonRows rows={7} />
        </View>
      </Screen>
    );
  }

  if (roll.error || !roll.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={roll.error ?? "The night status board could not be loaded."}
          onRetry={roll.reload}
        />
      </Screen>
    );
  }

  const { night } = roll.data;

  if (!night) {
    return (
      <Screen header={header}>
        <PermissionCard capability="night status" feature="The night status board" />
      </Screen>
    );
  }

  return (
    <>
      <Screen header={header} onRefresh={roll.refresh} refreshing={roll.refreshing} scroll>
        <View className="gap-4 pt-1">
          <AdminRollCallCard date={dates.dateLong(new Date())} summary={night.summary} />

          {counts.all > 0 ? (
            <Card>
              <Meter
                label={`${accounted} of ${counts.all} accounted for tonight`}
                percent={Math.round((accounted / counts.all) * 100)}
              />
            </Card>
          ) : null}

          {promptSettings.data ? (
            <CardRow
              icon="time-outline"
              onPress={() => setEditingTime(true)}
              right={
                <Text className="text-primary" variant="label">
                  Edit time
                </Text>
              }
              subtitle={
                promptSettings.data.nightStatus.promptEnabled
                  ? `Again every ${promptSettings.data.nightStatus.repeatEveryMinutes} min until ${
                      askingEndsAt(promptSettings.data.nightStatus.promptTime) ?? "01:00"
                    }`
                  : "Residents are not being notified"
              }
              title={
                promptSettings.data.nightStatus.promptEnabled
                  ? `Asked at ${promptSettings.data.nightStatus.promptTime}`
                  : "Night prompt is off"
              }
            />
          ) : null}

          <Segmented
            onChange={setSegment}
            options={ROLL_CALL_SEGMENTS.map((entry) => ({
              count: counts[entry.value],
              label: entry.label,
              value: entry.value,
            }))}
            value={segment}
          />

          {/*
            Below the segments, not in the bar. `AdminSearchBar` puts the field
            in the chrome for the Residents *tab*, where there is no back button
            competing for the same row — this screen is pushed, so the bar is
            already carrying a back arrow and a date.
          */}
          <Input
            onChangeText={setQuery}
            placeholder="Search by name or room type"
            value={query}
          />

          {visible.length === 0 ? (
            <EmptyCard
              description={
                query
                  ? "No one on this list matches that."
                  : segment === "unverified"
                    ? "Everybody has been accounted for tonight."
                    : "Nobody is in this state right now."
              }
              title={query ? "No match" : segment === "unverified" ? "All in" : "Nothing here"}
            />
          ) : (
            <Card padding="px-4 py-1">
              {visible.map((row, index) => (
                <View key={row.resident.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    left={
                      <PersonAvatar
                        image={row.resident.image}
                        name={row.resident.fullName}
                        size="sm"
                      />
                    }
                    onPress={() => open(row)}
                    right={
                      <Badge
                        label={humanizeEnum(row.status.status)}
                        tone={rollCallTone(row.status.status)}
                      />
                    }
                    subtitle={[
                      row.resident.roomType ? humanizeEnum(row.resident.roomType) : null,
                      row.status.checkedAt ? dates.dateTime(row.status.checkedAt) : "Not marked",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    title={row.resident.fullName || "Unnamed resident"}
                  />
                </View>
              ))}
            </Card>
          )}

          {night.pagination.totalPages > MAX_ROLL_CALL_PAGES ? (
            <Text variant="caption">
              {`Showing the first ${MAX_ROLL_CALL_PAGES * night.pagination.pageSize} of ${night.pagination.total}. The rest are on the portal.`}
            </Text>
          ) : null}
        </View>
      </Screen>

      <Sheet
        onClose={() => setEditingTime(false)}
        open={editingTime}
        title="Night status prompt"
      >
        {promptSettings.data ? (
          <NightStatusPromptCard
            onSaved={() => void promptSettings.refresh()}
            settings={promptSettings.data.nightStatus}
          />
        ) : null}
      </Sheet>

      <Sheet
        footer={<Button label="Save status" loading={saving} onPress={() => void submitMark()} />}
        onClose={() => setMarking(null)}
        open={Boolean(marking)}
        title={marking ? marking.resident.fullName : "Mark night status"}
      >
        <View className="gap-3 pb-2">
          {/* Tap a state — the four are the whole choice, so no dropdown. */}
          <View className="flex-row flex-wrap gap-2">
            {OVERRIDE_OPTIONS.map((option) => (
              <Chip
                key={option.value}
                label={option.label}
                onPress={() => setMarkStatus(option.value)}
                tone={markStatus === option.value ? "brand" : "neutral"}
              />
            ))}
          </View>

          <View className="flex-row flex-wrap gap-2">
            {["Seen in their room", "Called them", "Told us earlier"].map((quick) => (
              <Chip key={quick} label={quick} onPress={() => setMarkReason(quick)} />
            ))}
          </View>

          <Input
            label="Reason"
            maxLength={1000}
            onChangeText={setMarkReason}
            placeholder="Seen in room 204 at 10pm"
            value={markReason}
          />
          <Text variant="caption">Saved with your name.</Text>
        </View>
      </Sheet>
    </>
  );
}

