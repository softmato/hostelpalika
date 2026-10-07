/**
 * The guardian surface — one ward, read-only, field by field.
 *
 * ## These types are read off `guardian.service.ts`, not off the web's type
 *
 * `apps/web/src/app/_components/daily-operations-shared.tsx` carried a
 * hand-written `GuardianDashboard` that had drifted from the serializer three
 * ways, and every one of them rendered as broken text on the web page. Copying
 * it would have shipped the same three bugs to a second client. So: `fullName`
 * (never `firstName`/`lastName`), `safety.asOf` (never `checkedAt`, and a
 * **date**, not a timestamp), and a **nullable** `summary`. The web type has
 * since been corrected to match; this file remains the authority for mobile.
 *
 * ## `permissions` is the most important field in the payload
 *
 * Every section is queried **only** when its flag is set — `getGuardianDashboard`
 * gates each query rather than fetching and filtering, so a field the resident
 * did not share is never read out of the database at all. The consequence for a
 * client is that an ungranted section arrives as an empty array, identical to a
 * section that is genuinely empty. Without `permissions` you cannot tell "your
 * ward has no complaints" from "you are not allowed to see complaints" — so
 * every screen here gates on the flag and **omits** the section rather than
 * drawing it empty. `permissionsOf()` and `sharedSections()` below are that
 * rule, in one testable place.
 *
 * ## One endpoint, four routes
 *
 * `/guardian/payments`, `/notices`, `/food` and `/safety-summary` all call
 * `getGuardianDashboard` internally and return slices of the same object. So
 * mobile fetches the dashboard once and slices it locally — four requests for
 * four tabs would be four identical database round trips. The narrow routes are
 * still typed here because the deep-link and refresh paths may want one.
 */

import { api, publicApi } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type GuardianPermissions = {
  canViewComplaintStatus: boolean;
  canViewFood: boolean;
  canViewNotices: boolean;
  canViewPayments: boolean;
  canViewReceipts: boolean;
  canViewSafety: boolean;
};

export type GuardianPermissionKey = keyof GuardianPermissions;

/** The share link itself: which code was redeemed, and when it lapses. */
export type GuardianAccess = {
  expiresAt: string;
  guardianId: string;
  hostelId: string;
  id: string;
  phone: string;
  residentId: string;
  status: "ACTIVE" | "EXPIRED" | "REVOKED" | "USED";
  userId?: string;
};

export type GuardianPayment = {
  dueAmount: number;
  dueDate?: string;
  id: string;
  /**
   * `YYYY-MM`, the billing period — the same key receipts are grouped by — or
   * **null** on a one-off that belongs to no month. The joining bill is one,
   * and it is the *first* invoice a household ever sees, so this is the common
   * case for a new resident rather than an edge one. See `Invoice.period`.
   */
  month: string | null;
  paidAmount: number;
  status: string;
};

export type GuardianReceipt = {
  amount: number;
  id: string;
  /** `YYYY-MM-DD`. Already date-only from the server. */
  issuedOn: string;
  month: string;
  receiptNumber: string;
};

export type GuardianNotice = {
  category: string;
  content: string;
  id: string;
  isUrgent: boolean;
  title: string;
};

/**
 * Today's meals off the weekly routine — `mealsOn(routine, new Date())`. A
 * guardian is shown what their ward is eating today, not the whole week, so
 * there is no `dayOfWeek` here and nothing to page through.
 */
export type GuardianMeal = {
  id: string;
  items: string[];
  mealType: string;
  note?: string;
  timing?: string;
};

export type GuardianComplaint = { id: string; status: string; title: string };

/**
 * Night status, reduced to a day.
 *
 * `asOf` is `YYYY-MM-DD` and the truncation is deliberate: the exact minute a
 * resident was checked is the surveillance detail PHASES.md §4.1 forbids
 * showing a guardian. Never render a time from it.
 *
 * `null` — the whole object — when `canViewSafety` is false.
 */
export type GuardianSafety = { asOf: string | null; status: string };

