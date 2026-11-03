import { createHmac } from "node:crypto";

import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { secretsMatch } from "@/modules/finance/gateway/envelope-crypto";
import type {
  GatewayCredentials,
  GatewayProvider,
  PaymentIntent,
  PaymentIntentRequest,
  VerificationResult,
  WebhookClaim,
} from "@/modules/finance/gateway/provider.types";

/**
 * eSewa ePay v2 (plan item 6.3).
 *
 * The first adapter, and deliberately so: eSewa's test merchant is published in
 * their own developer documentation, so this can be built and exercised without
 * waiting on anyone. It is also the *least* convenient of the three shapes — a
 * signed HTML form POST rather than a JSON API, with a signature over a declared
 * subset of fields in a declared order — so fixing the interface against it means
 * the JSON providers drop in rather than bending it.
 *
 * **eSewa has no server-to-server webhook in v2.** The confirmation comes back
 * on the resident's return URL as a base64 `data` parameter, signed the same way
 * our request was. {@link parseWebhook} verifies that payload — which lets us
 * identify *which attempt* the browser is reporting — and nothing more. The
 * status API is still what settles, exactly as it would be for a real webhook,
 * because a payload that arrives via the resident's own browser is the last thing
 * that should be trusted about money.
 */

const ENDPOINTS = {
  live: {
    form: "https://epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://esewa.com.np/api/epay/transaction/status/",
  },
  sandbox: {
    form: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://rc.esewa.com.np/api/epay/transaction/status/",
  },
} as const;

/**
 * The fields eSewa signs, in the order it signs them.
 *
 * Order is part of the algorithm, not a formatting choice: the signature is an
 * HMAC over `key=value` pairs joined in exactly this sequence. Sorting them, or
 * building the string from an object's own key order, produces a signature eSewa
 * rejects — with an error that says nothing about why.
 */
const SIGNED_FIELDS = ["total_amount", "transaction_uuid", "product_code"] as const;

/** eSewa's callback: JSON, or the base64 `data` it appends to the success URL. */
function esewaPayload(rawBody: string): Record<string, unknown> | null {
  try {
    const text = rawBody.trim().startsWith("{")
      ? rawBody
      : Buffer.from(rawBody.trim(), "base64").toString("utf8");

    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** eSewa's own timeout is generous; ours is not. A hung verify blocks a resident. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long a checkout stays payable. eSewa states no window, so this is ours. */
const INTENT_TTL_MS = 15 * 60 * 1000;

function endpointsFor(credentials: GatewayCredentials) {
  return credentials.sandbox ? ENDPOINTS.sandbox : ENDPOINTS.live;
}

/**
 * `HMAC-SHA256(secret, "k1=v1,k2=v2,...")`, base64.
 *
 * Shared by signing our request and checking theirs, so the two can never drift
 * into disagreeing about the format — which is the failure mode where every
 * payment silently stops verifying.
 */
function sign(
  fields: readonly string[],
  values: Record<string, string>,
  secret: string,
): string {
  const message = fields.map((field) => `${field}=${values[field] ?? ""}`).join(",");

  return createHmac("sha256", secret).update(message).digest("base64");
}

/**
 * eSewa returns amounts with thousands separators — `"1,000.0"` — and rupee
 * amounts as decimals. Parsed to a whole number because the ledger holds whole
 * rupees, and a comma left in place makes `Number()` return NaN, which would
 * compare unequal to every amount and quietly refuse every settlement.
 */
function parseAmount(raw: unknown): number {
  const value = Number(String(raw ?? "").replace(/,/g, "").trim());

  return Number.isFinite(value) ? Math.round(value) : Number.NaN;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new FinanceServiceError(
      "Could not reach eSewa. Please try again in a moment.",
      "GATEWAY_UNREACHABLE",
    );
  }

  const body = await response.text();

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    // A gateway that answers with an HTML error page is unreachable for our
    // purposes. Reporting it as a failed payment would close an attempt the
    // resident may well have completed.
    throw new FinanceServiceError(
      "eSewa returned an unreadable response.",
      "GATEWAY_UNREACHABLE",
    );
  }
}

/**
 * eSewa's transaction states, mapped onto the only three that matter here.
 *
 * `AMBIGUOUS` is the one worth naming: it is eSewa saying *they* do not know,
 * and it maps to PENDING rather than either extreme. Calling it a success credits
 * money that may not exist; calling it a failure writes off a payment the
 * resident may have made. Leaving it open is the only honest answer, and the
 * expiry sweep will ask again.
 *
 * The refund states deliberately do **not** settle. The money came back, so
 * crediting the invoice for it would leave the hostel short by exactly that
 * amount.
 */
