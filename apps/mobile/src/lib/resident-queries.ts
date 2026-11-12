/**
 * Every read the resident portal makes, named once.
 *
 * The sibling of `admin-queries.ts`, built for the same two reasons and a third
 * that turned out to matter more here than there.
 *
 * ## 1. A prefetch has to warm the key the screen reads
 *
 * Otherwise it warms a key nobody looks at and the screen loads twice. That
 * requires the loader and its key to be defined in one place both the warm-up
 * and the screen can import — which is this file.
 *
 * ## 2. The identity guarantee
 *
 * `defineQuery` hands back the *same* descriptor object for the life of the
 * process, so `query.load` is a stable identity and needs no `useCallback` at
 * the call site. `useResource` refetches whenever its loader's identity changes,
 * so a registry returning a fresh arrow each render would fetch in a loop.
 *
 * ## 3. The resident tabs were throwing their answers away
 *
 * This is the part that was actually broken. `useResource` without a `cacheKey`
 * holds its payload in component state and loses it on unmount — the correct
 * default for a screen visited once, and the wrong one for a tab. Every resident
 * screen was in that state, so switching Home → Payments → Home refetched the
 * dashboard from scratch, with a loading state, every single time. The admin
 * tabs have painted from cache since they got their registry; these now do too.
 *
 * ## The warm-up is one wave, not the admin's three
 *
 * `prefetchAdminPortal` splits into three tiers because a warden's portal has
 * seven reads at the door and a dozen more behind it. A resident has **five
 * tabs and one payload each**, four of which are small, so a second wave would
 * be scheduling machinery around nothing. What is deliberately *not* warmed:
 *
 * - **Home**, because the resident lands on it and it is already asking. Warming
 *   it would be a duplicate request racing the screen's own.
 * - **Anything per-id** — an invoice, a complaint, a guardian. Warming forty
 *   records to save one tap is bandwidth taken from the screen on the glass.
 * - **Community**, which has `prefetchCommunity` of its own and is shared with
 *   every other role.
 */

import { REALTIME_TOPIC } from "@/constants/topics";
import type { ResidentAttendance } from "@/lib/attendance";
import { getResidentAttendance } from "@/lib/attendance-api";
import { getResidentComplaints, type ComplaintList } from "@/lib/complaints-api";
import {
  getFinanceView,
  getPayInstructions,
  type PayInstructions,
  type ResidentFinanceView,
} from "@/lib/finance-api";
import { listGuardians } from "@/lib/guardian-access-api";
import type { GuardianLink } from "@/lib/guardian-access";
import { getIdentity, type IdentityResponse } from "@/lib/identity-api";
import { getOfferProgram, type ResidentOfferProgram } from "@/lib/offer-program-api";
import { type CreditScore, getCreditScore } from "@/lib/credit-score-api";
import { defineQuery, prefetchQuery, type Query } from "@/lib/query-cache";
import {
  getResidentDashboard,
  getResidentFood,
  getResidentNightStatus,
  getResidentNightStatusHistory,
  getResidentNotices,
  getResidentProfile,
  type NightStatusView,
  type ResidentDashboard,
  type ResidentFood,
  type ResidentNoticeList,
  type ResidentProfile,
} from "@/lib/resident-api";
import type { NightHistoryEntry } from "@/lib/night-status-history";
import { getResidentReferral, type ResidentReferral } from "@/lib/referral-api";
import { getEmergencyContacts, getResidentSosAlerts } from "@/lib/safety-api";

/** A resident-portal question. Shape and reasoning live in `query-cache.ts`. */
export type ResidentQuery<T> = Query<T>;

const define = defineQuery;

/**
 * The More tab's pair, loaded together because the screen renders them together
 * and two `useResource`s would give it two loading states for one card.
 *
 * The night status is allowed to fail: `getResidentNightStatus` 404s for a
 * resident who has never set one, and a menu screen that refuses to draw because
 * a subtitle is missing would be the tail wagging the dog.
 */
export type ResidentMore = {
  /**
   * The status row **and** the resident's latest alert, because a night status
   * of `SOS_TRIGGERED` is a row nothing ever clears — see `stayPill`, which is
   * what turns the pair into the one word this screen prints.
   */
  nightStatus: NightStatusView | null;
  profile: ResidentProfile;
};

