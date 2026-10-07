import { router } from "expo-router";
import { useMemo } from "react";
import { Linking, Pressable, View } from "react-native";

import { KhataHomeCard } from "@/components/khata-home-card";
import { MealRow } from "@/components/meal-row";
import {
  ResidentHomeActions,
  ResidentHomeHeader,
  ResidentServiceGrid,
  ResidentStayHero,
} from "@/components/resident-home";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { useSiteConfig } from "@/hooks/use-site-config";
import { API_BASE_URL } from "@/lib/api";
import { formatDueLabel, humanizeEnum } from "@/lib/format";
import { absoluteMediaUrl } from "@/lib/media";
import { openQuestionCall } from "@/lib/questioncall";
import { markNoticeRead, type ResidentDashboard, type RoutineMeal } from "@/lib/resident-api";
import { duesLine, stayPill } from "@/lib/resident-home";
import { prefetchResidentRoute, residentQuery } from "@/lib/resident-queries";
import { toastError } from "@/lib/toast";

/**
 * The resident's home.
 *
 * ## It is the admin Home now, with a resident's subject
 *
 * The two screens had drifted into two products: the admin's is a painted
 * account card under the platform lockup, with a shortcut row straddling the
 * fold, a card of queues and a grid of doors; this was an app bar with a
 * greeting, a bordered dues card, a strip of three metric tiles, a hostel card
 * with a photo thumbnail and a wrap of chips, and then four sections. Same
 * palette, same components, two different ideas of what a home screen is.
 *
 * It is now the same object. `<PortalHeroCard>` and `ui/action-grid.tsx` are
 * literally the same components both roles draw, so the card's corner radius,
 * the column pitch and the badge rules cannot drift apart again. What differs is
 * the content, which is the whole of the difference between the two roles — see
 * the table in `components/resident-home.tsx`.
 *
 * ## What each of the old objects became
 *
 * | was | is |
 * | --- | --- |
 * | `AppBar` with a greeting | the platform lockup, bell and hostel-page eye |
 * | `DuesCard` — amount, pill, due label, button | the hero, with `Pay now` on the figure |
 * | `StatStrip` — three metric tiles | the hero's figures, and the `Notices` count |
 * | `HostelCard` — photo, address, chips | the hero's ground, its name line, `Call hostel` |
 * | `ComplaintsCard` — a summary of a screen | `Raise issue`, and the More tab's row |
 * | `QuickActions` — Complaints, ID, Review, SOS | the action card and the `Your stay` grid |
 *
 * Nothing was dropped that carried a fact. The complaints *summary* went for the
 * reason the admin Home lost six sections of figures: a home screen whose job is
 * to get you somewhere had become a shorter, worse copy of the screen one tap
 * away. The open count is on the cell that opens it.
 *
 * ## One action card, not two
 *
 * The shortcut row and `Waiting for you` were two identically-built cards
 * separated by a heading and a section gap — the same cell drawn twice, split by
 * whether its destination carries a number. They are one row now: `Digital ID`,
 * `Call hostel`, `Raise issue` and `Notices`.
 *
 * `Invoices`, `Complaints` and `Night status` came off the screen with the
 * heading. Every one of them is still one tap away — Payments is a bottom tab,
 * the hero's pill opens the night roster, and Complaints is a row on More — and
 * a count on the fold has to earn the fold. See `<ResidentHomeActions>`.
 *
 * ## What is still below the fold, and why
 *
 * **Today's food** and **the latest notices**, in that order. Neither is a
 * summary of a screen you can reach in one tap and read properly — a resident
 * checks what is for dinner *here*, without going anywhere, and a notice's first
 * two lines are the whole notice most days. They are the two things this app is
 * opened for that are not money, so they sit between the action row and the
 * grid.
 *
 * ## One request
 *
 * It used to be two. `GET /resident/dashboard` returned `nightStatus` as a
 * hardcoded `{ status: "UNKNOWN", checkedAt: null }` — a value the enum does not
 * even contain — so this screen fetched `/resident/night-status` alongside it.
 * `resident-dashboard.service.ts` reads both properly as of 2026-08-17, so the
 * second request is gone. The absent night status is `NOT_VERIFIED`, which is a
 * real answer, not a missing one.
 *
 * The `Notices` cell counts unread notices and the hero strip unread urgent
 * ones, from the dashboard's per-user `isRead`. Opening a notice on the board
 * marks it read, and refocus refetches, so both clear the moment it is tapped.
 */

