import { router } from "expo-router";
import { Linking, View } from "react-native";

import {
  GuardianCallRegister,
  GuardianWardHero,
} from "@/components/guardian-home";
import { MealRow } from "@/components/meal-row";
import { PortalBrandHeader } from "@/components/portal-shared";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { humanizeEnum } from "@/lib/format";
import { canSee, sharesNothing } from "@/lib/guardian";
import type { GuardianDashboard } from "@/lib/guardian-api";
import { guardianQuery } from "@/lib/guardian-queries";

/**
 * A guardian's home: their ward, and only what the resident chose to share.
 *
 * ## It had become a longer copy of the two tabs beside it
 *
 * This screen drew the night status, the outstanding figure, a metric strip,
 * today's meals, the notices, the complaint list **and** a row into Payments.
 * The Safety tab drew night status, complaints and notices; the Payments tab
 * drew the outstanding figure, the dues and the receipts. So a guardian with
 * everything shared read the same four sections three times, and Home — whose
 * job is to say where to go — was the longest scroll in the portal.
 *
 * That is the failure the admin and resident homes were rebuilt to fix, and the
 * fix is the same one: **a home screen keeps what lives nowhere else, and points
 * at the rest.**
 *
 * | | |
 * | --- | --- |
 * | **The hero** | who, where, tonight's word, what is owed — and the office's number in its second register |
 * | **Today's meals** | Food is not a tab in this portal, so this is the one place it exists |
 * | **From the hostel** | the guardian-visible notices, moved off the Safety tab where they never belonged |
 * | **Two doors** | Safety and Payments, subtitled with the fact that would otherwise have been a whole section |
 *
 * The metric strip went with the duplication. `Due` repeated the hero's own
 * figure, `Night` repeated its pill, and `Paid` is a fact about the dues list —
 * it is on the Payments tab, on the card above the rows it sums.
 *
 * ## Sections are absent, not empty
 *
 * The server gates each query by its own permission flag, so an ungranted
 * section arrives as `[]` — the same payload as a section that is genuinely
 * empty. Drawing "no notices yet" at a guardian who was never granted notices
 * states something about the hostel that this app has no basis for. So each
 * block below is behind `canSee(...)`, and a guardian who was granted nothing
 * gets one honest card instead of five empty ones.
 *
 * ## Against `guardian-dashboard-page.tsx` (§5.2)
 *
 * Still not ported, and still deliberate: the web's **"Make a Payment" button**
 * (there is no guardian payment route anywhere in `apps/web`, so it did
 * nothing), and its **"Emergency Status: Normal"** tile on the safety page (the
 * payload has no SOS field, so it printed "Normal" whether or not an alert was
 * live). Telling a parent there is no emergency without having asked is the one
 * thing these screens must never do.
 */