export type GuardianDashboard = {
  access: GuardianAccess;
  complaints: GuardianComplaint[];
  food: GuardianMeal[];
  guardian: { id: string; name: string; phone: string; relation: string };
  hostel: {
    contact: { email: string; phone: string };
    id: string;
    /** True only when the platform has verified the hostel. */
    isVerified: boolean;
    location: { address?: string; area?: string; city?: string };
    name: string;
    /** The building's cover photo, or `""`. */
    photoUrl: string;
    /**
     * The public listing's slug, or `""`.
     *
     * The server has always sent these last three and this type has always
     * omitted them, so `hostel/[slug]` was unreachable from this portal for no
     * reason other than a hand-written type being shorter than the payload it
     * described. It is empty — never a slug — unless the listing is `PUBLISHED`
     * **and** `VERIFIED`, because `getPublicHostelBySlug` filters on both and a
     * guardian who taps through to "Hostel was not found" learns something
     * frightening and untrue about where their child lives.
     */
    slug: string;
  } | null;
  notices: GuardianNotice[];
  payments: GuardianPayment[];
  permissions: GuardianPermissions;
  receipts: GuardianReceipt[];
  /** Identity and room only. Never the deposit, contacts or account linkage. */
  resident: {
    fullName: string;
    id: string;
    /** Their profile picture. Pass it through `useAvatarSource()`, never raw. */
    image: string | null;
    roomType: string;
    status: string;
  };
  safety: GuardianSafety | null;
  /** `null` when `canViewPayments` is false — not a zeroed summary. */
  summary: { dueAmount: number; unpaidCount: number } | null;
};

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** `GET /guardian/dashboard`. Everything the guardian is allowed to see. */
export async function getGuardianDashboard() {
  const response =
    await api.get<ApiEnvelope<{ dashboard: GuardianDashboard }>>("/guardian/dashboard");

  return unwrap(response).dashboard;
}

/**
 * `GET /guardian/payments`. A slice of the dashboard, not a cheaper query —
 * `listGuardianPayments` calls `getGuardianDashboard` and drops the rest. Use
 * it only where the dashboard is not already in hand.
 */
export async function getGuardianPayments() {
  const response = await api.get<
    ApiEnvelope<{
      payments: GuardianPayment[];
      receipts: GuardianReceipt[];
      summary: GuardianDashboard["summary"];
    }>
  >("/guardian/payments");

  return unwrap(response);
}

/** `GET /guardian/notices`. Same caveat as above. */
export async function getGuardianNotices() {
  const response =
    await api.get<ApiEnvelope<{ notices: GuardianNotice[] }>>("/guardian/notices");

  return unwrap(response).notices;
}

/** `GET /guardian/food`. Today's meals only. */
export async function getGuardianFood() {
  const response = await api.get<ApiEnvelope<{ food: GuardianMeal[] }>>("/guardian/food");

  return unwrap(response).food;
}

/** `GET /guardian/safety-summary`. Night status plus complaint titles. */
export async function getGuardianSafetySummary() {
  const response = await api.get<
    ApiEnvelope<{ complaints: GuardianComplaint[]; safety: GuardianSafety | null }>
  >("/guardian/safety-summary");

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Invitation                                                                 */
/* -------------------------------------------------------------------------- */

export type GuardianInvitationResult = {
  accepted: true;
  accountCreated: boolean;
  email: string;
  hostelName: string;
  /**
   * True when the account was created or upgraded by this call — credentials
   * were emailed and the guardian has to sign in with them. **No session is
   * issued here**, so the screen cannot drop the user straight into the app;
   * it hands off to login with the email prefilled.
   */
  requiresLogin: boolean;
};

/**
 * `POST /guardian/accept-invitation` — **on `publicApi`, deliberately.**
 *
 * The token in the emailed link is the only credential, and the route takes no
 * principal. Sending it on the authenticated client would attach whatever stale
 * token is on the device and, worse, run the 401 refresh-and-sign-out dance
 * against a route that never needed a session — logging out a guardian who was
 * merely opening a link.
 *
 * Single-use: accepting clears the token, so a second tap on the same link
 * returns `GUARDIAN_INVITATION_INVALID`, not a second acceptance.
 */
export async function acceptGuardianInvitation(input: { name?: string; token: string }) {
  const response = await publicApi.post<ApiEnvelope<GuardianInvitationResult>>(
    "/guardian/accept-invitation",
    input,
  );

  return unwrap(response);
}
