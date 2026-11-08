import type { BillingCycle } from "@hostel/shared/plans/catalog";

/**
 * What the form shows. `amount` is the plan price the hostel is invoiced for;
 * `chargeAmount` is what this payment takes. `reference` is Softmato's
 * transaction, else its invoice.
 */
export type TeamPrepaymentView = {
  amount: number;
  chargeAmount: number;
  cycle: BillingCycle;
  id: string;
  /** `PLAN` only on a row taken before setup fees; `LIFETIME` is the lifetime deal. See the model. */
  kind: "PLAN" | "SETUP_FEE" | "LIFETIME";
  paidAt: string | null;
  planId: string;
  planName: string;
  provider: string | null;
  reference: string | null;
  status: "OPEN" | "PAID" | "CLAIMED" | "SUPERSEDED";
};

export type UnpublishedPrepayment = TeamPrepaymentView & { hostelName: string; ownerName: string };
