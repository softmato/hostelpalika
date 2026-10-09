import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { CookShiftCard } from "@/components/cook-shift-card";
import { mealIcon } from "@/components/meal-row";
import { PortalBrandHeader } from "@/components/portal-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useMinuteTick } from "@/hooks/use-minute-tick";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { announceFoodReady, type CookToday } from "@/lib/cook-api";
import { cookQuery, recordCookAnnouncement } from "@/lib/cook-queries";
import { khataQuery } from "@/lib/khata-api";
import {
  announcedCount,
  announcementSummary,
  mealButtonLabel,
  mealButtons,
  mealLockNote,
  mealSubtitle,
  nextUnannounced,
} from "@/lib/cook";
import { collectDeviceInfo } from "@/lib/device-info";
import { formatTime, humanizeEnum } from "@/lib/format";
import type { MealType } from "@/lib/food-week";
import { toastError, toastInfo, toastSuccess } from "@/lib/toast";

/**
 * The kitchen's screen: four big buttons, and the two facts that decide what to
 * cook.
 *
 * ## The buttons are the screen
 *
 * A cook uses this with wet hands, in a hurry, probably one-handed. So each
 * meal is a full-width card with a full-width button rather than a row with a
 * trailing action, and all four are always present — a hostel serving an
 * unplanned snack still needs to call it, and a routine cell an admin left
 * blank must not remove the ability to announce.
 *
 * ## What leads it, and why that changed
 *
 * A plain bordered box holding `Cooking for` / `42` / a sentence, under a
 * 16-point bar. Beside the other three portals — all of which open on paint —
 * this was the one that looked like a different app, and it is the one used by
 * somebody reading at arm's length across a worktop.
 *
 * It is `<CookShiftCard>` now: the head count as the figure, `N of 4` on the
 * shoulder, and a two-up of what has been called against what is next. The
 * sentence it replaced said the same two things in prose, in the second-most
 * valuable band on a screen whose point is the buttons below it.
 *
 * The card's shape is the **inset** one (`AdminMoneyCard`'s), not the
 * full-bleed hero's, and that is deliberate — see its own note. This screen is a
 * worktop, not a front door.
 *
 * ## Success is `notifiedCount`, not `201`
 *
 * `announceFoodReady` returns 201 as soon as the log row is written, whether or
 * not a single resident had an account to notify. Reporting "residents
 * notified" off the status code would tell a cook the hostel had been called to
 * dinner when nobody was told, so the toast reads the count and says so plainly
 * when it is zero. `announcementSummary` owns that sentence, because there are
 * two audiences now and each of them can be empty.
 *
 * ## The office hears it too
 *
 * The same announcement writes a second, differently worded notification to the
 * hostel's owner, admins and wardens — the time, the reach and the handset it
 * came from (`food-ready-notify.ts`). A cook does not have to do anything about
 * that, but they are told it happened: a kitchen that knows the warden got the
 * same ping is a kitchen that stops walking to the office to check the app
 * worked.
 *
 * ## A meal cannot be called outside its own hours
 *
 * Each button unlocks half an hour before that meal's serving time and shuts an
 * hour after it ends. Four cards that differ only by a heading, used one-handed
 * in a hurry, is the shape that gets dinner's menu pushed to every resident at
 * seven in the morning — and the cooldown then stands in the way of the
 * correction.
 *
 * The window closing is what lets the screen say `Not announced in time`, which
 * is the one fact an office cannot otherwise get off this portal: a meal that
 * went out without the building being told. A button left live all evening
 * records nothing.
 *
 * The rule is `@hostel/food/meal-window`, the same file `announceFoodReady`
 * refuses on, so the button and the API cannot drift apart. It reads the
 * hostel's weekly `timings`, not the day row's — a meal with nothing planned
 * today has an empty `timing`, and gating on that left every such button live
 * over an API that refuses it. A routine with no readable clock is no gate.
 *
 * The kitchen is also *told* when a button goes live — `meal-call-reminder`
 * pushes "Lunch is due" to the hostel's cooks — so this screen does not have to
 * be watched.
 *
 * ## The cooldown belongs to the server
 *
 * `foodReadyCooldownMinutes` caps repeat announcements and returns 429 with the
 * wait in minutes. The button therefore says "Announce again" rather than
 * disabling itself: a cook re-calling a late sitting must be able to try, and a
 * client-side copy of that rule would drift the moment an admin changes it.
 */