export default function ResidentHomeScreen() {
  const dates = useDates();
  const { questionCall } = useSiteConfig().config;

  /*
   * Live, which no resident screen was.
   *
   * Every `(admin)` screen names its topics and this group named none — so the
   * socket was connected app-wide in `_layout.tsx`, publishing to a resident who
   * had subscribed to nothing. A notice posted while the app was open, a claim
   * approved by the office, a warden replying to a complaint: none of it moved
   * this screen until the resident pulled to refresh or left and came back.
   *
   * Five topics because this one payload is five domains — `feeStatus`,
   * `notices`, `complaints`, `foodMenu` and `nightStatus` — and all five are
   * genuinely published to `private-hostel-<id>`, which a resident's principal
   * is granted through its own `hostelIds`.
   *
   * The refetch is silent by `useResource`'s design: the screen does not blank
   * under somebody who is reading it.
   */
  const query = residentQuery.dashboard();
  const home = useResource<ResidentDashboard>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const dashboard = home.data;
  const hostel = dashboard?.hostel ?? null;

  /*
   * The bell and the eye, on the bar in all three states.
   *
   * `/notifications` is scoped to `principal.userId` with no role branch, so a
   * resident has always had a feed — payment reminders, notice broadcasts, the
   * reply to a complaint. Before the bell, nothing in these five tabs opened it:
   * More's "Notifications" row pushed `/settings`, the *preferences* screen, so
   * the feed was reachable by a push banner and by nothing else — and a banner
   * that has been swiped away is gone.
   *
   * Drawn in the loading and error states too, which is what makes a slow first
   * load look like the app arriving rather than a blank screen with a spinner.
   */
  const header = (
    <ResidentHomeHeader
      onHostelPage={
        hostel?.slug ? () => router.push(`/hostel/${hostel.slug}`) : undefined
      }
    />
  );

  /*
    Two fields, not one. `nightStatus.status` says an SOS was *written* — it is a
    single upserted row per resident that nothing ever clears — and `sos` says
    whether the alert is still open and when it was raised. The card flagged a
    settled test alert for weeks on the strength of the first one alone.
  */
  const stay = useMemo(
    () =>
      dashboard
        ? stayPill(dashboard.nightStatus, dashboard.sos)
        : { label: "Not checked in", settled: false },
    [dashboard],
  );

  const duesNote = useMemo(() => {
    if (!dashboard) {
      return "";
    }

    /*
      `nextDue`, not `latestPayment`.

      The date and the month have to describe the invoice the resident should
      act on, which is the **earliest unsettled** one — and `latestPayment` is
      the opposite of that by construction: the invoice due furthest in the
      future, settled ones included. Pairing it with a total summed across every
      unpaid invoice printed "Across 2 unpaid invoices · Due in 27 days" at
      somebody whose older invoice had been overdue for a month.

      It falls back to `latestPayment` only when nothing is unsettled, where
      there is no date to be wrong about and the month is all the line uses.
    */
    const due = dashboard.feeStatus.nextDue ?? dashboard.feeStatus.latestPayment;

    return duesLine({
      dueAmount: dashboard.feeStatus.dueAmount,
      dueLabel: formatDueLabel(due?.dueDate),
      pendingProofs: dashboard.feeStatus.pendingProofs,
      periodLabel: due ? dates.period(due.month) : null,
      unpaidCount: dashboard.feeStatus.unpaidCount,
    });
  }, [dashboard, dates]);

  if (home.loading) {
    return (
      /*
        Skeletons, not a spinner — the house rule this group was not following.
        The shape is known before the data is, and it is the shape the screen
        actually lands in: a painted card, a row of action cells, then sections.
        Drawing it means nothing moves when the figures arrive.
      */
      <Screen header={header} insideTabs padded={false} scroll>
        {/* `px-3.5` is 14 points — `HERO_INSET`, so the card lands where it will. */}
        <View className="px-3.5">
          <Skeleton height={190} radius={18} />
        </View>

        <View className="px-5 pt-3">
          <Skeleton height={96} radius={24} />
        </View>

        <View className="gap-6 px-5 pt-6">
          <SkeletonCard rows={2} />

          <View className="gap-3">
            <Skeleton height={18} width="45%" />
            <Skeleton height={172} radius={24} />
          </View>
        </View>
      </Screen>
    );
  }

  if (home.error || !dashboard) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={home.error ?? "Your dashboard could not be loaded."}
          onRetry={home.reload}
        />
      </Screen>
    );
  }

  const phone = hostel?.contact.phone;
  const unreadNotices = dashboard.notices.filter((notice) => !notice.isRead);
  const urgentNotices = unreadNotices.filter((notice) => notice.isUrgent).length;

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={home.refresh}
      padded={false}
      refreshing={home.refreshing}
      scroll
    >
      <ResidentStayHero
        deposit={dashboard.resident.depositAmount}
        dueAmount={dashboard.feeStatus.dueAmount}
        duesNote={duesNote}
        hostelName={hostel?.name ?? null}
        onNightStatus={() => router.push("/night-status")}
        onNotices={() => router.push("/(resident)/notices")}
        onPay={() => router.push("/(resident)/payments")}
        photoUrl={absoluteMediaUrl(hostel?.photoUrl, API_BASE_URL)}
        /*
          The card's "account number": what a resident is asked at the office, in
          the order they are asked it. Two props rather than one joined string,
          because the card gives each a row of its own — see the note there.

          Residents are placed by room *type*, not by room number, so that is all
          the accommodation detail there is to show.
        */
        roomLabel={humanizeEnum(dashboard.accommodation.roomType)}
        sinceLabel={dates.date(dashboard.resident.moveInDate)}
        stay={stay}
        urgentCount={urgentNotices}
      />

      {/*
        Its own row, not pulled up onto the card's shoulder. The straddle needs a
        full-width painted edge to straddle, and the hero has corners.

        No heading over it. `Waiting for you` used to head a second, identical
        card a section-gap below this one; what survived of it — the urgent
        notice count — is the last cell in this row, and a heading naming one
        cell would have been the seam we removed. See `<ResidentHomeActions>`.
      */}
      <View className="pt-3">
        <ResidentHomeActions
          /*
            Only when the listing carries a number. A cell that dials nothing is
            worse than a missing cell — see `<ResidentHomeActions>`.
          */
          onCall={phone ? () => void Linking.openURL(`tel:${phone}`) : undefined}
          onIdCard={() => router.push("/id-card")}
          onNotices={() => router.push("/(resident)/notices")}
          onRaiseIssue={() => router.push("/complaints/new")}
          /*
            Students only — a working professional has no use for it, and the
            API repeats the check (403 `QUESTIONCALL_NOT_ELIGIBLE`), so hiding
            the tile is presentation rather than the gate. Label and on/off
            are Website Config → Site Content → QuestionCall.
          */
          questionCall={
            questionCall.enabled &&
            (dashboard.resident.residentType ?? "STUDENT") === "STUDENT"
              ? {
                  label: questionCall.label,
                  onPress: () =>
                    void openQuestionCall(questionCall.url).catch(() =>
                      toastError("Could not open QuestionCall"),
                    ),
                }
              : undefined
          }
          unreadNotices={unreadNotices.length}
        />
      </View>

      <View className="gap-6 px-5 pt-6">
        <KhataHomeCard />

        <TodaysMenuCard meals={dashboard.foodMenu} />

        <NoticesCard notices={dashboard.notices} />

        <View>
          <SectionHeader title="Your stay" />

          {/* Touch-down warms the screen the tile opens, where there is one. */}
          <ResidentServiceGrid
            onOpen={(href: string) => router.push(href as never)}
            onPrefetch={prefetchResidentRoute}
          />
        </View>
      </View>
    </Screen>
  );
}

