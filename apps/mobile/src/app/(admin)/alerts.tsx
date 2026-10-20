import { router } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";

import {
  AlertCard,
  DeniedNotice,
  useAdminAlerts,
  useAlertActions,
} from "@/components/admin-alerts";
import { AppBar } from "@/components/ui/app-bar";
import { Card } from "@/components/ui/card";
import { Stagger } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { type AlertKind, buildAlertFeed } from "@/lib/admin-alerts";

/**
 * Everything that needs a decision — an inbox, and shaped like one.
 *
 * ## Why it survived the retab
 *
 * Three of the four sources also live next to their own subject: claims on
 * Money, complaints on Today, SOS on Home. That is the right default — a
 * decision is easier next to the money or the roster it is about than in a feed
 * of four unrelated things.
 *
 * Inquiries are the exception, and came back here. A lead is not a member of the
 * roster, so on Residents it read as a second list stacked above the directory
 * somebody had opened to search; here it is one row in the queue of things
 * waiting, with its call and its follow-up on the card.
 *
 * What it costs is the one question the old inbox answered well: *is there
 * anything at all?* Four tabs cannot answer that without visiting four tabs, so
 * this screen stays, reachable from Home. It is the sweep, not the workflow.
 *
 * ## Filter tabs, not urgency sections
 *
 * The feed was one list ranked by consequence and nothing else, and that is
 * still what `All` shows. What it could not answer is the question people
 * actually arrive with — *what kind of thing is waiting* — and the notification
 * literature is consistent about the fix: an inbox filters by kind and marks
 * urgency **on the row**, rather than splitting into urgency-titled sections
 * that leave you scrolling three headings to find the one payment claim.
 *
 * So: five segments, exactly Material 3's cap for a segmented control, with the
 * count in each label so a tab says whether it is worth pressing before it is
 * pressed. Ranking inside every segment is unchanged, and `showKind` keeps the
 * badge on each card so a filtered view still says what it is looking at.
 *
 * ## Not the notification bell
 *
 * The bell in the other admin bars opens `/notifications`, the platform record
 * of what was *sent* to this account. This is what is still *undecided*, which
 * is a different list: a notification you have read is done with, whereas a
 * payment claim stays here until somebody approves or rejects it. This screen
 * deliberately has no bell — it would be a second inbox icon inside an inbox.
 *
 * ## It reads the group's shared queue
 *
 * No fetch of its own. `AdminAlertsProvider` in the layout holds one copy for
 * every admin screen, so opening this from Home costs nothing and approving
 * something here moves the badge behind it.
 */
type Segment = AlertKind | "all";

export default function AdminAlertsScreen() {
  const alerts = useAdminAlerts();
  const actions = useAlertActions();

  const [segment, setSegment] = useState<Segment>("all");

  const rows = useMemo(() => (alerts.data ? buildAlertFeed(alerts.data) : []), [alerts.data]);
  const claimById = useMemo(
    () => new Map((alerts.data?.claims ?? []).map((claim) => [claim.eventId, claim])),
    [alerts.data],
  );
  /* The lead behind an inquiry row, so its card can ring and answer it here —
     the row itself only carries a name, a phone and a date. */
  const inquiryById = useMemo(
    () => new Map((alerts.data?.inquiries ?? []).map((inquiry) => [inquiry.id, inquiry])),
    [alerts.data],
  );

  const listed = useMemo(
    () => (segment === "all" ? rows : rows.filter((row) => row.kind === segment)),
    [rows, segment],
  );

  /*
   * An explicit destination rather than `router.back()`.
   *
   * This is a screen *inside* the tab navigator, so arriving here switches the
   * navigator's index rather than pushing a card — and a bottom-tab navigator's
   * default `backBehavior` is `firstRoute`, not `history`. Plain back would
   * therefore be right by accident today (Home is the first tab) and wrong the
   * moment the tab order changes, or would escape the group entirely if the
   * navigator declined to handle it.
   */
  const header = (
    <AppBar
      onBack={() => router.navigate("/(admin)")}
      showBack
      subtitle={rows.length === 1 ? "1 thing waiting" : `${rows.length} things waiting`}
      title="Action queue"
    />
  );

  if (alerts.loading) {
    return (
      <Screen header={header} insideTabs>
        <View className="gap-3">
          <Skeleton height={40} radius={20} />
          <SkeletonRows rows={4} />
        </View>
      </Screen>
    );
  }

  if (alerts.error || !alerts.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={alerts.error ?? "Your alerts could not be loaded."}
          onRetry={alerts.reload}
        />
      </Screen>
    );
  }

  return (
    <>
      <Screen
        header={header}
        insideTabs
        onRefresh={alerts.refresh}
        refreshing={alerts.refreshing}
        scroll
      >
        <View className="gap-4 pt-1">
          <DeniedNotice denied={alerts.data.denied} />

          <Segmented
            onChange={setSegment}
            options={[
              { count: rows.length, label: "All", value: "all" },
              { count: alerts.counts.sos, label: "SOS", value: "sos" },
              { count: alerts.counts.claim, label: "Money", value: "claim" },
              { count: alerts.counts.complaint, label: "Late", value: "complaint" },
              { count: alerts.counts.inquiry, label: "Leads", value: "inquiry" },
            ]}
            value={segment}
          />

          {listed.length === 0 ? (
            <Card>
              <EmptyState
                compact
                description={
                  segment === "all"
                    ? "No SOS alerts, payment claims, overdue complaints or new inquiries."
                    : "Nothing of this kind is waiting. Try All above."
                }
                title={segment === "all" ? "Nothing needs you" : "Nothing here"}
              />
            </Card>
          ) : (
            <>
              <Text className="px-1" variant="caption">
                Most urgent first, then longest waiting
              </Text>

              <Stagger className="gap-3">
                {listed.map((row) => (
                  <AlertCard
                    actions={actions}
                    claim={row.kind === "claim" ? claimById.get(row.id) : undefined}
                    inquiry={row.kind === "inquiry" ? inquiryById.get(row.id) : undefined}
                    key={`${row.kind}-${row.id}`}
                    row={row}
                    showKind
                  />
                ))}
              </Stagger>
            </>
          )}
        </View>
      </Screen>

      {actions.sheet}
    </>
  );
}
