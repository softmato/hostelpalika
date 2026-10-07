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
    plan: { cycle: BillingCycle; lifetime?: boolean; planId: string };
  },
  agent: { name?: string; userId: string },
  prepayment: ClaimedPrepayment | null,
) {
  if (input.plan.lifetime) {
    return fileTeamLifetime(hostelId, input, agent, prepayment);
  }

  const id = hostelId.toString();

  await getOrCreateSubscription(hostelId, { agentId: agent.userId, source: "TEAM" });
  await selectPlan(id, input.plan, agent.userId);

  const legacyPlanPayment = Boolean(prepayment && (prepayment.kind ?? "PLAN") === "PLAN");
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

/**
 * The lifetime deal, filed by an agent: the owner pays the lifetime price in
 * full instead of a setup fee, and there are no free months — the plan runs
 * for life from the moment the money is confirmed.
 *
 * - **Online** (`kind: LIFETIME`, paid before publish): the hostel's invoice
 *   adopts the paid document and settles at once, so it publishes already on
 *   its lifetime plan.
 * - **Cash**: filed with Softmato as a claim for the full price, like any field
 *   cash. The hostel publishes now, as every team filing does, with the price
 *   as its due; it becomes lifetime the moment Softmato's admin confirms the
 *   cash and the settlement lands.
 *
 * No setup fee is raised beside it. The agent's commission is earned on the
 * lifetime invoice itself (`earnsCommission`: a team hostel with no setup fee).
 */
async function fileTeamLifetime(
  hostelId: Types.ObjectId,
  input: {
    payment: { amount: number; reference?: string };
    plan: { cycle: BillingCycle; lifetime?: boolean; planId: string };
  },
  agent: { name?: string; userId: string },
  prepayment: ClaimedPrepayment | null,
) {
  const id = hostelId.toString();
  // `claimTeamPrepayment` already refused any other kind for a lifetime plan.
  const online = prepayment?.kind === "LIFETIME" ? prepayment : null;

  await getOrCreateSubscription(hostelId, { agentId: agent.userId, source: "TEAM" });
  await selectPlan(id, input.plan, agent.userId, { lifetimeGate: !online?.paid });

  // `requireVerified: false` — on this path the check is the agent's presence.
  const invoice = await issueSubscriptionInvoice(id, agent.userId, {
    agentId: agent.userId,
    ...(online
      ? {
          prepaid: {
            amount: online.amount,
            invoiceNumber: online.invoiceNumber,
            softmatoInvoiceId: online.softmatoInvoiceId,
            softmatoInvoiceNo: online.softmatoInvoiceNo,
          },
        }
      : {}),
    requireVerified: false,
    source: "TEAM",
  });

  if (online?.paid) {
    await settleTeamPrepayment(online, invoice, agent.userId);

    return { free: null, lifetime: true, setupFee: null };
  }

  // Not confirmed yet: the whole lifetime price is the due, on the invoice's own deadline.
  const dueBy =
    invoice.dueAt ??
    graceDeadline(
      invoice.issuedAt ?? new Date(),
      (await getOperationsConfig()).subscriptionDueGraceDays,
    );

  await HostelSubscriptionModel.updateOne({ hostelId }, { $set: { dueBy, status: "PAST_DUE" } });

  if (online) {
    // Open at publish: a payment that lands later finds this invoice by webhook.
    await reconcileInvoiceFromSoftmato(invoice._id).catch(() => null);
  } else {
    await fileFieldCash(
      invoice._id.toString(),
      { amount: input.payment.amount, reference: input.payment.reference },
      { name: agent.name ?? "Field agent", userId: agent.userId },
    );
  }

  return { free: null, lifetime: true, setupFee: null };
}
