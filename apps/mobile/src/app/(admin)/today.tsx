import { router } from "expo-router";
import { useMemo } from "react";
import { View } from "react-native";

import {
  AlertCard,
  DeniedNotice,
  useAdminAlerts,
  useAlertActions,
} from "@/components/admin-alerts";
import { AdminRollCallCard } from "@/components/admin-rollcall-card";
import { FoodRoutineWeek } from "@/components/food-routine";
import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader, SectionLink } from "@/components/ui/card";
import { CardRow, ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import {
  EmptyCard,
  ErrorState,
  PermissionCard,
} from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { buildAlertFeed } from "@/lib/admin-alerts";
import {
  type AdminTodayData,
  adminQuery,
  prefetchAdminRoute,
} from "@/lib/admin-queries";
import { humanizeEnum } from "@/lib/format";

/**
 * Today — running the hostel, as opposed to owning it.
 *
 * The portal calls this group **Operations**, and until now none of it was in
 * the app: the roll call, the menu, notices and the request queues were eight
 * web links on the More tab. They are the parts of the job that happen while
 * standing up, which makes a phone the right device for them and a browser
 * handoff the wrong one.
 *
 * ## Why the roll call is first
 *
 * It is the only section with a deadline measured in hours, and the only one
 * where the phone beats the desk — a warden walking the corridor marking rooms
 * is not going to open a laptop for it. Complaints sit under it despite being
 * the section with a *badge*, because an SLA runs in days and the tab bar is
 * already carrying that number.
 *
 * ## It reports; it does not write
 *
 * Every section here is now a summary and a link, and that is the rule the
 * screen was missing. It used to hold two working copies of features that have
 * their own screens: the unverified half of the roll call with its own override
 * sheet, and a two-field notice composer missing schedule, expiry and audience.
 * Both were built when the alternative was a browser hand-off, and both outlived
 * that — `manage/roll-call` and `manage/notices` do the whole job.
 *
 * A digest that also writes is the worst of both: it disagrees with the real
 * screen about what is on it, and it offers the same action twice with
 * different options behind each. So the heading of each section links to the
 * one screen that owns it — the same destinations Home's shortcut row and
 * Manage grid use — and nothing on this page is the only way to do anything.
 */
/*
 * `TodayData` and its per-source-tolerant loader moved to
 * `lib/admin-queries.ts`, so the portal's warm-up runs the identical read under
 * the key this screen mounts on.
 */

/*
 * A `NIGHT_TONE` table lived here, colouring the roll call's `StatTile` grid.
 * The grid is now the banner, whose figures are all one tone by design — they
 * sit on paint, where five colours would be five colours competing with the
 * white text rather than five meanings. The tone-per-status mapping still
 * exists, once, as `NIGHT_TONES` behind `nightChips` in `lib/admin-home.ts`,
 * which is what Home's chip strip reads. Two copies of it was one too many.
 */

export default function AdminTodayScreen() {
  const dates = useDates();
  const query = adminQuery.today();
  const today = useResource<AdminTodayData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const alerts = useAdminAlerts();
  const actions = useAlertActions();

  const complaintRows = useMemo(
    () =>
      buildAlertFeed({
        claims: [],
        complaints: alerts.data?.complaints ?? [],
        inquiries: [],
        sos: [],
      }),
    [alerts.data],
  );

  /*
   * The date is the subtitle, and it is the screen's whole framing: Today is a
   * shift, so the bar says which one. Ordinary page chrome rather than paint —
   * the roll-call card below is this screen's one coloured object, and two of
   * them would put the emphasis on the furniture.
   */
  const header = (
    <AppBar
      actions={<NotificationBell />}
      /*
       * Reached by a push from Home's "Needs attention" rows now that Community
       * holds a tab slot — and an explicit destination rather than
       * `router.back()`, because this is still a screen *inside* the tab
       * navigator, whose default `backBehavior` is `firstRoute`, not `history`.
       */
      onBack={() => router.navigate("/(admin)")}
      showBack
      subtitle={dates.date(new Date())}
      title="Today"
    />
  );

  if (today.loading) {
    return (
      <Screen header={header} insideTabs scroll>
        {/* The roll-call card, then the queues. See Money's note on skeletons. */}
        <View className="gap-6 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonRows rows={5} />
        </View>
      </Screen>
    );
  }

  if (today.error || !today.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={today.error ?? "Today could not be loaded."}
          onRetry={today.reload}
        />
      </Screen>
    );
  }

  const { maintenance, night, notices, routine } = today.data;

  return (
    <>
      <Screen
        header={header}
        insideTabs
        onRefresh={() => {
          today.refresh();
          alerts.refresh();
        }}
        refreshing={today.refreshing || alerts.refreshing}
        scroll
      >
        <View className="gap-6 pt-1">
          <View className="gap-3">
            {night ? (
              <>
                <AdminRollCallCard date={dates.date(new Date())} summary={night.summary} />

                {/*
                  The card is the digest; the roster is a screen.

                  The unverified rows used to be listed here, capped at twelve
                  with an expander, and marking somebody opened a sheet on this
                  screen. That was a second, smaller copy of `manage/roll-call`
                  — same write, same override reason, fewer of the people — and
                  the two of them disagreed about who was on screen the moment a
                  hostel passed twelve unmarked residents. One owner now: Today
                  says how far through the night the hostel is, and the row below
                  goes to the roster to do something about it.
                */}
                <Card padding="px-4 py-1">
                  <ListRow
                    icon="moon"
                    onPress={() => router.push("/manage/roll-call")}
                    subtitle={
                      night.summary.NOT_VERIFIED === 0
                        ? "Everybody is accounted for"
                        : `${night.summary.NOT_VERIFIED} still to check`
                    }
                    title="Open the night status board"
                  />
                </Card>
              </>
            ) : (
              <PermissionCard capability="night status" feature="The night status board" />
            )}
          </View>

          <View>
            <SectionHeader
              action={<SectionLink
                  label="All alerts"
                  onPress={() => router.push("/(admin)/alerts")}
                  onPressIn={() => prefetchAdminRoute("/(admin)/alerts")}
                />}
              subtitle="Past their SLA — oldest first"
              title="Complaints needing a reply"
            />

            <DeniedNotice denied={alerts.data?.denied ?? []} />

            {complaintRows.length === 0 ? (
              <EmptyCard
                description="Nothing is past its response time."
                title="Nothing overdue"
              />
            ) : (
              <View className="gap-3">
                {complaintRows.map((row) => (
                  <AlertCard actions={actions} key={row.id} row={row} />
                ))}
              </View>
            )}
          </View>

          {maintenance ? (
            <View>
              <SectionHeader
                /*
                  The subtitle used to read "Assigning a provider is a portal
                  job — see More", which stopped being true when
                  `manage/maintenance` shipped. A stale hand-off line is worse
                  than none: it sends somebody to a browser for something the
                  screen one tap away already does.
                */
                action={
                  <SectionLink
                    label="Manage"
                    onPress={() => router.push("/manage/maintenance")}
                    onPressIn={() => prefetchAdminRoute("/manage/maintenance")}
                  />
                }
                subtitle="Open requests, newest first"
                title="Maintenance"
              />
              {maintenance.summary.open === 0 ? (
                <EmptyCard
                  description="Nothing is pending, contacted or scheduled."
                  title="No open requests"
                />
              ) : (
                <View className="gap-3">
                  {maintenance.requests
                    .filter((request) =>
                      ["CONTACTED", "PENDING", "SCHEDULED"].includes(request.status),
                    )
                    .slice(0, 6)
                    .map((request) => (
                      <CardRow
                        icon="construct"
                        key={request.id}
                        right={
                          <Badge
                            label={humanizeEnum(request.status)}
                            tone={request.priority === "HIGH" ? "warning" : "neutral"}
                          />
                        }
                        subtitle={[
                          humanizeEnum(request.category),
                          request.location,
                          request.createdAt ? dates.relativeDay(request.createdAt) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        title={request.title}
                        /*
                          The icon square carries the priority, so a high one is
                          amber before its badge is read. Everything else stays
                          the default green — a tone per status would be five
                          meanings for colours this app uses for three.
                        */
                        tone={request.priority === "HIGH" ? "warning" : "brand"}
                      />
                    ))}
                </View>
              )}
            </View>
          ) : null}

          <View>
            <SectionHeader
              action={<SectionLink
                  label="Manage"
                  onPress={() => router.push("/manage/food")}
                  onPressIn={() => prefetchAdminRoute("/manage/food")}
                />}
              subtitle="What the kitchen is serving"
              title="Food"
            />
            {/*
              Three outcomes, and the middle one used to be told in the same
              breath as the third: one `<Text variant="muted">` whose sentence
              changed on whether `routine` was null. "Nothing published yet" and
              "not yours to see" are different facts and now look different.
            */}
            {routine && routine.meals.length > 0 ? (
              <FoodRoutineWeek meals={routine.meals} timings={routine.timings} />
            ) : routine ? (
              <EmptyCard
                description="Set the week's routine from Manage, or let the cook publish it."
                title="No menu published"
              />
            ) : (
              <PermissionCard capability="food" feature="The menu" />
            )}
          </View>

          <View>
            <SectionHeader
              action={<SectionLink
                  label="Manage"
                  onPress={() => router.push("/manage/notices")}
                  onPressIn={() => prefetchAdminRoute("/manage/notices")}
                />}
              subtitle="Newest first"
              title="Notices"
            />
            {notices.length === 0 ? (
              <EmptyCard
                description="Nothing has been published to residents yet."
                title="No notices"
              />
            ) : (
              <View className="gap-3">
                {notices.slice(0, 5).map((notice) => (
                  <CardRow
                    icon="megaphone"
                    key={notice.id}
                    right={notice.isUrgent ? <Badge label="Urgent" tone="danger" /> : undefined}
                    subtitle={[
                      humanizeEnum(notice.targetAudience),
                      notice.publishedAt ? dates.relativeDay(notice.publishedAt) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    title={notice.title}
                    tone={notice.isUrgent ? "danger" : "brand"}
                  />
                ))}
              </View>
            )}

            {/*
              No composer here any more.

              This screen carried its own two-field notice sheet — title, body,
              urgent — with a comment explaining that scheduling, expiry and
              audience were "decisions someone makes at a desk". They are not:
              they are on `manage/notices`, on this phone, and what this sheet
              actually did was give the same job a second write path with three
              of its options missing. The link in the heading goes to the screen
              that has all of them, and its floating button opens the composer.
            */}
            <Button
              className="mt-3"
              label="Write a notice"
              onPress={() => router.push("/manage/notices")}
              variant="secondary"
            />
          </View>
        </View>
      </Screen>

      {actions.sheet}
    </>
  );
}
