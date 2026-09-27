import { Types } from "mongoose";
import { z } from "zod";

import { HOSTEL_UTC_OFFSET_MINUTES, hostelToday } from "@hostel/shared/calendar/bs";

import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { listAgentRegistrations } from "@/modules/team/team.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { TeamWalletEntryModel } from "@hostel/db/models/TeamWalletEntry";
import { UserModel } from "@hostel/db/models/User";

/**
 * Field-agent commission: a percent of a registered hostel's first plan
 * payment, credited to the agent's wallet when that payment clears in full,
 * and paid out by a superadmin.
 *
 * The wallet is `TeamWalletEntry` — credits and payouts in one ledger, the
 * balance summed on read. See the model for why each credit stores its rate.
 */

/** Rupees to the paisa. */
export function commissionFor(base: number, ratePercent: number) {
  return Math.round(base * ratePercent) / 100;
}

/** When the current Nepal day began, as an instant. */
function startOfHostelDay(now = new Date()) {
  return new Date(hostelToday(now).getTime() - HOSTEL_UTC_OFFSET_MINUTES * 60_000);
}

type Totals = { earned: number; paidOut: number };

async function totalsByAgent(agentIds?: Types.ObjectId[]) {
  const rows = await TeamWalletEntryModel.aggregate<{
    _id: { agentId: Types.ObjectId; type: string };
    total: number;
    last: Date;
  }>([
    ...(agentIds ? [{ $match: { agentId: { $in: agentIds } } }] : []),
    {
      $group: {
        _id: { agentId: "$agentId", type: "$type" },
        last: { $max: "$createdAt" },
        total: { $sum: "$amount" },
      },
    },
  ]);

  const byAgent = new Map<string, Totals & { lastPayoutAt: Date | null }>();

  for (const row of rows) {
    const key = row._id.agentId.toString();
    const entry = byAgent.get(key) ?? { earned: 0, lastPayoutAt: null, paidOut: 0 };

    if (row._id.type === "COMMISSION") {
      entry.earned += row.total;
    } else {
      entry.paidOut += row.total;
      entry.lastPayoutAt = row.last;
    }

    byAgent.set(key, entry);
  }

  return byAgent;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Credits the agent who registered this subscription's hostel, once.
 *
 * Called by `settlePayment` after an invoice is paid in full. Never throws:
 * a commission bookkeeping failure must not undo or block a hostel's payment,
 * so it is logged and left for a superadmin to see as a missing credit.
 */
export async function creditTeamCommission(invoice: {
  _id: Types.ObjectId;
  amount: number;
  hostelId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
}) {
  try {
    const subscription = await HostelSubscriptionModel.findById(invoice.subscriptionId)
      .select("agentId source")
      .lean<{ agentId?: Types.ObjectId | null; source?: string } | null>();

    if (!subscription?.agentId || subscription.source !== "TEAM") {
      return;
    }

    const { teamCommissionPercent } = await getOperationsConfig();
    const amount = commissionFor(invoice.amount, teamCommissionPercent);

    if (amount <= 0) {
      return;
    }

    await TeamWalletEntryModel.create({
      agentId: subscription.agentId,
      amount,
      base: invoice.amount,
      hostelId: invoice.hostelId,
      invoiceId: invoice._id,
      ratePercent: teamCommissionPercent,
      subscriptionId: invoice.subscriptionId,
      type: "COMMISSION",
    });
  } catch (error) {
    // Duplicate key = already credited for this hostel, which is the point.
    if ((error as { code?: number }).code === 11000) {
      return;
    }

    console.error(
      JSON.stringify({
        action: "team_commission_credit_failed",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        subscriptionId: String(invoice.subscriptionId),
      }),
    );
  }
}

/** The agent's own wallet and today's figures, for the desk. */
export async function getAgentWallet(agentId: string) {
  await connectToDatabase();

  const id = new Types.ObjectId(agentId);
  const since = startOfHostelDay();

  const [{ teamCommissionPercent }, { registrations }, totals, entries] = await Promise.all([
    getOperationsConfig(),
    listAgentRegistrations(agentId, 500),
    totalsByAgent([id]),
    TeamWalletEntryModel.find({ agentId: id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean<
        {
          _id: Types.ObjectId;
          amount: number;
          createdAt: Date;
          hostelId?: Types.ObjectId;
          method?: string;
          ratePercent?: number;
          reference?: string;
          type: "COMMISSION" | "PAYOUT";
        }[]
      >(),
  ]);

  const { earned, paidOut } = totals.get(agentId) ?? { earned: 0, paidOut: 0 };
  // Bounded by the hostels this agent registered, so reading them all is cheap.
  const credits = await TeamWalletEntryModel.find({ agentId: id, type: "COMMISSION" })
    .select("amount createdAt hostelId")
    .lean<{ amount: number; createdAt: Date; hostelId?: Types.ObjectId }[]>();
  const credited = new Set(credits.map((row) => String(row.hostelId)));
  const hostelName = new Map(registrations.map((row) => [row.hostelId, row.hostelName]));
  const today = registrations.filter(
    (row) => row.registeredAt && Date.parse(row.registeredAt) >= since.getTime(),
  );

  return {
    wallet: {
      balance: round(earned - paidOut),
      earned: round(earned),
      paidOut: round(paidOut),
      /**
       * What registrations not yet credited will earn once their setup fee
       * clears, at today's rate. A hostel filed before setup fees earns on its
       * plan price instead.
       */
      pending: round(
        registrations
          .filter((row) => !credited.has(row.hostelId))
          .reduce(
            (sum, row) =>
              sum + commissionFor(row.setupFee ? row.setupFee.amount : row.price, teamCommissionPercent),
            0,
          ),
      ),
      ratePercent: teamCommissionPercent,
      today: {
        commission: round(
          credits
            .filter((row) => row.createdAt >= since)
            .reduce((sum, row) => sum + row.amount, 0),
        ),
        due: today.reduce((sum, row) => sum + row.outstanding, 0),
        hostels: today.length,
        paid: today.reduce((sum, row) => sum + row.paid, 0),
      },
    },
    entries: entries.map((row) => ({
      amount: row.amount,
      at: row.createdAt.toISOString(),
      hostelName: row.hostelId ? (hostelName.get(String(row.hostelId)) ?? "") : "",
      id: row._id.toString(),
      method: row.method ?? null,
      ratePercent: row.ratePercent ?? null,
      reference: row.reference ?? "",
      type: row.type,
    })),
  };
}

/** Every agent's wallet, for the superadmin's Team tab. */
export async function listTeamWallets() {
  await connectToDatabase();

  const [{ teamCommissionPercent, teamSetupFee }, members, totals] = await Promise.all([
    getOperationsConfig(),
    UserModel.find({ isDeleted: { $ne: true }, role: Role.PLATFORM_AGENT })
      .select("name email")
      .sort({ name: 1 })
      .lean<{ _id: Types.ObjectId; email?: string; name?: string }[]>(),
    totalsByAgent(),
  ]);

  return {
    ratePercent: teamCommissionPercent,
    setupFee: teamSetupFee,
    wallets: members.map((member) => {
      const key = member._id.toString();
      const { earned, lastPayoutAt, paidOut } = totals.get(key) ?? {
        earned: 0,
        lastPayoutAt: null,
        paidOut: 0,
      };

      return {
        agentId: key,
        balance: round(earned - paidOut),
        earned: round(earned),
        email: member.email ?? "",
        lastPayoutAt: lastPayoutAt?.toISOString() ?? null,
        name: member.name ?? "Unnamed",
        paidOut: round(paidOut),
      };
    }),
  };
}

export const payoutSchema = z.object({
  amount: z.number().positive().max(10_000_000),
  method: z.enum(["CASH", "BANK", "ESEWA", "KHALTI", "OTHER"]),
  note: z.string().trim().max(300).optional(),
  reference: z.string().trim().max(120).optional(),
});

/** A superadmin paying an agent out of their wallet. Never more than the balance. */
export async function recordTeamPayout(
  agentId: string,
  input: z.infer<typeof payoutSchema>,
  actorId: string,
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(agentId)) {
    throw Object.assign(new Error("Team member was not found."), {
      errorCode: "NOT_FOUND",
      status: 404,
    });
  }

  const id = new Types.ObjectId(agentId);
  const { earned, paidOut } = (await totalsByAgent([id])).get(agentId) ?? {
    earned: 0,
    paidOut: 0,
  };
  const balance = round(earned - paidOut);
  const amount = round(input.amount);

  // ponytail: read-then-write; two superadmins paying the same agent in the
  // same second could overdraw. A per-agent lock if that ever happens.
  if (amount > balance) {
    throw Object.assign(new Error(`Only Rs ${balance.toLocaleString("en-IN")} is in this wallet.`), {
      errorCode: "PAYOUT_EXCEEDS_BALANCE",
      status: 409,
    });
  }

  const entry = await TeamWalletEntryModel.create({
    agentId: id,
    amount,
    createdBy: new Types.ObjectId(actorId),
    method: input.method,
    note: input.note || undefined,
    reference: input.reference || undefined,
    type: "PAYOUT",
  });

  await AuditLogModel.create({
    action: "TEAM_COMMISSION_PAID_OUT",
    actorId,
    actorType: "USER",
    entityId: String(entry._id),
    entityType: "TeamWalletEntry",
    metadata: { agentId, amount, method: input.method, reference: input.reference ?? "" },
  });

  return { balance: round(balance - amount) };
}
