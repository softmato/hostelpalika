import "server-only";

import type { Invoice, Presentation } from "@softmato/sdk";

import { bsMonthsEnd } from "@hostel/shared/calendar/bs";

import { softmato } from "./client";
import { rupeesToPaisa } from "./money";
import { customerExternalRef, invoiceExternalRef } from "./refs";

/**
 * Raising the statutory invoice — the document the hostel actually receives.
 *
 * Softmato owns invoice numbering, the ledger and the PDF; we own who the
 * customer is and what plan they bought. So `SubscriptionInvoice` stays the
 * record of *our* obligation to be paid, and this raises the paper that says
 * so under the parent company's name and PAN.
 *
 * ## Two numbers, and both are kept
 *
 * Ours (`SUB-2609-0001-4F2A`) is allocated first and is what our own screens,
 * emails and indexes quote. Theirs (`INV-2083/84-000010`) carries the fiscal
 * year and the ledger sequence, and is what the customer's accountant will ask
 * about. Neither replaces the other, and the link between them is
 * `external_ref` — derived from ours, so there is nothing to keep in sync.
 *
 * ## Calling this twice is the normal path
 *
 * `external_ref` is unique per application and **a repeat returns the invoice
 * that already exists**. A Pay-now clicked twice, a retry after a dropped
 * connection, a process that died between our write and theirs — all of them
 * land here again with the same reference and get the same invoice back. That
 * is why this is `ensure`, not `create`: the caller is not expected to know
 * whether it has run before.
 *
 * ## No amount is ever sent from a client
 *
 * `unit_price_minor` comes from the subscription's snapshotted `cycleTotal`,
 * read on the server. Nothing in a request body reaches it.
 */

export interface EnsureInvoiceInput {
  /** Whole rupees. The obligation, snapshotted when the plan was chosen. */
  amount: number;
  /** Our own number. Becomes the `external_ref`. */
  invoiceNumber: string;
  customer: {
    email?: string;
    hostelId: string;
    name: string;
  };
  /** What the line says on the document. */
  description: string;
  dueAt?: Date | null;
  presentation?: Presentation;
  /** The period this invoice pays for. Drives their deferred revenue. */
  serviceEndsAt?: Date | null;
  serviceStartsAt?: Date | null;
}

export async function ensureSoftmatoInvoice(
  input: EnsureInvoiceInput,
): Promise<Invoice> {
  return softmato().createInvoice({
    customer: {
      external_ref: customerExternalRef(input.customer.hostelId),
      name: input.customer.name,
      ...(input.customer.email ? { email: input.customer.email } : {}),
    },
    external_ref: invoiceExternalRef(input.invoiceNumber),
    lines: [
      {
        description: input.description,
        quantity: 1,
        unit_price_minor: rupeesToPaisa(input.amount),
      },
    ],
    // Only a due date still ahead. An overdue invoice (or the balance document
    // for one) carries a date that has passed, and that is not one to send.
    ...(input.dueAt && input.dueAt.getTime() > Date.now()
      ? { due_at: input.dueAt.toISOString() }
      : {}),
    ...(input.presentation ? { presentation: input.presentation } : {}),
    // Both ends or neither — Softmato refuses a half-open period with
    // VALIDATION_FAILED, which is what broke every lifetime checkout.
    ...(input.serviceStartsAt && input.serviceEndsAt
      ? {
          service_ends_at: input.serviceEndsAt.toISOString(),
          service_starts_at: input.serviceStartsAt.toISOString(),
        }
      : {}),
  });
}

/**
 * The period an invoice pays for.
 *
 * Starts where the paid period currently ends, so a renewal bought early
 * extends rather than overlaps — otherwise an owner who pays a week ahead of
 * time buys a week they already had. Falls back to now for a first purchase,
 * and for a subscription whose period has already lapsed.
 *
 * ## Bikram Sambat months, ending on a Nepal day
 *
 * A monthly plan taken on Bhadra 26 runs **through Aswin 25**, and `endsAt` is
 * the last instant of that day in Kathmandu — the same shape as a due
 * (`graceDeadline`), so a count of days left on it moves at midnight and never
 * mid-afternoon. It used to be `setMonth` on the purchase instant: 11 September
 * to 11 October at 11:15, thirty days where the owner's own calendar has 31,
 * ending partway through a day nobody could name.
 */
export function servicePeriod(
  cycleMonths: number,
  currentPeriodEnd: Date | null | undefined,
  now: Date = new Date(),
): { endsAt: Date; startsAt: Date } {
  const startsAt =
    currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime()
      ? new Date(currentPeriodEnd.getTime() + 1)
      : new Date(now);

  return { endsAt: bsMonthsEnd(startsAt, cycleMonths), startsAt };
}
