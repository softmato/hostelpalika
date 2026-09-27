import type { Types } from "mongoose";

import { fileFieldCash } from "@/modules/billing/cash-filing.service";
import { startFreeMonths } from "@/modules/billing/subscription-payment.service";
import { reconcileInvoiceFromSoftmato } from "@/modules/billing/subscription-reconcile.service";
import {
  getOrCreateSubscription,
  graceDeadline,
  issueSetupFeeInvoice,
  issueSubscriptionInvoice,
  selectPlan,
  startPlanPeriod,
} from "@/modules/billing/subscription.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { settleTeamPrepayment, type claimTeamPrepayment } from "@/modules/team/team-prepayment.service";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import type { BillingCycle } from "@hostel/shared/plans/catalog";

type ClaimedPrepayment = NonNullable<Awaited<ReturnType<typeof claimTeamPrepayment>>>;

/**
 * The money side of a team registration, the moment it is filed.
 *
 * 1. **The plan starts on its free months.** The hostel is live from filing,
 *    and nothing is owed for the plan until they run out. A building that has
 *    had them before (`FreePlanClaim`) gets none: its plan is invoiced today
 *    and published with the whole price as a due, as before.
 * 2. **The setup fee** is what the agent actually collected — its own invoice,
 *    settled from the online payment or filed as cash. It earns the agent their
 *    commission and never touches the plan.
 *
 * A plan-priced online payment taken before setup fees (`kind: PLAN`) still
 * pays the plan the old way: it becomes the plan's first invoice, no free
 * months are given on top of the period it bought, and no setup fee is raised.
 */
export async function fileTeamBilling(
  hostelId: Types.ObjectId,
  input: {
    payment: { amount: number; reference?: string };
    plan: { cycle: BillingCycle; planId: string };
  },
  agent: { name?: string; userId: string },
  prepayment: ClaimedPrepayment | null,
) {
  const id = hostelId.toString();

  await getOrCreateSubscription(hostelId, { agentId: agent.userId, source: "TEAM" });
  await selectPlan(id, input.plan, agent.userId);

  const legacyPlanPayment = Boolean(prepayment && prepayment.kind !== "SETUP_FEE");
  const free = legacyPlanPayment ? null : await startFreeMonths(id, agent.userId);

  if (!free) {
    // `requireVerified: false` — on this path the check is the agent's presence.
    const invoice = await issueSubscriptionInvoice(id, agent.userId, {
      agentId: agent.userId,
      ...(legacyPlanPayment && prepayment
        ? {
            prepaid: {
              amount: prepayment.amount,
              invoiceNumber: prepayment.invoiceNumber,
              softmatoInvoiceId: prepayment.softmatoInvoiceId,
              softmatoInvoiceNo: prepayment.softmatoInvoiceNo,
            },
          }
        : {}),
      requireVerified: false,
      source: "TEAM",
    });

    // Published before paid, so the plan runs from today.
    await startPlanPeriod(invoice, invoice.issuedAt ?? new Date());

    if (legacyPlanPayment && prepayment?.paid) {
      await settleTeamPrepayment(prepayment, invoice, agent.userId);
    } else {
      /*
       * Nothing collected toward the plan today, so the whole price is the due,
       * set here rather than waiting for a settlement that is not coming. The
       * deadline is the invoice's own, so this and a later part payment agree.
       */
      const dueBy =
        invoice.dueAt ??
        graceDeadline(
          invoice.issuedAt ?? new Date(),
          (await getOperationsConfig()).subscriptionDueGraceDays,
        );

      await HostelSubscriptionModel.updateOne(
        { hostelId },
        { $set: { dueBy, status: "PAST_DUE" } },
      );

      if (legacyPlanPayment) {
        // Open at publish: a payment that landed in between reached no row.
        await reconcileInvoiceFromSoftmato(invoice._id).catch(() => null);
      }
    }
  }

  if (legacyPlanPayment) {
    return { free, setupFee: null };
  }

  const setupFee = await issueSetupFeeInvoice(
    id,
    prepayment ? prepayment.amount : input.payment.amount,
    agent.userId,
    prepayment
      ? {
          prepaid: {
            invoiceNumber: prepayment.invoiceNumber,
            softmatoInvoiceId: prepayment.softmatoInvoiceId,
            softmatoInvoiceNo: prepayment.softmatoInvoiceNo,
          },
        }
      : {},
  );

  if (prepayment?.paid) {
    await settleTeamPrepayment(prepayment, setupFee, agent.userId);
  } else if (prepayment) {
    // Still open at publish: whatever lands later finds this invoice by webhook.
    await reconcileInvoiceFromSoftmato(setupFee._id).catch(() => null);
  } else {
    // Cash, filed with Softmato as a claim; it books when their admin confirms it.
    await fileFieldCash(
      setupFee._id.toString(),
      { amount: input.payment.amount, reference: input.payment.reference },
      { name: agent.name ?? "Field agent", userId: agent.userId },
    );
  }

  return { free, setupFee: setupFee.amount };
}
