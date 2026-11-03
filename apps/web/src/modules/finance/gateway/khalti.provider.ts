import { FinanceServiceError } from "@/modules/finance/finance.errors";
import type {
  GatewayCredentials,
  GatewayProvider,
  PaymentIntent,
  PaymentIntentRequest,
  VerificationResult,
  WebhookClaim,
} from "@/modules/finance/gateway/provider.types";

/**
 * Khalti ePayment v2 (plan item 6.5).
 *
 * The second adapter, and the one that shows whether the interface was right:
 * Khalti is a JSON API where eSewa is a signed form POST, it identifies its
 * merchant by secret key alone where eSewa uses a product code, and it works in
 * **paisa** where every other number in this codebase is whole rupees. None of
 * that reached `provider.types.ts` — the differences are all inside this file,
 * which is what fixing the interface against the awkward provider first bought.
 *
 * **Amounts are in paisa.** NPR 12,000 is `1200000`. This is the single most
 * likely thing to get wrong here, and getting it wrong by a factor of a hundred
 * is not subtle: it either charges a resident a hundred times the rent or a
 * hundredth of it. Conversion happens at exactly two points, both below, and the
 * amount-mismatch guard in `intent.service.ts` catches the rest.
 */

const BASE_URLS = {
  live: "https://khalti.com/api/v2",
  sandbox: "https://dev.khalti.com/api/v2",
} as const;

const REQUEST_TIMEOUT_MS = 10_000;

/** Khalti's own default window, restated so the sweep does not outrun it. */
const INTENT_TTL_MS = 30 * 60 * 1000;

/** Khalti refuses anything under NPR 10, and says so unhelpfully. */
const MINIMUM_PAISA = 1000;

const PAISA_PER_RUPEE = 100;

function baseUrl(credentials: GatewayCredentials): string {
  return credentials.sandbox ? BASE_URLS.sandbox : BASE_URLS.live;
}

/**
 * `Key <secret>` — Khalti's scheme, not `Bearer`.
 *
 * A `Bearer` prefix returns a 401 that reads exactly like a wrong key, which is
 * an afternoon nobody needs to spend twice.
 */
async function postJson(
  url: string,
  body: unknown,
  credentials: GatewayCredentials,
): Promise<Record<string, unknown>> {
  let response: Response;

  try {
    response = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Key ${credentials.secret}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new FinanceServiceError(
      "Could not reach Khalti. Please try again in a moment.",
      "GATEWAY_UNREACHABLE",
    );
  }

  const text = await response.text();
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // An HTML error page. Unreachable for our purposes — reporting it as a
    // failed payment would close an attempt the resident may have completed.
    throw new FinanceServiceError(
      "Khalti returned an unreadable response.",
      "GATEWAY_UNREACHABLE",
    );
  }

  if (!response.ok) {
    // Khalti puts the useful part in `detail`, or in a per-field array.
    const detail =
      typeof parsed.detail === "string" ? parsed.detail : "Khalti rejected the request.";

    throw new FinanceServiceError(
      response.status >= 500 ? "Khalti is unavailable right now." : detail,
      response.status >= 500 ? "GATEWAY_UNREACHABLE" : "GATEWAY_VERIFICATION_FAILED",
    );
  }

  return parsed;
}

/**
 * Khalti's statuses, mapped onto the three that matter.
 *
 * `Initiated` and `Pending` both mean the resident may still be paying, so
 * neither closes the attempt. Everything else that is not a clean `Completed`
 * fails: an expired or cancelled attempt is not a payment, and a refunded one is
 * money that came back — crediting the invoice for it would leave the hostel
 * short by exactly that amount.
 */
function mapStatus(raw: string, refunded: boolean): VerificationResult["status"] {
  const status = raw.trim().toLowerCase();

  if (status === "completed") {
    return refunded ? "FAILED" : "SUCCESS";
  }

  if (status === "pending" || status === "initiated") {
    return "PENDING";
  }

  // Expired, User canceled, Refunded, Partially Refunded, and anything Khalti
  // adds later. An unrecognised state must never settle.
  return "FAILED";
}

