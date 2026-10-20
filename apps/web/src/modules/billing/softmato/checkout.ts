import "server-only";

import type { CheckoutSession } from "@softmato/sdk";

import { outboundUrl } from "@/lib/site";

import { softmato } from "./client";

/**
 * Sending the owner off to pay, and where they land coming back.
 *
 * ## A session is a cheque, not a link
 *
 * It lives 30 minutes and it is bearer-ish: forwarded, reused, or paid after
 * the price changed. So one is minted at the moment the owner presses Pay —
 * every time, including retries — and never stored, never emailed, never
 * pre-generated for a renewal that is a week away. The thing we persist is the
 * invoice; the thing we hand out is a fresh session against it.
 *
 * ## There is no amount parameter, deliberately
 *
 * The amount is read from the invoice on their side. A client-supplied one
 * would let anybody who can reach our endpoint choose their own price.
 *
 * ## The return URL carries no payment status
 *
 * Not because we forgot: **there is no status in it and never will be.** The
 * owner reaches that page by clicking, and they can reach it without paying.
 * What actually happened is learned from the webhook, or from a server-side
 * `getTransaction` — see `./transaction.ts`. Anything in the query string is a
 * claim made by whoever's browser made the request.
 *
 * The one thing we do put there is our own invoice number, so the page knows
 * which purchase the reader just came back from. That is a *navigation* hint
 * and it is treated as one: the page re-checks ownership against the session
 * before it shows anything, and shows the status it read from Softmato, not
 * from the URL.
 */

/**
 * Our host is registered against the credential at `admin.softmato.com`; the
 * path is ours. One return page serves every platform payment, told apart by
 * which reference it carries — `invoice` for a plan, `booking` for a booking.
 */
export function checkoutReturnUrl(ref: { booking: string } | { invoice: string }): string {
  const url = new URL(`${outboundUrl()}/checkout/return`);

  for (const [key, value] of Object.entries(ref)) url.searchParams.set(key, value);

  return url.toString();
}

export interface OpenCheckoutInput {
  /** Softmato's invoice id, from `ensureSoftmatoInvoice`. */
  softmatoInvoiceId: string;
  /** Ours, for the return link. */
  invoiceNumber: string;
  /** Where the payer lands instead of `/checkout/return` — the team form, for a pre-publish payment. */
  returnUrl?: string;
}

export async function openSoftmatoCheckout(
  input: OpenCheckoutInput,
): Promise<CheckoutSession> {
  return softmato().createCheckout({
    invoice_id: input.softmatoInvoiceId,
    return_url: input.returnUrl ?? checkoutReturnUrl({ invoice: input.invoiceNumber }),
  });
}
