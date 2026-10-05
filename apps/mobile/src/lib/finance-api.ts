/**
 * Resident finance, typed against the endpoints that actually exist.
 *
 * ⚠️ The pre-2026-08 mobile client called `GET /resident/payments` and
 * `POST /resident/payments/{id}/proof`. **Both routes are gone.** Finance was
 * rebuilt around invoices, claims and a gateway checkout, and the old paths
 * 404 — which is why the previous app's payments tab could never have worked.
 *
 * The current surface, all under `/api/v1/resident/finance`:
 *
 *   GET  /invoices                        every invoice + open claims + credit
 *   GET  /invoices/{id}/pay-instructions  where and how to pay this one
 *   POST /invoices/{id}/claims            "I have paid" + evidence
 *   POST /invoices/{id}/checkout          start an eSewa/Khalti/Fonepay handoff
 *   GET  /receipts/{id}/pdf               a settled payment's receipt
 *   GET  /statement/pdf                   the full statement
 *   GET  /checkout/{reference}            poll one checkout attempt
 *
 * Shapes mirror `apps/web/src/modules/finance/*`. If one changes there, it
 * changes here — there is no shared package between the two yet, so this file
 * is the seam.
 *
 * **The pay-instructions and checkout shapes were wrong until 2026-08-16.**
 * They were written from the endpoint names rather than from the services:
 * `PayInstructions` claimed `bankAccounts[]`/`wallets[]`/`qrAssetId` when the
 * server returns a single ordered, discriminated `methods[]`, and checkout
 * claimed a flat `{ url, fields, method }` when it returns
 * `{ handoff, reference, ... }`. Both would have failed at runtime on the first
 * real call. The rule that catches this is: read the *service*, not the route.
 */

