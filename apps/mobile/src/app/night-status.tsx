import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { collapseNightPrompts } from "@/lib/night-status-notification";
import { readApiError } from "@/lib/api-contract";
import {
  NIGHT_STATUS_REASONS,
  type NightStatusReasonCode,
} from "@/lib/night-status-actions";
import {
  NIGHT_STATUS_OPTIONS,
  nightNote,
  nightStanding,
  type SelfReportableStatus,
} from "@/lib/night-status";
import {
  type NightStatus,
  type NightStatusView,
  setResidentNightStatus,
} from "@/lib/resident-api";
import { residentQuery } from "@/lib/resident-queries";
import type { SosAlert } from "@/lib/safety-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Telling the hostel where you are tonight.
 *
 * ## Three choices, not the five the server takes
 *
 * `nightStatusUpdateSchema` validates against the whole enum on the resident
 * route, which means a client *could* set `SOS_TRIGGERED` — and nothing would
 * happen: no alert row, no fan-out, no notification, just the word "SOS" on the
 * warden's roster. `lib/night-status.ts` holds the subset and the reasoning.
 *
 * ## History is its own screen
 *
 * Every change appends a `NightStatusLog`, and `night-status-history.tsx` reads
 * it back night by night. It is linked from "Right now" rather than listed
 * under the form, so answering tonight stays the one thing this screen asks.
 *
 * ## The reason list is what the notification cannot draw
 *
 * Most residents will never see this screen, because the nightly prompt is
 * answered from the shade — and a notification can show buttons and one
 * free-text field, nothing else. No dropdown, no chip row, on either platform.
 * So the shade gets three buttons (`Inside`, `At home`, `Outside…`) and the
 * full preset list lives here, where there is room for it.
 *
 * The chips appear only under "Out for the night". A reason is an explanation
 * for being away; offering one beside "Inside the hostel" would be asking
 * somebody to justify being in their own room.
 *
 * ## Nothing is preselected from a stale answer
 *
 * A night runs 17:00 → 17:00 Nepal time. Last night's status is shown as
 * history-of-record but does not preselect a choice: a preselected stale answer
 * is one tap away from confirming a location nobody has asked about since.
 */

export default function NightStatusScreen() {
  /*
    The endpoint returns the resident's latest `SOSAlert` alongside the status
    row now. The screen needs both: the row says an SOS was written and the alert
    says whether staff have closed it — and the row alone can never say, because
    `writeNightStatus` upserts one per resident and expires nothing.
  */
  const query = residentQuery.nightStatus();
  const resource = useResource<NightStatusView>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar showBack title="Night status" />;

  if (resource.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  if (resource.error || !resource.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={resource.error ?? "Your night status could not be loaded."}
          onRetry={resource.reload}
        />
      </Screen>
    );
  }

  return (
    <NightStatusForm
      header={header}
      /*
        Only the status comes back from the POST — `updateResidentNightStatus`
        returns the row it wrote and nothing about the alert, which is correct:
        answering a night check does not close an SOS. So the alert already on
        screen is carried through untouched.
      */
      onChanged={(status) =>
        resource.setData((view) => (view ? { ...view, status } : { sos: null, status }))
      }
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      sos={resource.data.sos}
      status={resource.data.status}
    />
  );
}

