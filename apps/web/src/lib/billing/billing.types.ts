import type { LifetimeWindow } from "@hostel/shared/plans/lifetime";

export interface BillingInvoiceRow {
  amount: number;
  currency: string;
  /**
   * Our own authenticated download route.
   *
   * No longer nullable. It used to be, because a document existed only once
   * Softmato had raised one — an invoice recorded here with no paper anywhere
   * was a real state, and a download button for it would have produced nothing.
   * That is no longer true: when they cannot be reached we issue the document
   * ourselves, so every invoice has one, and the route resolves whichever
   * exists.
   */
  documentUrl: string;
  dueAt: string | null;
  invoiceNumber: string;
  issuedAt: string | null;
  outstanding: number;
  paid: number;
  /** The catalogue id, for the plan's mark on the row. */
  planId: string | null;
  planName: string;
  cycleLabel: string;
  /** What is printed on the page the owner holds, whoever issued it. */
  printedNumber: string;
  /** `INV-2083/84-000010`, once raised. */
  softmatoInvoiceNo: string | null;
  /** Who produced the document. Shown plainly rather than hidden. */
  issuedBy: "softmato" | "platform";
  status: string;
}

export interface BillingPaymentRow {
  amount: number;
  documentUrl: string | null;
  /** `CASH` rows are our own record and carry no Softmato document. */
  method: string;
  paidAt: string | null;
  /** `eSewa`, `Khalti` — absent on cash. */
  provider: string | null;
  providerRef: string | null;
  /** What is printed on the receipt the owner holds, whoever issued it. */
  printedNumber: string | null;
  receiptNumber: string | null;
  softmatoTransactionNo: string | null;
  status: string;
}

/**
 * The plan itself — what is running, and how long is left on it.
 *
 * `daysRemaining` is computed here rather than on each client for the reason
 * every derived figure in this codebase is: the website and the app would
 * otherwise each own a copy of "how many days is that", and the two would round
 * a part-day differently on the one screen where an owner is deciding whether
 * to renew today or tomorrow.
 *
 * ## Counted in Nepal days, so it moves once, at midnight
 *
 * Every figure here is a count of **calendar days in Kathmandu**, never of
 * elapsed milliseconds. The first cut floored milliseconds, so a count moved at
 * whatever minute the period happened to end — "3 days left" at breakfast,
 * "2" by lunch, on the same day. Counted between days, it changes at midnight
 * in Nepal and nowhere else, and a client that re-asks when the day turns is
 * right all day.
 *
 * `daysRemaining` counts **today in**: 31 on the first day of a 31-day month,
 * 1 on its last, 0 once it has run out — a real state, not an error.
 * `daysToDue` counts **to** the day: 3 on Bhadra 26 for a due on Bhadra 29, and
 * 0 on Bhadra 29 itself, which the screens word as the last day to pay.
 */
export interface BillingPlan {
  /**
   * When the stretch now running began. For a team-filed hostel that is the
   * day it was filed — it is live before it has paid — and for a public one
   * the day it paid.
   */
  activatedAt: string | null;
  /** Still owed on the invoice being paid. `0` when nothing is open. */
  amountDue: number;
  /** Settled so far against that same invoice. */
  amountPaid: number;
  /** `monthly` / `halfYearly` / `annual` — what "Pay for this plan" renews at. */
  cycle: string | null;
  cycleLabel: string | null;
  cycleMonths: number | null;
  /**
   * The last instant the plan covers — the end of a Nepal day. Null until the
   * plan starts, which is not the same as until it is paid: a team hostel's
   * runs while its balance is still owed.
   */
  currentPeriodEnd: string | null;
  /** Days left on the plan, today included. Null when no period is running, and on a lifetime plan. */
  daysRemaining: number | null;
  /** Days until the day in `dueBy`; 0 on that day. */
  daysToDue: number | null;
  /**
   * The deadline on a shortfall. The subscription's own when a team
   * registration carries one, otherwise the open invoice's — both are counted
   * from the day the invoice was raised and neither moves on a part payment.
   */
  dueBy: string | null;
  /** When the window to pay opened: the open invoice's issue. */
  dueFrom: string | null;
  /**
   * How many days the running stretch spans, both ends included — what
   * `daysRemaining` is a share of. Sent rather than left for the client to
   * derive so the bar and the count under it move on the same midnight.
   */
  periodDays: number | null;
  /**
   * Paid for life (the lifetime deal). `currentPeriodEnd`, `daysRemaining` and
   * `periodDays` are null on it: a screen says "Lifetime", never a date.
   */
  lifetime: boolean;
  /** The catalogue id — what a client ranks the plan's mark by. */
  planId: string | null;
  planName: string | null;
  price: number | null;
  status: string;
  /** On the free trial with no plan bought yet: its last instant. */
  trialEndsAt: string | null;
}