export default function CookTodayScreen() {
  const { colors } = useAppTheme();
  /*
   * The portal's key, not an inline loader. `GET /cook/today` carries the whole
   * week's routine as well as today's meals, so the Menu tab reads this same
   * descriptor — and without a `cacheKey` both tabs were refetching it on every
   * visit. See `lib/cook-queries.ts`.
   */
  const query = cookQuery.today();
  const today = useResource<CookToday>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const khataKey = khataQuery.orders();
  const khataOrders = useResource(khataKey.load, { cacheKey: khataKey.key, topics: khataKey.topics });
  const khataWaiting = khataOrders.data?.waiting.length ?? 0;

  /*
   * The clock, ticking. Every half minute and on every return from the
   * background, so a button whose meal comes due while this screen is open
   * unlocks itself — a cook who opened the app at 6:29 must not have to know to
   * pull it down at 6:30.
   */
  const now = useMinuteTick();

  const [busy, setBusy] = useState<MealType | null>(null);

  const announce = useCallback(
    async (mealType: MealType) => {
      setBusy(mealType);

      try {
        const announcement = await announceFoodReady({
          // One login serves the whole kitchen, so the device fingerprint is
          // the only thing that distinguishes two cooks in the audit trail.
          deviceInfo: await collectDeviceInfo(),
          mealType,
        });

        const summary = announcementSummary(announcement);

        if (summary.reached) {
          toastSuccess(`${humanizeEnum(mealType)} announced`, summary.body);
        } else {
          toastInfo("Nobody was notified", summary.body);
        }

        /*
         * The response, written into the cache — not a refetch.
         *
         * `today.refresh()` here was a whole `GET /cook/today` (the week's
         * routine, the hostel, the head count) to learn one fact the POST had
         * just returned. On a kitchen handset that is a visible pause between
         * the button and `Sent 12:04` appearing, which is exactly when a cook
         * presses again because nothing happened — and the second press is the
         * one that hits the cooldown 429.
         *
         * Nothing is guessed: every field comes off the server's own reply, and
         * this line is not reached at all if the announce threw. The More tab's
         * record updates from the same call, so the two screens cannot disagree
         * about a meal that was announced thirty seconds ago.
         */
        recordCookAnnouncement(announcement);
      } catch (caught) {
        // Includes the 429 cooldown, whose message names the wait in minutes.
        toastError("Not announced", readApiError(caught));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /*
   * Off `today.data`, not off `today.data!`: the header is built before the
   * loading and error branches return, so the eye is absent until the payload
   * lands rather than appearing on a bar already on screen.
   */
  const hostelSlug = today.data?.hostel.slug ?? "";

  /*
   * The lockup, the hostel's page and the bell — the same front-door bar the
   * other three portals open on.
   *
   * **Branding.** This tab led with `AppBar large title="Today"`, which named
   * the screen and not the product. The kitchen login is the most anonymous
   * account in the app — one shared credential, handed over by an admin, on a
   * phone that may be propped on a worktop for anyone to pick up — so it is the
   * one that most needs the app to say what it is on sight.
   *
   * **The bell**, which no cook screen had. `/notifications` is scoped to
   * `principal.userId` with no role branch, so this shared account has a feed —
   * the More tab had a row into it and none of the other three tabs did, so the
   * control vanished the moment you left that one screen.
   *
   * The hostel's name stays off the bar and on `<CookShiftCard>`, where it sits
   * under the head count it qualifies. A subtitle naming the hostel on every tab
   * is chrome repeating what the account already is.
   */
  const header = (
    <PortalBrandHeader
      hostelPageLabel="Open the hostel's page"
      onHostelPage={
        hostelSlug ? () => router.push(`/hostel/${hostelSlug}`) : undefined
      }
    />
  );

  if (today.loading) {
    return (
      /* The shift card, then four announce cards — the shape it lands in. */
      <Screen header={header} insideTabs padded={false} scroll>
        <View className="px-5">
          <Skeleton height={190} radius={26} />
        </View>

        <View className="gap-3 px-5 pt-6">
          <Skeleton height={18} width="40%" />
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton height={132} key={index} radius={16} />
          ))}
        </View>
      </Screen>
    );
  }

  if (today.error || !today.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={today.error ?? "Today's menu could not be loaded."}
          onRetry={today.reload}
        />
      </Screen>
    );
  }

  const buttons = mealButtons({
    announced: today.data.announced,
    meals: today.data.meals,
    now,
    /*
     * The hostel's clock per meal for the whole week — the same field
     * `announceFoodReady` gates on. Passing only `meals` read the day row's
     * `timing`, which is empty for any meal an admin did not plan today, so
     * those four buttons stayed live over an API that refuses them.
     */
    timings: today.data.routine.timings,
  });
  const next = nextUnannounced(buttons);

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={today.refresh}
      padded={false}
      refreshing={today.refreshing}
      scroll
    >
      <CookShiftCard
        announced={announcedCount(buttons)}
        hostelName={today.data.hostel.name}
        nextLabel={next ? humanizeEnum(next.mealType) : null}
        nextTiming={next?.timing ?? ""}
        residentCount={today.data.residentCount}
      />

      {/*
        Only when the owner switched it on. Above the meal buttons because the
        kitchen's spending happens at the market in the morning, before any
        food is out — and one row, because it is a door, not a report.
      */}
      {/* Khata asks — residents' eggs and extras, answered at the counter. */}
      <View className="px-5 pt-5">
        <CardRow
          icon="receipt-outline"
          onPress={() => router.push("/khata-asks")}
          right={khataWaiting > 0 ? <Badge label={`${khataWaiting} waiting`} tone="warning" /> : undefined}
          subtitle={khataWaiting > 0 ? "Tap to give" : "Nothing waiting"}
          title="Khata asks"
          tone="brand"
        />
      </View>

      {/* What the kitchen took from the store — the warden's daily usage is built from these taps. */}
      {today.data.stockEnabled ? (
        <View className="px-5 pt-5">
          <CardRow
            icon="cube-outline"
            onPress={() => router.push("/kitchen-stock")}
            subtitle="Tap what you took from the store"
            title="Kitchen stock"
            tone="brand"
          />
        </View>
      ) : null}

      {today.data.expensesEnabled ? (
        <View className="px-5 pt-5">
          <CardRow
            icon="wallet-outline"
            onPress={() => router.push("/expenses/new")}
            subtitle="Vegetables, gas, anything you paid for"
            title="Add expense"
            tone="success"
          />
        </View>
      ) : null}

      <View className="gap-3 px-5 pt-6">
        <SectionHeader
          subtitle="Tap when the food is out — residents get a notification, and so does the office"
          title="Food ready"
        />

        {buttons.map((button) => {
          const lockNote = mealLockNote(button);

          return (
            <Card
              /*
                The next meal to call is outlined in the brand, which is the only
                thing telling four otherwise identical cards apart before a word of
                them is read. It is the same treatment the resident's focus invoice
                carries, and for the same reason: on a screen of equals, the one
                you are here for should not have to be found.
              */
              className={`gap-3 ${
                button.state === "MISSED"
                  ? "border-warning/40"
                  : next?.mealType === button.mealType && !button.locked
                    ? "border-primary/40"
                    : ""
              }`}
              key={button.mealType}
            >
              <View className="flex-row items-start gap-3">
                {/*
                  The icon square the rest of the app uses for a meal. A cook
                  works this screen in a hurry with wet hands and picks the card
                  by shape before reading a word of it — four identical cards
                  distinguished only by a heading is the version that gets
                  breakfast announced at dinner.
                */}
                <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
                  <Ionicons
                    color={colors.primary}
                    name={mealIcon(button.mealType)}
                    size={19}
                  />
                </View>

                <View className="flex-1 gap-1">
                  <Text variant="subtitle">{humanizeEnum(button.mealType)}</Text>
                  <Text variant="caption">{mealSubtitle(button)}</Text>
                </View>

                {button.sent ? (
                  <Badge
                    label={`Sent ${formatTime(button.sent.announcedAt)}`}
                    tone="success"
                  />
                ) : button.timing ? (
                  /*
                    The routine's own words while the meal is open, and the
                    clock that matters while it is not. A cook looking at a dead
                    button is asking one question, and "7:00 PM - 8:45 PM" does
                    not answer it — the button went live at 6:30 and shut at
                    9:45.
                  */
                  <Badge
                    label={
                      button.state === "MISSED"
                        ? "Missed"
                        : button.state === "EARLY" && button.opensAt
                          ? `From ${button.opensAt}`
                          : button.timing
                    }
                    tone={button.locked ? "warning" : undefined}
                  />
                ) : null}
              </View>

              <Button
                /*
                  Disabled outside the meal's own hours — see `lib/cook.ts`. The
                  label carries the reason, so the control explains itself
                  without the caption below having to be read.
                */
                disabled={button.locked}
                /*
                  The label says what is happening, not just what the button
                  does. A spinner beside an unchanged "Food ready" reads as a
                  button that has not reacted; "Announcing…" is the press being
                  acknowledged in words, which is what stops the second tap into
                  the cooldown.
                */
                label={
                  busy === button.mealType ? "Announcing…" : mealButtonLabel(button)
                }
                loading={busy === button.mealType}
                onPress={() => void announce(button.mealType)}
                size="lg"
                /*
                  A missed meal is not an action any more, so it must not keep
                  wearing the brand: a pale green button is still a button, and
                  the card would read as something the cook has yet to get to.
                */
                variant={button.sent || button.state === "MISSED" ? "outline" : "primary"}
              />

              {button.sent ? (
                <Text variant="caption">
                  {`${button.sent.notifiedCount} resident(s) notified.`}
                </Text>
              ) : lockNote ? (
                <Text variant="caption">{lockNote}</Text>
              ) : null}
            </Card>
          );
        })}

        <Text className="px-1 pt-1" variant="caption">
          The message is built from today&apos;s menu automatically. If you have cooked
          something else, announce it and tell residents in person — the menu is the
          hostel office&apos;s to change.
        </Text>
      </View>
    </Screen>
  );
}