function NightStatusForm({
  header,
  onChanged,
  onRefresh,
  refreshing,
  sos,
  status,
}: {
  header: React.ReactNode;
  onChanged: (status: NightStatus) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** The resident's latest alert, or null if they have never raised one. */
  sos: SosAlert | null;
  status: NightStatus;
}) {
  const dates = useDates();

  const { colors } = useAppTheme();
  const standing = nightStanding(status, new Date(), sos);
  const [choice, setChoice] = useState<SelfReportableStatus | null>(
    standing.suggested,
  );
  const [note, setNote] = useState(status.note);
  /*
   * Only carried over when the row on screen is tonight's. `nightStanding`
   * already refuses to preselect a status from an earlier night, and a reason
   * chip left lit under an unselected status would be the same stale answer one
   * tap from being confirmed.
   */
  const [reasonCode, setReasonCode] = useState<NightStatusReasonCode | null>(
    standing.answered ? (status.reasonCode ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (!choice) {
      return;
    }

    const parsed = nightNote(note);

    if (parsed.error) {
      setError(parsed.error);
      return;
    }

    setError(null);
    setSaving(true);

    try {
      const next = await setResidentNightStatus({
        ...parsed,
        /*
         * A reason belongs to being out. Sending the one they picked before
         * changing their mind to `Inside` would file "at home" against a night
         * they said they were here for.
         */
        reasonCode:
          choice === "OUTSIDE_HOSTEL" ? (reasonCode ?? undefined) : undefined,
        source: "APP",
        status: choice,
      });

      onChanged(next);
      // Answered here, so the prompts waiting in the shade are done with.
      void collapseNightPrompts({ keepLatest: false });
      toastSuccess("Status updated", "Your hostel can see this now.");
    } catch (caught) {
      toastError("Could not update your status", readApiError(caught));
    } finally {
      setSaving(false);
    }
  }, [choice, note, onChanged, reasonCode]);

  return (
    <Screen
      footer={
        <Button
          disabled={!choice}
          label={standing.answered ? "Update my status" : "Tell my hostel"}
          loading={saving}
          onPress={() => void save()}
        />
      }
      header={header}
      onRefresh={onRefresh}
      refreshing={refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <Text variant="label">Right now</Text>
            <StatusPill status={status.status} />
          </View>

          <Text variant="muted">{standing.headline}</Text>

          {status.checkedAt ? (
            <Text variant="caption">
              Last set {dates.dateTime(status.checkedAt)}
              {standing.answered ? "" : " — that was an earlier night"}
            </Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            className="self-start pt-1 active:opacity-70"
            hitSlop={8}
            onPress={() => router.push("/night-status-history")}
          >
            <Text className="text-primary" variant="label">
              See history
            </Text>
          </Pressable>
        </Card>

        {standing.sosNotice ? (
          <Card className="gap-2 border-l-4 border-l-destructive">
            <View className="flex-row items-center gap-2">
              <Ionicons color={colors.destructive} name="warning-outline" size={18} />
              <Text variant="label">An SOS is on your record</Text>
            </View>
            <Text variant="muted">{standing.sosNotice}</Text>
          </Card>
        ) : null}

        <View className="gap-2">
          <Text variant="label">Where are you tonight?</Text>

          {/* Three big tiles — one tap is the whole answer. */}
          <View className="flex-row gap-2">
            {NIGHT_STATUS_OPTIONS.map((option) => {
              const selected = option.value === choice;

              return (
                <Pressable
                  accessibilityLabel={option.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  className="flex-1 items-center gap-2 rounded-2xl border-2 bg-card px-2 py-4 active:opacity-80"
                  key={option.value}
                  onPress={() => setChoice(option.value)}
                  style={{ borderColor: selected ? colors.primary : colors.border }}
                >
                  <View
                    className="h-12 w-12 items-center justify-center rounded-full"
                    style={{ backgroundColor: selected ? colors.primary : colors.muted }}
                  >
                    <Ionicons
                      color={selected ? colors.primaryForeground : colors.mutedForeground}
                      name={option.icon}
                      size={22}
                    />
                  </View>
                  <Text className="text-center" numberOfLines={2} variant="label">
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/*
          The presets, and only under "Out for the night".

          A wrapping row of chips rather than another column of cards: these are
          one word each and secondary to the choice above them, and five more
          full-width rows would bury the note field below the fold. `Card` is
          deliberately not used — a chip is not a card, and
          `components/ui/card.tsx` says so.
        */}
        {choice === "OUTSIDE_HOSTEL" ? (
          <View className="gap-2">
            <Text variant="label">Why? (optional)</Text>

            <View className="flex-row flex-wrap gap-2">
              {NIGHT_STATUS_REASONS.map((reason) => {
                const selected = reason.code === reasonCode;

                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    key={reason.code}
                    /* Tapping the lit chip clears it — a reason is optional. */
                    onPress={() => setReasonCode(selected ? null : reason.code)}
                  >
                    <View
                      className="rounded-full border px-3.5 py-2 active:opacity-80"
                      style={{
                        backgroundColor: selected ? colors.brandSoft : colors.card,
                        borderColor: selected ? colors.primary : colors.border,
                      }}
                    >
                      <Text
                        style={{
                          color: selected ? colors.primary : colors.mutedForeground,
                        }}
                        variant="caption"
                      >
                        {reason.label}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        <Input
          error={error}
          hint="Only staff see this."
          label="Note (optional)"
          maxLength={1000}
          multiline
          onChangeText={setNote}
          placeholder="Back tomorrow morning."
          style={{ height: 88, paddingTop: 12, textAlignVertical: "top" }}
          value={note}
        />
      </View>
    </Screen>
  );
}