/**
 * Today's meals, in the mockup's arrangement: a soft icon square, the meal, its
 * timing as a badge on the right, and the items underneath.
 *
 * The items get two lines rather than one. A `<ListRow>` subtitle truncates, and
 * "Rice, dal, seasonal vegetable, chicken curry, pickle" is exactly the string
 * that gets cut at the part somebody cares about.
 */
function TodaysMenuCard({ meals }: { meals: RoutineMeal[] }) {
  return (
    <View>
      <SectionHeader
        action={
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.push("/(resident)/food")}
            /*
              Food is a push rather than a tab since Statement took its slot, so
              its read is no longer warmed at the door — this is the tap that
              warms it, on the same `onPressIn` the `Your stay` grid uses.
            */
            onPressIn={() => prefetchResidentRoute("/(resident)/food")}
          >
            <Text className="text-primary" variant="label">
              All meals
            </Text>
          </Pressable>
        }
        subtitle="From this week's routine"
        title="Today's food"
      />

      <Card className="gap-2">
        {meals.length === 0 ? (
          <Text variant="muted">No menu published for today yet.</Text>
        ) : (
          meals.map((meal) => (
            <MealRow
              items={meal.items}
              key={meal.mealType}
              mealType={meal.mealType}
              note={meal.note}
              timing={meal.timing}
            />
          ))
        )}
      </Card>
    </View>
  );
}

/**
 * The web shows two lines of each notice's body under its title, and this screen
 * showed only "Category · 3 days ago" — which for a notice titled "Water supply"
 * leaves out the half that says when the water is off. Ported.
 */
function NoticesCard({ notices }: { notices: ResidentDashboard["notices"] }) {
  const dates = useDates();

  return (
    <View>
      <SectionHeader
        action={
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.push("/(resident)/notices")}
          >
            <Text className="text-primary" variant="label">
              See all
            </Text>
          </Pressable>
        }
        title="Latest notices"
      />

      <Card className="gap-2">
        {notices.length === 0 ? (
          <Text variant="muted">Nothing from your hostel right now.</Text>
        ) : (
          notices.slice(0, 3).map((notice) => (
            <Pressable
              accessibilityRole="button"
              className="gap-1 rounded-xl border border-border px-3 py-2.5 active:opacity-70"
              key={notice.id}
              onPress={() => {
                // Its title and first lines are right here — the tap is the read.
                void markNoticeRead(notice.id).catch(() => undefined);
                router.push("/(resident)/notices");
              }}
            >
              <View className="flex-row items-start justify-between gap-2">
                <Text className="flex-1" numberOfLines={2} variant="label">
                  {notice.title}
                </Text>
                {notice.isUrgent ? <Badge label="Urgent" tone="danger" /> : null}
              </View>

              {notice.content ? (
                <Text numberOfLines={2} variant="muted">
                  {notice.content}
                </Text>
              ) : null}

              <Text variant="caption">
                {`${humanizeEnum(notice.category)} · ${dates.relativeDay(notice.publishedAt)}`}
              </Text>
            </Pressable>
          ))
        )}
      </Card>
    </View>
  );
}
