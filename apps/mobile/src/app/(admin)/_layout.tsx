import { useMemo, useSyncExternalStore } from "react";

import { AdminAlertsProvider, useAdminAlerts } from "@/components/admin-alerts";
import { RoleTabs, type TabDef } from "@/components/role-tabs";
import { usePortalWarmup } from "@/hooks/use-portal-warmup";
import { getActiveHostelId, subscribeActiveHostel } from "@/lib/active-hostel";
import { prefetchAdminPortal } from "@/lib/admin-queries";

/**
 * The five, and why they are these five.
 *
 * The group shipped as `Overview / Alerts / Residents / More` — one dashboard,
 * one inbox, one list and a drawer, which is not a map of the product. The two
 * things an owner actually opens a phone for had no tab: **money**, buried
 * inside the alerts feed, and **the day's operations**, which were web links on
 * More.
 *
 * These mirror `apps/web/src/lib/portal-nav.ts`'s own admin groups — Dashboard,
 * Residents, Finance, Operations, Growth & System — rather than inventing a
 * second information architecture for the same product. Someone who knows the
 * portal already knows where things are.
 *
 * ## Community sits dead centre, in every role
 *
 * Third of five, which is where the public bar has always had it — so the tab
 * does not move when a resident signs in, or when the same phone is handed to a
 * warden. It is one platform-wide conversation rather than five role-shaped
 * copies, and putting it in a different slot per role would be the fastest way
 * to make it feel like five different things.
 *
 * ## Today is a route, not a tab
 *
 * Community is compulsory in every signed-in role, so one of the five had to
 * give up its slot, and the owner's call was Today. Residents keeps second
 * place — the roster and the inquiries queue are what an admin reaches for most
 * — and Money takes the slot Today had.
 *
 * Today itself is unchanged and still whole: roll call, complaints, maintenance,
 * the menu and notices, reached from Home's "Needs attention" rows.
 *
 * ## Alerts is a bell now, not a tab
 *
 * Its four sources each moved next to their own domain (claims → Money,
 * complaints → Today, inquiries → their own screen at `manage/inquiries`, SOS →
 * a banner on Home), and the
 * catch-all became `/notifications` — the same screen every signed-in user gets,
 * fed by `notifyAdminsOfClaim` and the SOS fan-out. The combined queue survives
 * at `(admin)/alerts` for "show me everything that needs a decision", reached
 * from Home and hidden from the bar.
 */
const HIDDEN = ["alerts", "community-reports", "today"] as const;

function AdminTabs() {
  const { counts } = useAdminAlerts();

  const tabs = useMemo<readonly TabDef[]>(
    () => [
      { icon: "home", label: "Home", name: "index" },
      /*
        Badges go where the decision is, and a lead is no longer decided here.

        Residents carried the inquiry count on the argument that a lead and a
        resident are the same subject. They are not — the roster screen's own
        doc says so — and once `manage/inquiries` existed the badge was pointing
        at a tab whose list does not contain a single one of the rows it counted.
        The count now sits on the tile that opens the queue, on Home.

        Claims keep theirs, because Payments genuinely is where a claim is
        approved. SOS deliberately has none — it is a red banner on Home and a
        push, and a "1" on a tab is far too quiet for it. Overdue complaints lose
        theirs with the Today tab; Home's row still carries the count.
      */
      { icon: "people", label: "Residents", name: "residents" },
      { icon: "chatbubbles", label: "Community", name: "community" },
      /*
        `Payments`, not `Money` — the word the portal uses. `portal-nav.ts` says
        "Payments" and "Fees & Payments" throughout and never says Money, and a
        hostel owner who runs the browser on a laptop and the app on a phone
        should not have to learn that the two are the same section.
      */
      { badge: counts.claim, icon: "card", label: "Payments", name: "money" },
      { icon: "grid", label: "More", name: "more" },
    ],
    [counts.claim],
  );

  return <RoleTabs accent="ADMIN" hidden={HIDDEN} tabs={tabs} />;
}

export default function RoleLayout() {
  /*
   * The portal's warm-up: Home, every tab and every Manage door in one parallel
   * wave the moment the group mounts, refilled on foreground. See
   * `usePortalWarmup` for ordering. Nothing is awaited and nothing can throw —
   * a speculative 403 for a narrow warden is not news.
   */
  usePortalWarmup(prefetchAdminPortal);

  /*
   * An owner with branches works in one at a time (`lib/active-hostel.ts`).
   * Keyed on it, so switching remounts every tab onto the new hostel: a mounted
   * screen resets its local state and seeds from that branch's cache. Other
   * branches remain cached for a return visit.
   */
  const activeHostel = useSyncExternalStore(subscribeActiveHostel, getActiveHostelId, getActiveHostelId);

  return (
    <AdminAlertsProvider key={activeHostel ?? "main"}>
      <AdminTabs />
    </AdminAlertsProvider>
  );
}