export const khaltiProvider: GatewayProvider = {
  name: "KHALTI",

  /**
   * Asks Khalti to open a checkout, and gets back a URL to send the resident to.
   *
   * A `REDIRECT` handoff rather than eSewa's `FORM_POST`: Khalti has already
   * signed the attempt on its own side by the time it answers, so there is
   * nothing for the browser to carry.
   */
  async createIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
    const paisa = request.amount * PAISA_PER_RUPEE;

    if (paisa < MINIMUM_PAISA) {
      // Khalti's own rejection for this is a 400 with an opaque body, and the
      // resident sees it after committing to pay.
      throw new FinanceServiceError(
        `Khalti cannot take payments under NPR ${MINIMUM_PAISA / PAISA_PER_RUPEE}. Please use another method.`,
        "AMOUNT_OUT_OF_BOUNDS",
      );
    }

    const body = await postJson(
      `${baseUrl(request.credentials)}/epayment/initiate/`,
      {
        amount: paisa,
        purchase_order_id: request.reference,
        // Shown on Khalti's own screen. The reference code is what the resident
        // is asked to recognise, so it is what goes here.
        purchase_order_name: `Hostel invoice ${request.referenceCode}`,
        return_url: request.returnUrl,
        website_url: new URL(request.returnUrl).origin,
      },
      request.credentials,
    );

    const paymentUrl = String(body.payment_url ?? "");
    const pidx = String(body.pidx ?? "");

    if (!paymentUrl || !pidx) {
      throw new FinanceServiceError(
        "Khalti did not return a payment link.",
        "GATEWAY_UNREACHABLE",
      );
    }

    const expiresIn = Number(body.expires_in);

    return {
      expiresAt: new Date(
        Date.now() +
          (Number.isFinite(expiresIn) && expiresIn > 0
            ? expiresIn * 1000
            : INTENT_TTL_MS),
      ),
      handoff: { kind: "REDIRECT", url: paymentUrl },
      // Unlike eSewa, Khalti issues its id up front — and `verify` is keyed by
      // it, so storing it now is what makes the attempt verifiable later.
      providerRef: pidx,
    };
  },

  /**
   * Khalti sends no signed server-to-server callback, so there is nothing here
   * that could be verified — and this returns null for everything.
   *
   * What Khalti does send is a redirect back to the resident's browser carrying
   * `pidx`, `status` and an amount as plain query parameters, with no signature
   * of any kind. Accepting that as a callback would mean a stranger could POST
   * a `purchase_order_id` and make us call Khalti; harmless for money, since
   * `verify` is still the authority, but a free amplifier against our own rate
   * limit with the provider.
   *
   * Khalti attempts settle through the resident's authenticated status poll and
   * the expiry sweep, both of which call `verify`. Nothing is lost by refusing
   * the unsigned path, because the unsigned path was never evidence.
   */
  // Nothing to resolve either: the resident's return page polls `verify`.
  reference(): string | null {
    return null;
  },

  parseWebhook(): WebhookClaim | null {
    return null;
  },

  /**
   * Asks Khalti directly. **This is what settles money.**
   *
   * Keyed by `pidx`, which is why `createIntent` stores it. An attempt with no
   * `pidx` cannot be looked up at all — that would mean Khalti never opened the
   * checkout, so there is nothing that could have been paid.
   */
  async verify(
    attempt: { amount: number; providerTxnId: string | null; reference: string },
    credentials: GatewayCredentials,
  ): Promise<VerificationResult> {
    if (!attempt.providerTxnId) {
      return { amount: 0, providerTxnId: "", status: "FAILED" };
    }

    const body = await postJson(
      `${baseUrl(credentials)}/epayment/lookup/`,
      { pidx: attempt.providerTxnId },
      credentials,
    );

    const paisa = Number(body.total_amount);
    const status = mapStatus(String(body.status ?? ""), Boolean(body.refunded));

    return {
      // Back to whole rupees, and never rounded up: a fractional result means
      // Khalti reported something we did not ask for, and the caller's amount
      // check is what should catch it rather than arithmetic that hides it.
      amount: Number.isFinite(paisa) ? Math.floor(paisa / PAISA_PER_RUPEE) : Number.NaN,
      // `transaction_id` is the settled bank reference and is null until the
      // payment completes; `pidx` identifies the attempt either way.
      providerTxnId: String(body.transaction_id ?? "").trim() || attempt.providerTxnId,
      status,
    };
  },
};