export interface BillingHistory {
  /** The integration guide Softmato hosts. Null when unconfigured. */
  docsUrl: string | null;
  invoices: BillingInvoiceRow[];
  payments: BillingPaymentRow[];
  /** Null for a hostel that predates plan billing and has no subscription. */
  plan: BillingPlan | null;
}

export type FieldCashRow = {
  amount: number;
  collectedAt: string;
  collectedBy: string;
  hostelName: string;
  id: string;
  invoiceNumber: string;
  planName: string;
  reference: string | null;
  /** Null until Softmato has it — it was unreachable when the agent filed it. */
  transactionNo: string | null;
};

export type ReturnState =
  | {
      /** `null` while the activation is still landing — the page says so. */
      activeUntil: string | null;
      kind: "paid";
      invoiceNumber: string;
      planName: string;
      total: number;
    }
  | {
      kind: "partial";
      balance: number;
      invoiceNumber: string;
      planName: string;
    }
  | { kind: "unpaid"; invoiceNumber: string; planName: string; total: number }
  | { kind: "void"; invoiceNumber: string }
  /** Raised locally, no document yet — or Softmato was unreachable just now. */
  | { kind: "pending_document"; invoiceNumber: string }
  | { kind: "unknown" };

export type LifetimeAvailability = {
  /** The last day it can be bought (`YYYY-MM-DD`), or blank for no end. */
  endsOn: string;
  offers: {
    left: number;
    /** The tier's ordinary monthly price, for the comparison on a card. */
    monthly: number;
    planId: string;
    planName: string;
    price: number;
    seats: number;
    sold: number;
  }[];
  startsOn: string;
  window: LifetimeWindow;
};

export type PlatformInvoiceRow = {
  amount: number;
  currency: string;
  cycle: string;
  /** Our authenticated download route. Always present — a document always exists. */
  documentUrl: string;
  dueAt: string | null;
  hostelId: string;
  hostelName: string;
  /** Our internal reference. `SUB-0001-4F2A`. */
  invoiceNumber: string;
  issuedAt: string | null;
  outstanding: number;
  paid: number;
  planName: string;
  /** What is printed on the page the hostel holds. */
  printedNumber: string;
  /** Who printed it. The platform's own honest view of the outage. */
  issuedBy: "softmato" | "platform";
  source: string;
  status: string;
};

export type PlatformPaymentRow = {
  amount: number;
  currency: string;
  documentUrl: string | null;
  hostelId: string;
  hostelName: string;
  invoiceNumber: string;
  method: string;
  paidAt: string | null;
  printedNumber: string | null;
  provider: string | null;
  receiptNumber: string | null;
  status: string;
};

export type PlatformSubscriptionLedger = {
  invoices: PlatformInvoiceRow[];
  payments: PlatformPaymentRow[];
  totals: {
    /** Hostels whose paid period has not yet run out. */
    activePlans: number;
    /** Raised, ever. */
    billed: number;
    /** Received, ever. Only `SETTLED` rows. */
    collected: number;
    /** Invoices we issued ourselves because Softmato could not be reached. */
    issuedByPlatform: number;
    /** Still owed on invoices that are neither paid nor void. */
    outstanding: number;
  };
};

export type PlanPaymentInstructions = {
  /** What is still owed on the open invoice. The claim is for exactly this. */
  amountDue: number;
  /** The claim already in flight, when there is one. */
  claim: {
    amount: number;
    claimedAt: string | null;
    reference: string | null;
  } | null;
  dueBy: string | null;
  invoice: { id: string; invoiceNumber: string; planName: string } | null;
  /**
   * Whether the deadline has passed, decided **here**.
   *
   * The same rule the billing screen's days follow: a client that reads its own
   * clock to answer this gives an answer that goes stale on a screen somebody
   * left open, and two clients each flooring their own part-day disagree about
   * the same afternoon. One authority, printed.
   */
  overdue: boolean;
  /** Our own collection QR, out of the operations config. */
  qr: { label: string; url: string } | null;
  /**
   * What the owner should put in the remarks so a reviewer can match it without
   * asking. Our invoice number — it is on the document they already hold.
   */
  reference: string | null;
};

export type PlanPaymentClaim = {
  amount: number;
  claimedAt: string | null;
  hostelId: string;
  hostelName: string;
  id: string;
  invoiceNumber: string;
  note: string | null;
  planName: string;
  /**
   * The screenshot, by id. The reader builds `/api/v1/files/{id}/url` from it
   * rather than being handed a link: that route re-authorises on every open and
   * a URL minted here would outlive the session that asked for it.
   */
  proofAssetId: string | null;
  reference: string | null;
};
