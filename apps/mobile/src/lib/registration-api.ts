/**
 * The two public applications: register a hostel, join the service directory.
 *
 * Both go through `api`, the **authenticated** client, and that is deliberate on
 * each side even though only one of the two routes demands it:
 *
 * - `POST /public/service-providers/register` calls `requireApiPrincipal` and
 *   401s without a session. Approval upgrades that very account to
 *   `SERVICE_PROVIDER`, so an application filed by nobody is an application
 *   nobody can be approved for.
 * - `POST /public/hostels/register` calls `loadApiPrincipal`, which tolerates a
 *   missing session — but when there *is* one it links the application to the
 *   account, and that link is what makes `/public/hostel-applications/
 *   my-applications` able to tell an owner what happened to their submission.
 *   Filing anonymously means the owner watches an empty screen and waits for an
 *   email.
 *
 * So both screens require a session before they open the form. That is a
 * requirement this app adds to the hostel route, not one the server imposes, and
 * it is the same requirement the website's own `<AuthGuard>` puts on
 * `/register-hostel/form`.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { Coordinates } from "@/lib/geo";
import type { HostelRegisterPayload } from "@/lib/hostel-registration";
import type { ProviderRegisterPayload } from "@/lib/provider-registration";

/* -------------------------------------------------------------------------- */
/* Hostel registration                                                        */
/* -------------------------------------------------------------------------- */

export type HostelApplicationStatus =
  | "APPROVED"
  | "INFO_REQUESTED"
  | "PENDING"
  | "REJECTED";

/**
 * One of the caller's own applications, as
 * `GET /public/hostel-applications/my-applications` returns it.
 *
 * Typed from `listOwnerHostelApplications` + `serializeApplication`, not from the
 * route file. The two fields worth knowing about:
 *
 * - **`requestedDocuments`** is the reviewer asking for something specific.
 *   `INFO_REQUESTED` with an empty list would be a dead end, which is why the
 *   note rides along with it.
 * - **`hostelStatus`** is the hostel record's status, not the application's.
 *   They diverge: an application can be `APPROVED` while the hostel is still
 *   `PENDING_APPROVAL` for publication.
 */
export type OwnHostelApplication = {
  hostelId: string;
  hostelName: string;
  hostelStatus: string;
  id: string;
  infoRequestNote: string;
  rejectionReason: string;
  requestedDocuments: { documentType: string; note: string }[];
  status: HostelApplicationStatus;
  submittedAt: string;
  verificationStatus: string;
};

export async function listOwnHostelApplications() {
  const response = await api.get<ApiEnvelope<{ applications: OwnHostelApplication[] }>>(
    "/public/hostel-applications/my-applications",
  );

  return unwrap(response).applications;
}

/** One match from the location lookup — `GeocodeResult` in `apps/web/src/lib/maps/types.ts`. */
export type LocationMatch = {
  address?: { address?: string; area?: string; city?: string; province?: string };
  coordinates: Coordinates;
  label?: string;
};

/**
 * `GET /public/hostels/register/geocode` — the lookup behind the application's
 * map pin, both ways round.
 *
 * - `{ q }`: a place, a landmark, or a pasted Google Maps link. Links are
 *   resolved on the server because a `maps.app.goo.gl` short link carries no
 *   coordinates until its redirect is followed. `near` is the typed address, so
 *   a bare hostel name has a neighbourhood to be searched in.
 * - `{ lat, lng }`: which address a placed pin sits on.
 */
export async function lookupRegistrationLocation(
  params: { near?: string; q: string } | Coordinates,
) {
  const response = await api.get<ApiEnvelope<{ results: LocationMatch[] }>>(
    "/public/hostels/register/geocode",
    { params },
  );

  return unwrap(response).results;
}

/** What a hostel referral code gives — `GET /public/hostel-referral-codes/:code`. */
export type HostelReferralPreview = {
  code: string;
  from: string;
  kind: "HOSTEL" | "PARTNER";
  rewardText: string;
};

export async function previewHostelReferralCode(code: string) {
  const response = await api.get<ApiEnvelope<HostelReferralPreview>>(
    `/public/hostel-referral-codes/${encodeURIComponent(code.trim())}`,
  );

  return unwrap(response);
}

export async function registerHostelApplication(payload: HostelRegisterPayload) {
  const response = await api.post<
    ApiEnvelope<{ hostel: { id: string; name?: string } }>
  >("/public/hostels/register", payload);

  return unwrap(response).hostel;
}

/* -------------------------------------------------------------------------- */
/* Service-provider registration                                              */
/* -------------------------------------------------------------------------- */

/**
 * `POST /public/service-providers/register`.
 *
 * A 409 here is not a failure to handle generically: it means this account
 * already has a live application, and the screen answers it by showing that
 * application's status rather than by printing an error over an empty form. See
 * `getOwnProvider` in `lib/provider-api.ts`, which is the same fact fetched
 * before the form opens.
 */
export async function registerServiceProvider(payload: ProviderRegisterPayload) {
  const response = await api.post<ApiEnvelope<{ provider: { id: string } }>>(
    "/public/service-providers/register",
    payload,
  );

  return unwrap(response).provider;
}