import { API_BASE_URL, api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/* -------------------------------------------------------------------------- */
/* Invoices                                                                   */
/* -------------------------------------------------------------------------- */

/** Matches `PortalInvoice & { receipts, referenceCode }`. */
/**
 * One line of the breakdown — what the month is made of.
 *
 * Everything here is snapshotted on the invoice when it is issued, so a
 * historical month stays correct after every fee schedule it came from is
 * closed. `amount` is **signed**: a credit line is negative, and rendering its
 * absolute value would show a refund as a second charge.
 */
export type InvoiceLine = {
  amount: number;
  /** SCHEDULE | OVERRIDE | MANUAL | CREDIT — how the amount was arrived at. */
  basis: string;
  bedType: string | null;
  description: string;
  /** e.g. `"18/31 days"`. The whole reason a first month costs less. */
  prorationBasis: string | null;
};

export type ResidentInvoice = {
  dueAmount: number;
  dueDate?: string;
  id: string;
  /** Empty on migrated history, which predates the line breakdown. */
  lines: InvoiceLine[];
  method?: string;
  /**
   * `YYYY-MM`, or `null` for an invoice that belongs to no month — an admission
   * fee is the one every resident gets. The server has always been able to send
   * this (`Invoice.period` is nullable) and the type used to deny it; every
   * screen already reads it through `formatPeriod`, which renders a dash.
   */
  month: string | null;
  paidAmount: number;
  paidDate?: string;
  receipts: {
    amount: number;
    /** Set when the receipt is certified under the Resident Offer Program. */
    certificationCode: string | null;
    id: string;
    issuedAt: string | null;
    number: string;
  }[];
  /**
   * The code to put in the bank transfer's remarks. Shown on the list, not just
   * behind "Pay now" — a resident paying from their banking app out of habit
   * never opens that screen, and a payment with no code has to be matched by hand.
   */
  referenceCode: string | null;
  status: string;
};

/**
 * One proof the resident has submitted, as the server actually sends it.
 *
 * ## This type was wrong about two of its five fields
 *
 * It declared `id` and `createdAt`. The route returns a `ReviewQueueRow` —
 * `listResidentClaims` filters the *admin* review queue down to this resident
 * and hands the rows straight through — and that row calls them **`eventId`**
 * and **`occurredAt`**. Neither `id` nor `createdAt` has ever been on the wire.
 *
 * So every claim row in the app was keyed on `undefined`, and every claim's date
 * rendered as nothing: the Payments tab printed "Date not recorded" under a
 * claim submitted ten seconds earlier, and the invoice screen printed no date at
 * all. `(admin)/alerts.tsx` reads `claim.eventId` off the same shape and was
 * right the whole time, which is what makes the mismatch findable.
 *
 * This is the failure mode this codebase keeps hitting — **read the service, not
 * the hand-written type**. The three fields below the fold were already being
 * sent too, and dropping them cost the resident the one thing they most needed
 * to be told.
 */
export type ResidentClaim = {
  amount: number;
  /** The `PaymentEvent`'s id. Named `id` in this type until 2026-09-05. */
  eventId: string;
  invoiceId: string | null;
  /**
   * How the resident said they paid — `ESEWA`, `BANK_TRANSFER`, `CASH`…
   *
   * Server-side it is `METHOD_BY_PROVIDER[event.provider]`, so it is the claim's
   * own assertion rather than anything verified. Worth showing regardless: a
   * resident scanning their pending claims identifies them by what they did, not
   * by an amount that is the same every month.
   */
  method: string;
  /** Named `createdAt` in this type until 2026-09-05. */
  occurredAt?: string;
  /** `YYYY-MM` of the invoice claimed against, or `null` for a one-off. */
  period: string | null;
  /**
   * Why a `REJECTED` claim was turned down. `null` on every other status.
   *
   * The server's own comment on this field says it exists *for this screen*:
   * "without the reason a rejection is invisible to them: their card kept saying
   * 'your hostel is checking it' forever, so the one person who has to act on
   * the decision was the only one not told about it." The field shipped; the
   * client never read it, so the bug it was written to fix stayed open.
   */
  rejectionReason: string | null;
  status: string;
  /** What the resident typed into the transaction-code field, if anything. */
  transactionCode: string | null;
};

export type ResidentFinanceView = {
  claims: ResidentClaim[];
  /** Carried from an overpayment. Usually 0; show it only when it is not. */
  credit: number;
  invoices: ResidentInvoice[];
};

export async function getFinanceView() {
  const response = await api.get<ApiEnvelope<ResidentFinanceView>>(
    "/resident/finance/invoices",
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Pay instructions                                                           */
/* -------------------------------------------------------------------------- */

export type GatewayProvider = "ESEWA" | "FONEPAY" | "KHALTI";

/**
 * One way this hostel can be paid.
 *
 * A discriminated union, and the server sends them **already ordered and
 * already filtered** to what the hostel configured: live checkouts first
 * (they settle themselves and need no screenshot), then QR, then wallet ids,
 * then bank. So `methods[0]` is the primary path — the client renders the
 * ranking rather than inventing one that can drift out of step with it.
 */
export type PayMethod =
  | { accountName: string | null; accountNumber: string; bankName: string | null; kind: "BANK" }
  | { assetId: string; kind: "QR"; notice: string | null }
  | { id: string; kind: "ESEWA" }
  | { id: string; kind: "KHALTI" }
  | { kind: "GATEWAY"; provider: GatewayProvider; sandbox: boolean };

export type PayInstructions = {
  /** What is still owed — never the invoice total once part of it is settled. */
  amountDue: number;
  /** "Triple sharing". Read off the invoice, so a resident who has since moved
   *  rooms still sees what *this* month was priced at. */
  bedLabel: string | null;
  /** Late fine and khata on this bill. Optional: an older API sends none. */
  extras?: { amount: number; basis: string; description: string }[];
  /** Carried from an earlier overpayment. Shown **above** the amount: a credit
   *  read after the number is a credit already ignored. */
  credit: number;
  displayName: string | null;
  dueDate: string | null;
  instructions: string | null;
  invoiceId: string;
  /** Empty when the hostel has not set up a single way to be paid. */
  methods: PayMethod[];
  period: string | null;
  referenceCode: string | null;
  status: string;
  tier: "TIER_0" | "TIER_1";
  /** False means: tell the resident their hostel has not set this up. */
  usable: boolean;
};

export async function getPayInstructions(invoiceId: string) {
  const response = await api.get<ApiEnvelope<PayInstructions>>(
    `/resident/finance/invoices/${invoiceId}/pay-instructions`,
  );

  return unwrap(response);
}

/**
 * The private asset route, used for the hostel's static payment QR.
 *
 * Authorised, so it cannot be handed to a bare `<Image src>` — the caller
 * attaches the bearer token via `expo-image`'s `headers`.
 */
export function fileAssetUrl(assetId: string) {
  return `${API_BASE_URL}/api/v1/files/${assetId}/url`;
}

/* -------------------------------------------------------------------------- */
/* Claims                                                                     */
/* -------------------------------------------------------------------------- */

/** `claim.validation.ts` — note there is no `CHEQUE`, and `OTHER` does exist. */
export const PAYMENT_METHODS = [
  "ESEWA",
  "KHALTI",
  "FONEPAY",
  "BANK_TRANSFER",
  "CASH",
  "OTHER",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Submit a payment claim.
 *
 * `proofImageAssetId` comes from the upload pipeline in `lib/uploads.ts` — the
 * server validates the asset is real, unused and owned by the caller, so a
 * fabricated id is refused rather than trusted.
 *
 * `amount` must be a **whole rupee integer**: whole rupees are the ledger's
 * foundation (ADR-1) and the schema rejects a fractional claim at the boundary.
 *
 * The server is idempotent here: a replayed submit collapses onto the existing
 * claim and comes back `created: false` with a 200 instead of a second 201.
 * Show that as "already submitted", not as a fresh success.
 *
 * Rate-limited to 8 an hour — every submit runs OCR over a full-size
 * screenshot — so a retry loop on failure is not an acceptable client design.
 */
export async function submitClaim(
  invoiceId: string,
  input: {
    amount: number;
    paidAt?: string;
    paymentMethod: PaymentMethod;
    proofImageAssetId: string;
    referenceNote?: string;
    transactionCode?: string;
  },
) {
  const response = await api.post<ApiEnvelope<{ claimId?: string; created: boolean }>>(
    `/resident/finance/invoices/${invoiceId}/claims`,
    input,
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Gateway checkout                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the resident's screen does with a started checkout.
 *
 * - `REDIRECT` — open the URL. Khalti.
 * - `FORM_POST` — the provider needs a *signed HTML form POST*, with the fields
 *   surviving to the browser exactly as the adapter emitted them, in order.
 *   eSewa's v2 checkout works this way. There is no way to perform one from
 *   `expo-web-browser`, which can only open a URL — see `lib/checkout.ts`.
 * - `QR` — a payload to render as a QR code. Fonepay's dynamic QR, once
 *   credentials exist.
 */
export type IntentHandoff =
  | { fields: Record<string, string>; kind: "FORM_POST"; url: string }
  | { kind: "QR"; payload: string }
  | { kind: "REDIRECT"; url: string };

export type PaymentIntentView = {
  amount: number;
  expiresAt: string;
  handoff: IntentHandoff;
  intentId: string;
  provider: GatewayProvider;
  reference: string;
  /** True while a test merchant is in use. The screen must say so, loudly. */
  sandbox: boolean;
  status: string;
};

/**
 * Start a gateway checkout.
 *
 * The response is a *handoff*, never a settlement — a URL to open, a form to
 * post, a QR to render. The money is not on the ledger until the provider has
 * been asked directly and agreed, so the app must poll `getCheckoutStatus`
 * rather than assume success when the browser returns.
 */
export async function startCheckout(invoiceId: string, provider: GatewayProvider) {
  const response = await api.post<ApiEnvelope<PaymentIntentView>>(
    `/resident/finance/invoices/${invoiceId}/checkout`,
    { provider },
  );

  return unwrap(response);
}

export type CheckoutStatus = {
  amount: number;
  expiresAt: string;
  invoiceId: string;
  provider: GatewayProvider;
  reference: string;
  sandbox: boolean;
  /** The only field that means the money landed. `status` alone does not. */
  settled: boolean;
  status: string;
};

/**
 * Poll one attempt.
 *
 * Visiting this settles nothing by itself: the service asks the provider
 * directly and only a provider that agrees moves the ledger. Which is why the
 * app is free to poll it as often as it likes without being an authority.
 */
export async function getCheckoutStatus(reference: string) {
  const response = await api.get<ApiEnvelope<CheckoutStatus>>(
    `/resident/finance/checkout/${encodeURIComponent(reference)}`,
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * PDFs are streamed with the bearer token, so they cannot be handed to a plain
 * `Linking.openURL` — these return the absolute URL, and the caller downloads
 * with the auth header via `expo-file-system` before sharing.
 */
export function receiptPdfUrl(receiptId: string) {
  return `${API_BASE_URL}/api/v1/resident/finance/receipts/${receiptId}/pdf`;
}

export function statementPdfUrl() {
  return `${API_BASE_URL}/api/v1/resident/finance/statement/pdf`;
}
