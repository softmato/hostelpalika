/**
 * The interface every payment provider implements (target §6.5, plan §4.2).
 *
 * Written before any provider exists, and that is deliberate: Fonepay, eSewa and
 * Khalti all follow the same shape — merchant code plus shared secret, initiate
 * → redirect or QR → **server-side lookup** — and fixing the shape first is what
 * stops the second integration from being a copy of the first with the names
 * changed.
 *
 * Three rules are encoded in the types rather than left to each implementation:
 *
 * 1. **`verify` is not optional.** Target §6.5 step 7c: never trust the webhook
 *    body alone. A provider that cannot be independently asked "did this
 *    transaction really happen, for this amount" cannot be integrated, because
 *    the alternative is settling money on the word of an unauthenticated POST.
 * 2. **`parseWebhook` returns a reference, never a settlement.** It says what the
 *    payload *claims*; `verify` says what is true. Keeping them separate is what
 *    makes the rule above impossible to skip by accident.
 * 3. **The return URL is absent from this interface entirely.** It is guessable
 *    and carries no authority, and its only job is to show a "checking…" state.
 *    Giving it no seam here means no provider can grow one.
 */

export type { GatewayProviderName } from "@hostel/db/models/HostelPaymentProfile";

import type { GatewayProviderName } from "@hostel/db/models/HostelPaymentProfile";

/** Resolved per hostel and provider by `secret-store.ts`. Never logged, never serialised. */
export type GatewayCredentials = {
  /** eSewa's product code, Fonepay's merchant code. Empty for Khalti. */
  merchantCode: string;
  /** Carried so an adapter cannot be handed another provider's credentials. */
  provider: GatewayProviderName;
  /** Signs our requests and verifies their callbacks. */
  secret: string;
  /**
   * Separate webhook secret where the provider issues one. Falls back to
   * `secret` for providers that sign with a single shared key.
   */
  webhookSecret: string;
  /** True while the sandbox credentials are in use — surfaced in the UI. */
  sandbox: boolean;
};

/** What we ask the provider to collect. */
export type PaymentIntentRequest = {
  amount: number;
  credentials: GatewayCredentials;
  /** Where the provider should POST its callback. Ours, registered with them. */
  callbackUrl: string;
  /** Where the resident lands when they abandon or the payment fails. */
  failureUrl: string;
  invoiceId: string;
  /**
   * Our per-attempt merchant reference — `{referenceCode}-{attempt}`.
   *
   * Not the bare reference code: a provider rejects a repeated merchant
   * reference, so a resident who abandons a payment and tries again would be
   * unable to pay at all. The attempt suffix is what makes a retry a new
   * transaction to them while staying traceable to one invoice for us.
   */
  reference: string;
  /** Our reference code (target §5), for display on the provider's own screen. */
  referenceCode: string;
  /** Where the resident's browser lands afterwards. Settles nothing. */
  returnUrl: string;
  /** Distinguishes retries of the same invoice; part of the idempotency key. */
  attempt: number;
};

/**
 * How the resident's browser is handed to the provider.
 *
 * Three shapes because the providers genuinely differ, and flattening them into
 * one would mean every adapter filling fields that mean nothing to it:
 *
 * - `REDIRECT` — we have a URL to send the browser to. Khalti returns one.
 * - `FORM_POST` — the provider takes a signed HTML form POST, not a GET with
 *   query parameters. eSewa's v2 checkout works this way, and the signature
 *   covers only some of the fields, in a declared order, so the fields must
 *   survive to the browser exactly as the adapter emitted them.
 * - `QR` — a payload we render as a QR code for the resident to scan. Fonepay's
 *   dynamic QR, once credentials exist.
 */
export type IntentHandoff =
  | { kind: "REDIRECT"; url: string }
  | { kind: "FORM_POST"; url: string; fields: Record<string, string> }
  | { kind: "QR"; payload: string };

export type PaymentIntent = {
  /** When this intent stops being payable. Drives the countdown and the sweep. */
  expiresAt: Date;
  /** Deep links into wallet apps, where the provider offers them. */
  deeplinks?: { label: string; url: string }[];
  /** What the resident's screen does with this intent. */
  handoff: IntentHandoff;
  /** The provider's own transaction id for this attempt, if issued up front. */
  providerRef: string | null;
};

/**
 * What a webhook body claims, once its signature has verified.
 *
 * Deliberately thin. Anything richer would invite a caller to settle from it,
 * which is the one thing target §6.5 forbids.
 */
export type WebhookClaim = {
  amount: number;
  providerTxnId: string;
  /** Our per-attempt merchant reference, echoed back by the provider. */
  reference: string | null;
};

/** The provider's own answer, obtained by calling them. This is what settles. */
export type VerificationResult = {
  amount: number;
  providerTxnId: string;
  /** Only `SUCCESS` may settle. Anything else is recorded and left pending. */
  status: "FAILED" | "PENDING" | "SUCCESS";
};

export type SettlementRecord = {
  amount: number;
  providerTxnId: string;
  settledAt: Date;
};

export type GatewayProvider = {
  name: GatewayProviderName;

  /** Creates a payment attempt and returns what the resident's screen renders. */
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;

  /**
   * Verifies the callback's signature and extracts its claim.
   *
   * Returns null for anything that does not verify — an unsigned body, a bad
   * signature, an unparseable payload. The caller's only correct response to
   * null is to reject the request, so there is nothing else to distinguish.
   */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
    credentials: GatewayCredentials,
  ): WebhookClaim | null;

  /**
   * Reads the attempt reference out of a callback without checking anything,
   * only to find whose keys verify it. Running `parseWebhook` with an empty
   * secret for this dropped every eSewa callback (P8-5).
   */
  reference(rawBody: string): string | null;

  /**
   * Asks the provider directly what happened. **This is what settles money.**
   *
   * Called even when the webhook signature verified, because a valid signature
   * proves the message came from the provider — not that the payment succeeded,
   * nor that the amount in the body is the amount that moved.
   *
   * Takes the whole attempt rather than an id, because the providers key their
   * status lookups differently: Khalti by its own `pidx`, eSewa by *our*
   * reference plus the amount, which it treats as part of the query rather than
   * something to be told back to us.
   */
  verify(
    attempt: {
      /** What we asked for. eSewa requires it in the status query itself. */
      amount: number;
      /** The provider's id, once one exists. Null before their first response. */
      providerTxnId: string | null;
      /** Our per-attempt merchant reference — `{referenceCode}-{attempt}`. */
      reference: string;
    },
    credentials: GatewayCredentials,
  ): Promise<VerificationResult>;

  /**
   * The provider's settlement report for a date range (target §10.2).
   *
   * The only thing that catches a webhook endpoint quietly returning 500 for a
   * week — every other signal looks identical to "nobody paid".
   */
  listSettlements?(
    range: { from: Date; to: Date },
    credentials: GatewayCredentials,
  ): Promise<SettlementRecord[]>;
};