function mapStatus(raw: string): VerificationResult["status"] {
  switch (raw.toUpperCase()) {
    case "COMPLETE":
      return "SUCCESS";
    case "PENDING":
    case "AMBIGUOUS":
      return "PENDING";
    default:
      // CANCELED, NOT_FOUND, FULL_REFUND, PARTIAL_REFUND, and anything eSewa
      // adds later. An unrecognised state must never settle.
      return "FAILED";
  }
}

export const esewaProvider: GatewayProvider = {
  name: "ESEWA",

  /**
   * Builds the signed form eSewa's checkout expects.
   *
   * Returned as fields rather than posted from here: the resident's browser has
   * to be the thing that arrives at eSewa, or their session with eSewa is ours
   * and the payment cannot complete. `FORM_POST` exists in the handoff type for
   * exactly this.
   */
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
    const amount = String(request.amount);
    const values: Record<string, string> = {
      amount,
      failure_url: request.failureUrl,
      product_code: request.credentials.merchantCode,
      product_delivery_charge: "0",
      product_service_charge: "0",
      signed_field_names: SIGNED_FIELDS.join(","),
      success_url: request.returnUrl,
      tax_amount: "0",
      total_amount: amount,
      transaction_uuid: request.reference,
    };

    values.signature = sign(SIGNED_FIELDS, values, request.credentials.secret);

    return Promise.resolve({
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      handoff: {
        fields: values,
        kind: "FORM_POST",
        url: endpointsFor(request.credentials).form,
      },
      // eSewa issues its transaction code only on completion, so there is
      // nothing to record yet. The reference we generated is the link until then.
      providerRef: null,
    });
  },

  /**
   * Verifies the signed payload eSewa hands back through the resident's browser.
   *
   * Accepts either the raw base64 `data` parameter or the decoded JSON, because
   * the caller should not have to know which eSewa sent. Returns null for
   * anything that does not verify, and the caller's only correct response to
   * null is to reject.
   */
  reference(rawBody: string): string | null {
    return String(esewaPayload(rawBody)?.transaction_uuid ?? "").trim() || null;
  },

  parseWebhook(
    rawBody: string,
    _headers: Record<string, string>,
    credentials: GatewayCredentials,
  ): WebhookClaim | null {
    const payload = esewaPayload(rawBody);

    if (!payload || !credentials.secret) {
      return null;
    }

    const claimed = String(payload.signature ?? "");
    // eSewa declares which fields it signed, and the set differs from the one we
    // sign. Reading it from the payload rather than hard-coding it is what keeps
    // this working when they add a field.
    const fields = String(payload.signed_field_names ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);

    if (!claimed || fields.length === 0) {
      return null;
    }

    const values: Record<string, string> = {};

    for (const field of fields) {
      values[field] = String(payload[field] ?? "");
    }

    // Constant-time: `===` on an HMAC leaks the correct digest one byte at a
    // time through timing, and it is a mistake made once and never noticed.
    if (!secretsMatch(claimed, sign(fields, values, credentials.secret))) {
      return null;
    }

    const reference = String(payload.transaction_uuid ?? "").trim();

    if (!reference) {
      return null;
    }

    return {
      amount: parseAmount(payload.total_amount),
      providerTxnId: String(payload.transaction_code ?? "").trim(),
      reference,
    };
  },

  /**
   * Asks eSewa directly. **This is what settles money.**
   *
   * Keyed by our own reference plus the amount rather than by eSewa's
   * transaction code, because eSewa's status endpoint is defined that way — and
   * usefully so: it means an attempt can be verified even when we never received
   * a transaction code, which is exactly the situation after a dropped callback.
   */
  async verify(
    attempt: { amount: number; providerTxnId: string | null; reference: string },
    credentials: GatewayCredentials,
  ): Promise<VerificationResult> {
    const query = new URLSearchParams({
      product_code: credentials.merchantCode,
      total_amount: String(attempt.amount),
      transaction_uuid: attempt.reference,
    });

    const body = await getJson(`${endpointsFor(credentials).status}?${query}`);
    const status = mapStatus(String(body.status ?? ""));

    return {
      // eSewa's own figure, never the one we asked for: the caller compares the
      // two, and handing back our own number would make that check tautological.
      amount: parseAmount(body.total_amount),
      providerTxnId:
        String(body.ref_id ?? "").trim() ||
        attempt.providerTxnId ||
        attempt.reference,
      status,
    };
  },
};