async function loadMore(): Promise<ResidentMore> {
  const [profile, nightStatus] = await Promise.all([
    getResidentProfile(),
    getResidentNightStatus().catch(() => null),
  ]);

  return { nightStatus, profile };
}

export const residentQuery = {
  /**
   * Location consent and the attendance history behind it.
   *
   * `attendance` rather than `safety`: the pings are published by the
   * attendance service, and the screen's only other content is the consent
   * switch, which the resident moves themselves.
   */
  attendance: (): ResidentQuery<ResidentAttendance> =>
    define("resident:attendance", [REALTIME_TOPIC.ATTENDANCE], () =>
      getResidentAttendance(),
    ),

  /**
   * One key for the list and for every complaint opened off it.
   *
   * `complaints/[id]` has no endpoint of its own — it finds its row inside this
   * same payload — so without a shared key opening a complaint re-asked for the
   * whole list behind a full-screen spinner to render a row the previous screen
   * already had.
   */
  complaints: (): ResidentQuery<ComplaintList> =>
    define("resident:complaints", [REALTIME_TOPIC.COMPLAINTS], () =>
      getResidentComplaints(),
    ),

  /**
   * One payload, five domains — `feeStatus`, `notices`, `complaints`,
   * `foodMenu` and `nightStatus` — so it names all five topics. Each is
   * genuinely published to `private-hostel-<id>`, which a resident's principal
   * is granted off its own `hostelIds`.
   */
  dashboard: (): ResidentQuery<ResidentDashboard> =>
    define(
      "resident:dashboard",
      [
        REALTIME_TOPIC.PAYMENTS,
        REALTIME_TOPIC.NOTICES,
        REALTIME_TOPIC.COMPLAINTS,
        REALTIME_TOPIC.FOOD,
        REALTIME_TOPIC.SAFETY,
      ],
      () => getResidentDashboard(),
    ),

  /**
   * `payments` covers all four services that can change what a resident owes
   * without the resident doing anything: a claim decided, a gateway payment
   * reviewed, a statement reconciled, a statement imported.
   */
  finance: (): ResidentQuery<ResidentFinanceView> =>
    define("resident:finance", [REALTIME_TOPIC.PAYMENTS], () => getFinanceView()),

  /** This quarter's certified total, the perks and the resident's offers. */
  offerProgram: (): ResidentQuery<ResidentOfferProgram> =>
    define("resident:offer-program", [REALTIME_TOPIC.PAYMENTS], () => getOfferProgram()),

  /** Score, receipts shared / approved, and the rule (todo C4). */
  creditScore: (): ResidentQuery<CreditScore> =>
    define("resident:credit-score", [REALTIME_TOPIC.PAYMENTS], () => getCreditScore()),

  /** The ID card, read by both the card and its editor. */
  identity: (): ResidentQuery<IdentityResponse> =>
    define("resident:identity", [REALTIME_TOPIC.RESIDENTS], () => getIdentity()),

  food: (): ResidentQuery<ResidentFood> =>
    define("resident:food", [REALTIME_TOPIC.FOOD], () => getResidentFood()),

  /**
   * `residents`, not a guardian topic — there is none. A guardian accepting
   * their invitation goes through `registerOrUpgradeUserByEmail`, which is a
   * change to this resident's people either way.
   */
  guardians: (): ResidentQuery<GuardianLink[]> =>
    define("resident:guardians", [REALTIME_TOPIC.RESIDENTS], () => listGuardians()),

  more: (): ResidentQuery<ResidentMore> =>
    define("resident:more", [REALTIME_TOPIC.SAFETY], () => loadMore()),

  /**
   * Who the SOS screen would call, and what this resident has already raised.
   *
   * Two keys because they are two questions with different lifetimes — the
   * contacts are a near-static list, the alerts change the moment staff settle
   * one — but the same topic: `triggerSOS` and `updateSOSAlertStatus` both
   * publish `safety`, which is what keeps the alert list honest without the
   * screen watching its own countdown.
   */
  emergencyContacts: (): ResidentQuery<
    Awaited<ReturnType<typeof getEmergencyContacts>>
  > =>
    define("resident:emergency-contacts", [REALTIME_TOPIC.SAFETY], () =>
      getEmergencyContacts(),
    ),

  sosAlerts: (): ResidentQuery<Awaited<ReturnType<typeof getResidentSosAlerts>>> =>
    define("resident:sos-alerts", [REALTIME_TOPIC.SAFETY], () => getResidentSosAlerts()),

  /**
   * **Page 1 only, and the key says so.** The notices screen pages by appending
   * to what it holds rather than by re-keying, so this warms the first page and
   * the screen owns everything after it. A key that pretended to cover page 3
   * would hand a returning reader a cache entry that is missing two thirds of
   * what they had scrolled to.
   */
  notices: (): ResidentQuery<ResidentNoticeList> =>
    define("resident:notices:1", [REALTIME_TOPIC.NOTICES], () => getResidentNotices()),

  /**
   * The full night-status view, and the history screen behind it.
   *
   * `more` carries a night status too, but only the one field its card draws;
   * these are the screen's own reads and are keyed separately so that opening
   * the screen does not overwrite the tab's smaller payload.
   */
  nightStatus: (): ResidentQuery<NightStatusView> =>
    define("resident:night-status", [REALTIME_TOPIC.SAFETY], () =>
      getResidentNightStatus(),
    ),

  nightStatusHistory: (): ResidentQuery<NightHistoryEntry[]> =>
    define("resident:night-history", [REALTIME_TOPIC.SAFETY], () =>
      getResidentNightStatusHistory(),
    ),

  /**
   * How to pay one invoice — read by the pay screen and by the claim form that
   * prefills its amount from the same answer.
   *
   * The invoice is in the key because it changes the answer: a second invoice
   * sharing this entry would hand the resident another bill's reference code.
   */
  payInstructions: (invoiceId: string): ResidentQuery<PayInstructions> =>
    define(`resident:pay-instructions:${invoiceId}`, [REALTIME_TOPIC.PAYMENTS], () =>
      getPayInstructions(invoiceId),
    ),

  referral: (): ResidentQuery<ResidentReferral> =>
    define("resident:referral", [], () => getResidentReferral()),

  profile: (): ResidentQuery<ResidentProfile> =>
    define(
      "resident:profile",
      [REALTIME_TOPIC.RESIDENTS, REALTIME_TOPIC.SAFETY],
      () => getResidentProfile(),
    ),
} as const;