export default function GuardianHomeScreen() {
  const dates = useDates();
  /*
   * One key for the whole portal. All four guardian tabs read this same
   * descriptor, so switching between them paints from cache instead of
   * refetching one payload four times — see `lib/guardian-queries.ts` for what
   * was actually broken here.
   */
  const query = guardianQuery.dashboard();
  const guardian = useResource<GuardianDashboard>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /*
   * Off `guardian.data`, not off `dashboard`, because the header is built before
   * the loading and error branches return — the eye is simply absent until the
   * payload lands rather than appearing on a bar that has already been drawn.
   */
  const hostelSlug = guardian.data?.hostel?.slug ?? "";

  /*
   * The lockup, the hostel's page and the bell — the same front-door bar the
   * admin and resident homes open on, and for the same two reasons.
   *
   * **Branding.** This portal led with `AppBar large title="Home"`, so the one
   * screen a guardian lands on after signing in never said whose product they
   * were in. A parent typing a code off a printed slip has, at that point, no
   * other evidence — the app they were told about and the app they are looking
   * at have to be visibly the same thing.
   *
   * **The bell**, which no guardian screen had. `/notifications` is scoped to
   * `principal.userId` with no role branch, so a guardian has always had a feed
   * and nothing in these five tabs opened it — same fault the resident group had
   * at §2.1, same fix: it rides the header on the tab, plus a row on More.
   *
   * The eye is drawn only when the payload carries a slug, which the server
   * sends only for a live listing — so a guardian whose ward's hostel is still
   * awaiting verification simply does not get the control. `hostel/[slug]` is a
   * public screen and needs no permission flag: a guardian granted nothing at
   * all may still look at the listing any stranger can.
   */
  const header = (
    <PortalBrandHeader
      hostelPageLabel="Open the hostel's page"
      onHostelPage={
        hostelSlug ? () => router.push(`/hostel/${hostelSlug}`) : undefined
      }
    />
  );

  if (guardian.loading) {
    return (
      /* The hero, then the meal card, then the notices — see Home's note in the
         resident portal on why this is a skeleton and not a spinner. */
      <Screen header={header} insideTabs padded={false} scroll>
        {/* `px-3.5` is 14 points — `HERO_INSET`, so the card lands where it will. */}
        <View className="px-3.5">
          <Skeleton height={230} radius={18} />
        </View>

        <View className="gap-6 px-5 pt-6">
          <View className="gap-3">
            <Skeleton height={18} width="42%" />
            <SkeletonCard rows={3} />
          </View>

          <View className="gap-3">
            <Skeleton height={18} width="38%" />
            <SkeletonCard rows={2} />
          </View>
        </View>
      </Screen>
    );
  }

  if (guardian.error || !guardian.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={guardian.error ?? "Your guardian dashboard could not be loaded."}
          onRetry={guardian.reload}
        />
      </Screen>
    );
  }

  const dashboard = guardian.data;
  const wardName = dashboard.resident.fullName;
  const phone = dashboard.hostel?.contact.phone ?? "";
  const safety = canSee(dashboard, "canViewSafety") ? dashboard.safety : null;
  const seesPayments = canSee(dashboard, "canViewPayments");
  const unpaid = dashboard.summary?.unpaidCount ?? 0;

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={guardian.refresh}
      padded={false}
      refreshing={guardian.refreshing}
      scroll
    >
      <GuardianWardHero
        /*
          `null`, not `0`, when fees are not shared — the card drops the whole
          money block rather than showing a parent a zero they would read as
          "nothing is owed". `summary` is null for the same reason on the server.
        */
        dueAmount={seesPayments ? (dashboard.summary?.dueAmount ?? 0) : null}
        footer={
          phone ? (
            <GuardianCallRegister
              hostelName={dashboard.hostel?.name ?? null}
              onCall={() => void Linking.openURL(`tel:${phone}`)}
            />
          ) : undefined
        }
        hostelName={dashboard.hostel?.name ?? null}
        nightLabel={safety ? humanizeEnum(safety.status) : null}
        relation={dashboard.guardian.relation.toLowerCase()}
        roomLabel={humanizeEnum(dashboard.resident.roomType)}
        unpaidCount={unpaid}
        wardImage={dashboard.resident.image}
        wardName={wardName}
      />

      <View className="gap-6 px-5 pt-6">
        {sharesNothing(dashboard) ? (
          <Card className="gap-2">
            <Text variant="subtitle">Nothing is shared yet</Text>
            <Text variant="muted">
              {`${wardName} has not turned on any sharing for this guardian account. You can see that they are a resident here; fees, meals, notices and night status stay private until they choose otherwise.`}
            </Text>
          </Card>
        ) : null}

        {canSee(dashboard, "canViewFood") ? (
          <View>
            <SectionHeader subtitle="What the kitchen is serving" title="Today's meals" />
            <Card className="gap-2">
              {dashboard.food.length === 0 ? (
                <Text variant="muted">
                  The hostel has not published a routine for today.
                </Text>
              ) : (
                /*
                 * The same meal block the resident's own screens use. A parent
                 * and their child looking at today's dinner should be looking at
                 * the same thing — and the items get two lines rather than a
                 * truncated row, which is where the answer actually is.
                 */
                dashboard.food.map((meal) => (
                  <MealRow
                    items={meal.items}
                    key={meal.id}
                    mealType={meal.mealType}
                    timing={meal.timing}
                  />
                ))
              )}
            </Card>
          </View>
        ) : null}

        {canSee(dashboard, "canViewNotices") ? (
          <View>
            {/*
              Moved here off the Safety tab, which drew them under a heading
              about night status and hostel contact. A notice is not a safety
              record — it is the hostel talking to the household, which is what a
              home screen is for.
            */}
            {/*
              Every one of them, with no "See all" and nowhere for one to go.
              A guardian's notice list is what the hostel addressed to guardians
              — a handful, not a feed — and there is no `/guardian/notices`
              screen to link to. A `<SectionLink>` pointing at Safety, which is
              where these used to live, would have been a door onto a section
              that had just moved out from under it.
            */}
            <SectionHeader title="From the hostel" />
            <Card className="gap-2">
              {dashboard.notices.length === 0 ? (
                <Text variant="muted">
                  Notices addressed to guardians appear here.
                </Text>
              ) : (
                dashboard.notices.map((notice) => (
                  <View
                    className="gap-1 rounded-xl border border-border px-3 py-2.5"
                    key={notice.id}
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
                  </View>
                ))
              )}
            </Card>
          </View>
        ) : null}

        {/*
          The two tabs this screen used to reproduce, as doors — the shelf shape
          the whole app now uses for a menu (`<CardRow>`, `NOTES.md` §3). Each
          subtitle carries the one fact that would otherwise have justified a
          section of its own here, which is what makes them worth a tap.

          Only when something is behind them. A door onto a screen that will
          say "not shared with you" is a door that wastes the tap.
        */}
        {safety || seesPayments ? (
          <View>
            <SectionHeader title="Their record" />
            <View className="gap-3">
              {safety ? (
                <CardRow
                  icon="shield-checkmark"
                  onPress={() => router.push("/(guardian)/safety")}
                  // A day, never a time — `asOf` is truncated by the serializer
                  // and deriving a time from it is the surveillance detail
                  // PHASES.md §4.1 rules out showing a guardian.
                  subtitle={
                    safety.asOf
                      ? `Marked ${humanizeEnum(safety.status).toLowerCase()} as of ${safety.asOf}`
                      : "Night status, hostel contact and open complaints"
                  }
                  title="Safety"
                />
              ) : null}

              {seesPayments ? (
                <CardRow
                  icon="card"
                  onPress={() => router.push("/(guardian)/payments")}
                  subtitle={
                    dashboard.payments.length > 0
                      ? `${unpaid > 0 ? `${unpaid} unpaid · ` : ""}latest ${dates.period(dashboard.payments[0]?.month)}`
                      : "Every month the hostel has billed"
                  }
                  title="Fees & receipts"
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
