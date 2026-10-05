import { OverallTabScreen } from "@/components/overall-views";
import { router } from "expo-router";

import { CardRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { useMemo } from "react";
import { View } from "react-native";

import {
  AlertCard,
  DeniedNotice,
  useAdminAlerts,
  useAlertActions,
} from "@/components/admin-alerts";
import {
  AdminHomeHeader,
  HostelHero,
  QuickActions,
  ServiceGrid,
  WaitingActions,
} from "@/components/admin-home";
import { useIsOverall } from "@/components/hostel-switcher";
import { KycCard } from "@/components/manage/kyc-card";
import { FreeMonthCard, SubscriptionDueCard } from "@/components/subscription-due";
import { SectionHeader } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { ACTION_CARD } from "@/components/ui/action-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import { buildAlertFeed, occupancyRate } from "@/lib/admin-alerts";
import { earningsSummary, listingState, monthOverMonth } from "@/lib/admin-home";
import {
  type AdminOverview,
  adminQuery,
  prefetchAdminRoute,
} from "@/lib/admin-queries";
import { openConfirm } from "@/lib/confirm";
import { expenseQuery } from "@/lib/expenses-api";
import { STORE_OPEN } from "@/lib/store-api";

/**
 * Said from Home, before any navigation: entering `(store)` only to cover it
 * with this alert mounted the whole shop for nothing.
 */
function openStore() {
  if (STORE_OPEN) {
    router.push("/(store)");
    return;
  }

  openConfirm({
    cancelLabel: null,
    confirmLabel: "OK",
    message:
      "We are working on the store. It will be available very soon, and we will notify you when it opens.",
    onConfirm: () => {},
    title: "Store coming soon",
  });
}

/** A row of icon cells in the same card the real shortcut rows use. */
function SkeletonActionRow() {
  return (
    <View className={`flex-row ${ACTION_CARD}`}>
      {Array.from({ length: 4 }, (_, index) => (
        <View className="flex-1 items-center gap-2" key={index}>
          <Skeleton height={44} radius={14} width={44} />
          <Skeleton height={10} width="60%" />
        </View>
      ))}
    </View>
  );
}

/** Home's shape — hero, shortcuts, two sections — while the first load runs. */
function AdminHomeSkeleton() {
  return (
    <View>
      <View style={{ paddingHorizontal: 14 }}>
        <Skeleton height={196} radius={18} />
      </View>

      <View className="px-5 pt-3">
        <SkeletonActionRow />
      </View>

      <View className="gap-6 px-5 pt-6">
        <View className="gap-3">
          <Skeleton height={16} width="40%" />
          <SkeletonActionRow />
        </View>
        <View className="gap-3">
          <Skeleton height={16} width="30%" />
          <SkeletonActionRow />
          <SkeletonActionRow />
        </View>
      </View>
    </View>
  );
}

/**
 * The hostel at a glance — and the first screen a hostel owner ever sees.
 *
 * ## What changed, and the complaint it answers
 *
 * The previous Home was a correct screen that nobody could read: an app bar, a
 * card with one number in it, and then four grids of bordered boxes — nine
 * tiles and eleven rows, every one of them the same weight, in the same grey
 * rectangle, with no answer to "what am I looking at". An owner who is not a
 * software person opened it and had to *study* it.
 *
 * It is now shaped like the thing these people already use every day, which is
 * a mobile banking app: a painted header carrying the identity and the money,
 * a row of shortcuts straddling its edge, and then a short body of things that
 * want a decision. Nothing was invented to fill it — every figure below comes
 * from a route the portal already serves.
 *
 * ## Three questions, in this order
 *
 * 1. **Whose hostel is this and what has it earned** — the hero. Lifetime
 *    collections lead, because that is the number a phone can give that a
 *    laptop is currently the only way to get. Residents / vacant / occupancy
 *    ride along inside it: context, never a tap target.
 * 2. **What can I do from here** — four shortcuts, pinned to the fold.
 * 3. **What is waiting for me** — the queue, then this month's money, then
 *    tonight, then the listing.
 *
 * ## It is still not the web dashboard
 *
 * Fee schedules, billing runs, reconciliation, warden management, room config
 * and nine report views stay in the browser and are reached from More. What
 * this screen adds over the previous one is *depth on what it already showed*,
 * not breadth.
 *
 * ## Those counts come from the queues, not from the dashboard report
 *
 * `report.complaints` is every complaint the hostel has ever had, settled ones
 * included, and `report.maintenanceRequests` is every non-deleted request in
 * any status. Under a heading saying "what is open right now" both were quietly
 * wrong, in the direction that makes an owner stop trusting the screen. The
 * rows read the live queues instead — the same data the tab badges show.
 *
 * ## SOS is in the hero, above the money
 *
 * Unchanged in substance and stronger in placement: the alarm is a white strip
 * inside the gradient, which cannot be scrolled past because it is above the
 * fold by construction, and the acknowledge control is on the card immediately
 * below. Two surfaces on purpose — the alarm has to be seen, the decision needs
 * the resident's name and message next to it.
 */
/*
 * The shape and the loader moved to `lib/admin-queries.ts`, where the portal's
 * prefetch can run the same read under the same key. What used to be a local
 * `loadOverview` is `adminQuery.overview()`, tolerant reads and all.
 */

function BranchAdminHomeScreen() {
  // Read for one decision only: whether the shortcut row's lead cell is the
  // Store or roll call. See the `onStore` note on `<QuickActions>` below.
  const account = useAppSelector((state) => state.auth.account);
  /*
   * Whether this person may add expenses. The owner always may; a warden only
   * with `recordExpenses`, which the app learns the way it learns every other
   * grant — by asking. Same key the add screen reads, so the answer is already
   * in the cache when the cell is tapped.
   */
  const expenseAccess = expenseQuery("staff", null);
  const expenses = useResource(expenseAccess.load, {
    cacheKey: expenseAccess.key,
    topics: expenseAccess.topics,
  });
  const canAddExpense =
    account?.role === ROLE.HOSTEL_ADMIN || expenses.data?.kind === "ok";
  /*
   * The descriptor, not a local loader: the same object the portal's warm-up
   * prefetched into the cache under `query.key`, so a Home that was warmed paints
   * from it and revalidates behind the figures instead of over them.
   *
   * `adminQuery` hands back one object per key for the life of the process, so
   * `query.load` is a stable identity and needs no `useCallback` — see `define`
   * in `lib/admin-queries.ts` for why that is a requirement rather than a tidy-up.
   */
  const query = adminQuery.overview();
  /*
   * Only a team-registered hostel ever has anything here, so this resolves to
   * `null` for almost every owner and the card renders nothing. It is read on
   * Home rather than buried in Money because a due with a deadline is news, and
   * news belongs on the screen that opens first.
   */
  const dueQuery = adminQuery.subscription();
  const due = useResource(dueQuery.load, {
    cacheKey: dueQuery.key,
    topics: dueQuery.topics,
  });

  const overview = useResource<AdminOverview>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /*
   * No pay handler here any more, and its absence is deliberate.
   *
   * This screen used to own one: a confirm dialog whose **Record payment**
   * button posted an `open`/`confirm` pair and toasted "Payment recorded". A
   * phone cannot record a payment — it can only claim one — and the route it
   * called had already dropped both branches, so the dialog either invented a
   * settlement or surfaced "this invoice is already settled in full" over an
   * unpaid balance. The card now only states the balance and opens billing —
   * the plan is paid on the website, for the store-policy reason in
   * `components/subscription-due.tsx` — and the money is recorded by a person
   * who has seen the proof.
   */

  const alerts = useAdminAlerts();
  const actions = useAlertActions();

  const sosRows = useMemo(
    () =>
      buildAlertFeed({
        claims: [],
        complaints: [],
        inquiries: [],
        sos: alerts.data?.sos ?? [],
      }),
    [alerts.data],
  );

  const report = overview.data?.report ?? null;
  const periods = overview.data?.periods ?? null;

  const earnings = useMemo(
    () =>
      earningsSummary({
        months: periods?.months ?? null,
        overall: periods?.overall ?? null,
        report: report ?? { monthlyDues: 0, paidAmount: 0 },
      }),
    [periods, report],
  );

  const delta = useMemo(() => monthOverMonth(periods?.months ?? []), [periods]);

  /*
   * Read before the guards below, because the header is drawn in all three
   * states and needs them. Both are null-tolerant: `listingState(null)` is
   * `{ live: false }`, so a header built mid-load simply has no eye on it yet.
   */
  const hostel = overview.data?.hostel ?? null;
  const listing = listingState(hostel);

  /*
   * The same fixed bar in every state, including the two that have no data to
   * draw. It is what makes a slow first load look like the app arriving rather
   * than like a blank screen with a spinner on it.
   */
  const header = (
    <AdminHomeHeader
      /*
       * Only once the listing is actually live. `getPublicHostelBySlug` matches
       * on `PUBLISHED` + `VERIFIED` and 404s otherwise, so handing this button
       * to an owner whose application is still in review would answer "show me
       * my hostel" with "Hostel was not found". `listing.note` is already on the
       * hero saying which of the two it is waiting on.
       */
      onPreview={
        listing.live && hostel
          ? () => router.push(`/hostel/${hostel.slug}`)
          : undefined
      }
    />
  );

  if (overview.loading) {
    return (
      <Screen header={header} insideTabs padded={false} scroll>
        <AdminHomeSkeleton />
      </Screen>
    );
  }

  if (overview.error || !overview.data || !report) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={overview.error ?? "The dashboard could not be loaded."}
          onRetry={overview.reload}
        />
      </Screen>
    );
  }

  return (
    <>
      <Screen
        header={header}
        insideTabs
        onRefresh={() => {
          overview.refresh();
          alerts.refresh();
        }}
        padded={false}
        refreshing={overview.refreshing || alerts.refreshing}
        scroll
      >
        <HostelHero
          delta={delta}
          earnings={earnings}
          hostel={hostel}
          listing={listing}
          occupancy={occupancyRate(report)}
          onSos={() => router.push("/(admin)/alerts")}
          residents={report.residents}
          sosCount={sosRows.length}
          vacantBeds={report.vacantBeds}
        />

        {/*
          Its own row now, not pulled up onto the card's shoulder. The straddle
          needed a full-width painted edge to straddle, and the hero stopped
          having one when it became an object with corners.
        */}
        <View className="pt-3">
          <QuickActions
            onAddExpense={canAddExpense ? () => router.push("/expenses/new") : undefined}
            onNewResident={() => router.push("/manage/resident/new")}
            /*
             * The camera, not a search box. Everything about this action happens
             * with a card in one hand and the phone in the other, which is why
             * it took the slot `Post notice` had: see `QuickActions`.
             */
            /*
             * The fallback for the lead cell, and a warden's own nightly job.
             * `QuickActions` uses it whenever `onStore` is absent.
             *
             * Every shortcut here opens the screen that *owns* its job, and this
             * is the rule's original case: roll call used to push
             * `(admin)/today` and rely on somebody finding the roster inside a
             * digest screen.
             */
            onRollCall={() => router.push("/manage/roll-call")}
            onScan={() => router.push("/manage/scan")}
            /*
             * HOSTEL_ADMIN only. The store's routes are
             * `requireHostelAdminPrincipal` — spending the hostel's budget is
             * not what a warden's permissions are about — so a warden gets roll
             * call in this cell rather than a tile that 403s.
             *
             * The **group**, not `(store)/index`: pushing the group lets
             * expo-router pick its initial route, so the store opens on its Shop
             * tab with the bar already drawn. Pushing the screen directly would
             * mount it outside the tab navigator and lose the bar entirely.
             */
            onStore={
              account?.role === ROLE.HOSTEL_ADMIN ? openStore : undefined
            }
          />
        </View>

        <View className="gap-6 px-5 pt-6">
          <KycCard />
          <SubscriptionDueCard state={due.data ?? null} />
          <FreeMonthCard state={due.data ?? null} />

          {/* A warden's cash box, one tap from Home: what is left, and cash waiting for "Got it". */}
          {expenses.data?.kind === "ok" && expenses.data.home.wallet ? (
            <CardRow
              icon="wallet-outline"
              onPress={() => router.push("/expenses")}
              right={
                <Money
                  owed={expenses.data.home.wallet.left < 0}
                  value={Math.abs(expenses.data.home.wallet.left)}
                />
              }
              subtitle={
                expenses.data.home.pendingCash.length > 0
                  ? `${expenses.data.home.pendingCash.length} waiting for you`
                  : expenses.data.home.wallet.left < 0
                    ? "Hostel owes you"
                    : "Cash left"
              }
              title="My cash"
              tone={expenses.data.home.pendingCash.length > 0 ? "warning" : "brand"}
            />
          ) : null}

          {sosRows.length > 0 ? (
            <View className="gap-3">
              {sosRows.map((row) => (
                <AlertCard actions={actions} key={row.id} row={row} />
              ))}
            </View>
          ) : null}

          <View>
            {/*
              One card of four, not four cards of one.

              This started as five full-width rows in a bordered card, became a
              two-by-two grid of separately bordered tiles, and is now the same
              object as the shortcut row that sits directly above it:
              `WaitingActions` and `QuickActions` are both an `ActionCard` of
              icon cells, differing only in that these carry a count.

              Each step was the same correction. The question this section
              answers is "is anything waiting, and roughly how much", which is a
              *looking* question — and every bit of chrome that made them
              separate objects, or gave each one a sentence of explanation, was
              turning a glance back into a read.
            */}
            {/*
              No "See all". Every cell in the card below opens the screen that
              owns its queue, and the bell in the header opens the combined feed
              — a third path to the same places, sitting on the heading of a row
              that is already nothing but paths, was chrome.
            */}
            <SectionHeader title="Waiting for you" />

            <DeniedNotice denied={alerts.data?.denied ?? []} />

            <WaitingActions
              inquiries={alerts.counts.inquiry}
              /*
                `manage/inquiries`, not the Residents tab.

                It pointed at the roster, which is a list of people who already
                live here — so the tile's red count sent you to a screen that did
                not contain the thing it was counting, and there was nowhere to
                clear it. See the note at the top of `manage/inquiries.tsx`.
              */
              onInquiries={() => router.push("/manage/inquiries")}
              /*
                `manage/statements`, the bank import — under the name of the job
                rather than of the file it eats.

                It is the screen the cell beside it used to open while wearing
                the word `Statement`, which the Manage grid below spends on a
                different screen entirely. Two doors, one word, one scroll
                apart. Now each says what is behind it.

                No badge: an import is something you *do*, not a queue that
                fills, same as `Today` below.
              */
              onReconcile={() => router.push("/manage/statements")}
              /*
                `manage/finance/statement`, the hostel's own ledger of credits —
                the same screen the Manage grid's `Statement` tile opens, and the
                whole point of this cell: money coming in is the thing an owner
                checks most often, so it gets the door on the row they are
                already reading rather than one section further down.
              */
              onStatement={() => router.push("/manage/finance/statement")}
              /*
                No badge on this one: Today is a **door**, not a queue — roll
                call, complaints, maintenance, the menu and notices — and there
                is no single number that means "how much of that is waiting".
              */
              onToday={() => router.push("/(admin)/today")}
            />
          </View>

          <View>
            {/*
              Where the rest of the product is, and where Home stops.

              Six sections stood here — this month's collection, the trend, what
              is still owed, tonight's roster, the listing's view counts — and
              every one of them is the *summary* of a screen that is one tap
              away and shows the same thing properly. A home screen whose job is
              to get you somewhere had turned into three scrolls of somewhere
              else's figures.

              The trend chart moved to Money, which is the screen it belongs to.
              Nothing else moved because nothing else needed to: Money, Today and
              `manage/settings` were already drawing all of it.
            */}
            <SectionHeader title="Manage" />

            {/*
              Touch-down warms the screen the tile opens, where there is anything
              to warm. The launch-time warm-up deliberately does not cover these
              eleven — see `prefetchAdminRoute`.
            */}
            <ServiceGrid
              onOpen={(href: string) => router.push(href as never)}
              onPrefetch={prefetchAdminRoute}
              owner={account?.role === ROLE.HOSTEL_ADMIN}
            />
          </View>
        </View>
      </Screen>

      {actions.sheet}
    </>
  );
}

/**
 * With Overall picked in the switcher this tab answers for every branch at
 * once (`components/overall-views.tsx`); otherwise it is the one branch's screen.
 */
export default function AdminHomeScreen() {
  return useIsOverall() ? <OverallTabScreen tab="home" /> : <BranchAdminHomeScreen />;
}