/** Warms one descriptor. Never throws, never re-asks something already fresh. */
export function prefetchResidentQuery<T>(query: ResidentQuery<T>) {
  prefetchQuery(query.key, query.load, { topics: query.topics });
}

/**
 * Everything the portal reads, warmed in one parallel wave the moment a
 * resident enters it — Home first (its own request is already in flight and
 * this joins it), then the tabs, then the screens Home and More push.
 * Nothing is awaited and nothing can throw — `prefetchQuery` swallows failures
 * by design, and whichever screen opens the key will ask again and report the
 * failure properly, on a surface with somewhere to put the message.
 */
export function prefetchResidentPortal() {
  prefetchResidentQuery(residentQuery.dashboard());
  /*
   * One read, two tabs. Payments and Statement are the same invoices asked two
   * questions — what is open, and what has been paid — so they share
   * `resident:finance` and this warms both.
   */
  prefetchResidentQuery(residentQuery.finance());
  prefetchResidentQuery(residentQuery.more());
  prefetchResidentQuery(residentQuery.notices());
  prefetchResidentQuery(residentQuery.food());
  prefetchResidentQuery(residentQuery.guardians());
  prefetchResidentQuery(residentQuery.profile());
}

/**
 * The href a tile is about to push → the question that screen will ask.
 *
 * The resident half of {@link prefetchAdminRoute}, and deliberately short. Most
 * of what the `Your stay` grid opens has nothing to warm — `id-card` draws from
 * the dashboard the caller already holds, `hostels` and `review` open their own
 * search and form — so only the two screens that lead with a read of their own
 * are listed.
 *
 * Unknown hrefs are a no-op rather than a throw. This is called from press
 * handlers on a grid whose contents change, and a tile added without an entry
 * here must cost a hundred milliseconds, not a crash.
 */
export function prefetchResidentRoute(href: string) {
  switch (href) {
    /*
     * Food stopped being a tab when Statement took its slot, so it stopped being
     * warmed at the door with the ones a resident is certain to reach. It is a
     * push from Home now, and this is where a push gets its warm-up.
     */
    case "/(resident)/food":
      prefetchResidentQuery(residentQuery.food());
      return;
    case "/guardians":
      prefetchResidentQuery(residentQuery.guardians());
      return;
    case "/profile":
      prefetchResidentQuery(residentQuery.profile());
      return;
    default:
  }
}
