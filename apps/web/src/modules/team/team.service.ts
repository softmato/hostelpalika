import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { PlatformAdminInviteModel } from "@hostel/db/models/PlatformAdminInvite";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { UserModel } from "@hostel/db/models/User";

/**
 * Reading the field team's work.
 *
 * The question the roster exists to answer, from the notes, is precisely:
 * *which team member added which hostel, how much they were paid, by which
 * method, and when.* Every read here is shaped to answer some part of that, and
 * all of it comes from rows written by the flow itself — `agentId` on the
 * subscription, `collectedBy` on the payment — rather than from a separate
 * activity log that could disagree with the money.
 *
 * ## Cash and QR are counted separately, on purpose
 *
 * `collected` is what the agent physically handled. A Fonepay payment an owner
 * scanned goes to the platform's merchant account and never passes through the
 * agent's hands, so rolling the two together would produce a number that looks
 * like an amount owed by the agent and is not. Cash is the number a
 * reconciliation conversation is actually about.
 */

type SubscriptionRow = {
  _id: Types.ObjectId;
  agentId?: Types.ObjectId | null;
  createdAt?: Date;
  cycleTotal?: number | null;
  dueBy?: Date | null;
  freeUntil?: Date | null;
  hostelId: Types.ObjectId;
  planName?: string | null;
  status: string;
};

type Ledger = {
  cash: number;
  online: number;
  /** What is still owed on the plan: open plan invoices minus what settled on them. */
  outstanding: number;
  /** The setup fee collected at registration, and how much of it has cleared. Null before setup fees. */
  setupFee: { amount: number; collected: number } | null;
  total: number;
};

/**
 * What each registration has paid, owes on its plan, and was charged as a setup
 * fee — in two reads, whatever the number of rows.
 *
 * The plan and the setup fee are kept apart: a hostel on its free months paid a
 * setup fee and owes nothing on its plan, and netting one against the other
 * would show the fee as part-payment of a plan it is not paying for yet.
 */
async function ledgerBySubscription(subscriptionIds: Types.ObjectId[]) {
  const byId = new Map<string, Ledger>();

  if (subscriptionIds.length === 0) {
    return byId;
  }

  const [payments, invoices] = await Promise.all([
    SubscriptionPaymentModel.aggregate<{
      _id: { invoiceId: Types.ObjectId; method: string; subscriptionId: Types.ObjectId };
      total: number;
    }>([
      { $match: { status: "SETTLED", subscriptionId: { $in: subscriptionIds } } },
      {
        $group: {
          _id: { invoiceId: "$invoiceId", method: "$method", subscriptionId: "$subscriptionId" },
          total: { $sum: "$amount" },
        },
      },
    ]),
    SubscriptionInvoiceModel.find({ subscriptionId: { $in: subscriptionIds } })
      .select("amount kind status subscriptionId")
      .lean<
        {
          _id: Types.ObjectId;
          amount: number;
          kind?: string;
          status: string;
          subscriptionId: Types.ObjectId;
        }[]
      >(),
  ]);

  const settledOn = new Map<string, number>();

  for (const row of payments) {
    const key = row._id.subscriptionId.toString();
    const entry = byId.get(key) ?? { cash: 0, online: 0, outstanding: 0, setupFee: null, total: 0 };

    if (row._id.method === "CASH") {
      entry.cash += row.total;
    } else {
      entry.online += row.total;
    }

    entry.total += row.total;
    byId.set(key, entry);

    const invoiceKey = row._id.invoiceId.toString();
    settledOn.set(invoiceKey, (settledOn.get(invoiceKey) ?? 0) + row.total);
  }

  for (const invoice of invoices) {
    const key = invoice.subscriptionId.toString();
    const entry = byId.get(key) ?? { cash: 0, online: 0, outstanding: 0, setupFee: null, total: 0 };
    const settled = settledOn.get(invoice._id.toString()) ?? 0;

    if (invoice.kind === "SETUP_FEE") {
      entry.setupFee = { amount: invoice.amount, collected: settled };
    } else if (invoice.status === "OPEN" || invoice.status === "PARTIAL") {
      entry.outstanding += Math.max(0, invoice.amount - settled);
    }

    byId.set(key, entry);
  }

  return byId;
}

const EMPTY_LEDGER: Ledger = { cash: 0, online: 0, outstanding: 0, setupFee: null, total: 0 };

/**
 * The hostel an agent may keep working on after filing it — the existing
 * residents list is filled in with the owner after the hostel is published.
 *
 * Only the agent who filed it (`agentId` on its subscription), and a superadmin.
 * Any other hostel is a 404, not a 403: an agent has no business learning that a
 * hostel id they guessed exists.
 */
export async function assertAgentFiledHostel(
  principal: { role: string; userId: string },
  hostelId: string,
): Promise<Types.ObjectId> {
  const notFound = Object.assign(new Error("Hostel was not found."), {
    errorCode: "NOT_FOUND",
    status: 404,
  });

  if (!Types.ObjectId.isValid(hostelId)) {
    throw notFound;
  }

  const id = new Types.ObjectId(hostelId);

  if (principal.role === Role.SUPERADMIN) {
    return id;
  }

  await connectToDatabase();

  const filed = await HostelSubscriptionModel.exists({
    agentId: new Types.ObjectId(principal.userId),
    hostelId: id,
  });

  if (!filed) {
    throw notFound;
  }

  return id;
}

/**
 * Every hostel one agent has filed, what it owes, and who to ring about it.
 *
 * Reads the subscription rather than the application because the money lives
 * there — and because a subscription exists for every registered hostel, so
 * there is no join that can come back empty and silently drop a row.
 *
 * Ordered by what is owed rather than by when it was filed; see the sort below
 * for why the newest-first the query gives back is the wrong answer here.
 */
export async function listAgentRegistrations(agentId: string, limit = 100) {
  await connectToDatabase();

  const subscriptions = await HostelSubscriptionModel.find({
    agentId: new Types.ObjectId(agentId),
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<SubscriptionRow[]>();

  /*
   * `contact` comes back too, because the point of an outstanding row is that
   * somebody picks up a phone about it. A list that shows a debt and not the
   * number to ring makes the agent go and look the hostel up, which is a step
   * between them and the call they are meant to be making.
   */
  const hostels = await HostelModel.find({
    _id: { $in: subscriptions.map((row) => row.hostelId) },
  })
    .select("name slug status location contact")
    .lean<
      {
        _id: Types.ObjectId;
        contact?: { alternatePhone?: string; email?: string; phone?: string };
        location?: { area?: string; city?: string };
        name?: string;
        slug?: string;
        status?: string;
      }[]
    >();

  const hostelById = new Map(hostels.map((hostel) => [hostel._id.toString(), hostel]));
  const money = await ledgerBySubscription(subscriptions.map((row) => row._id));

  const registrations = subscriptions.map((row) => {
    const hostel = hostelById.get(row.hostelId.toString());
    const paid = money.get(row._id.toString()) ?? EMPTY_LEDGER;
    const price = row.cycleTotal ?? 0;

    return {
      area: hostel?.location?.area ?? "",
      cashCollected: paid.cash,
      city: hostel?.location?.city ?? "",
      dueBy: row.dueBy?.toISOString() ?? null,
      freeUntil: row.freeUntil?.toISOString() ?? null,
      hostelId: row.hostelId.toString(),
      hostelName: hostel?.name ?? "Unnamed hostel",
      hostelStatus: hostel?.status ?? "",
      onlineCollected: paid.online,
      outstanding: paid.outstanding,
      ownerEmail: hostel?.contact?.email ?? "",
      ownerPhone: hostel?.contact?.phone ?? hostel?.contact?.alternatePhone ?? "",
      paid: paid.total,
      planName: row.planName ?? "",
      price,
      registeredAt: row.createdAt?.toISOString() ?? null,
      setupFee: paid.setupFee,
      slug: hostel?.slug ?? "",
      subscriptionStatus: row.status,
    };
  });

  // Newest first, as the query gave them — the field team asked for it (2026-09-25).
  return { registrations };
}

/** The headline figures for one agent's own dashboard. */
export async function getAgentSummary(agentId: string) {
  const { registrations } = await listAgentRegistrations(agentId, 500);

  return {
    summary: {
      cashCollected: registrations.reduce((sum, row) => sum + row.cashCollected, 0),
      collected: registrations.reduce((sum, row) => sum + row.paid, 0),
      hostelsRegistered: registrations.length,
      outstanding: registrations.reduce((sum, row) => sum + row.outstanding, 0),
      pastDue: registrations.filter((row) => row.subscriptionStatus === "PAST_DUE")
        .length,
    },
  };
}

/**
 * The superadmin's view of the whole team: who is on it, and what each of them
 * has brought in.
 *
 * One aggregate per fact rather than a per-member loop — a roster of thirty
 * agents must not become sixty round trips.
 */
export async function listTeamRoster() {
  await connectToDatabase();

  const members = await UserModel.find({
    isDeleted: { $ne: true },
    role: Role.PLATFORM_AGENT,
  })
    .select("name email phone status createdAt lastLoginAt previousRole")
    .sort({ createdAt: -1 })
    .lean<
      {
        _id: Types.ObjectId;
        createdAt?: Date;
        email?: string;
        lastLoginAt?: Date;
        name?: string;
        phone?: string;
        previousRole?: string;
        status?: string;
      }[]
    >();

  const memberIds = members.map((member) => member._id);

  const [registrationCounts, collections, paymentCounts] = await Promise.all([
    HostelSubscriptionModel.aggregate<{
      _id: Types.ObjectId;
      outstandingPrice: number;
      total: number;
    }>([
      { $match: { agentId: { $in: memberIds } } },
      {
        $group: {
          _id: "$agentId",
          outstandingPrice: { $sum: "$cycleTotal" },
          total: { $sum: 1 },
        },
      },
    ]),
    SubscriptionPaymentModel.aggregate<{
      _id: { collectedBy: Types.ObjectId; method: string };
      total: number;
    }>([
      { $match: { collectedBy: { $in: memberIds }, status: "SETTLED" } },
      {
        $group: {
          _id: { collectedBy: "$collectedBy", method: "$method" },
          total: { $sum: "$amount" },
        },
      },
    ]),
    /*
     * Payments attributed to each member at *any* status, which the money
     * columns above deliberately do not count.
     *
     * They answer "what is this person answerable for", so they read SETTLED
     * only. This one answers "would deleting this account orphan a row", and a
     * pending or failed payment is a row pointing at the account just as much
     * as a settled one is. Reusing the settled figure here would let the screen
     * offer a delete the service is bound to refuse.
     */
    SubscriptionPaymentModel.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: { collectedBy: { $in: memberIds } } },
      { $group: { _id: "$collectedBy", total: { $sum: 1 } } },
    ]),
  ]);

  const countById = new Map(
    registrationCounts.map((row) => [row._id?.toString() ?? "", row]),
  );
  const paymentCountById = new Map(
    paymentCounts.map((row) => [row._id?.toString() ?? "", row.total]),
  );
  const cashById = new Map<string, number>();

  for (const row of collections) {
    if (row._id.method !== "CASH") {
      continue;
    }

    const key = row._id.collectedBy?.toString() ?? "";

    cashById.set(key, (cashById.get(key) ?? 0) + row.total);
  }

  return {
    members: members.map((member) => {
      const key = member._id.toString();
      const counts = countById.get(key);
      const payments = paymentCountById.get(key) ?? 0;

      return {
        cashCollected: cashById.get(key) ?? 0,
        /*
         * Whether the account can be destroyed outright, decided here rather
         * than in the browser. The rule belongs to `deleteTeamMember`, which
         * enforces it again on the way in — this is the same question asked
         * early so the screen can offer the honest action instead of a button
         * that answers 409. See that function for why each clause is a bar.
         */
        deletable: payments === 0 && (counts?.total ?? 0) === 0 && !member.previousRole,
        email: member.email ?? "",
        hostelsRegistered: counts?.total ?? 0,
        id: key,
        joinedAt: member.createdAt?.toISOString() ?? null,
        lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
        name: member.name ?? "Unnamed",
        phone: member.phone ?? "",
        /**
         * The role this account will be handed back if it is removed from the
         * team — shown on the row, because "remove" meaning "returns to warden"
         * and "remove" meaning "returns to nothing" are different decisions.
         */
        previousRole: member.previousRole ?? null,
        status: member.status ?? "ACTIVE",
      };
    }),
  };
}

/**
 * Invitations sent to the field team that nobody has opened yet.
 *
 * The roster above only knows about people who accepted, which left the screen
 * unable to answer the question a superadmin asks straight after pressing send:
 * *did that go anywhere?* An address sits here from the moment the mail leaves
 * until the link is opened, and can be withdrawn from here — so a typo is a
 * thing you take back rather than a mystery that never turns into a member.
 *
 * Scoped to `PLATFORM_AGENT`. Superadmin and moderator invitations are a
 * privilege matter and belong on the admin roster, not on a screen about who is
 * out registering hostels.
 */
export async function listTeamInvites() {
  await connectToDatabase();

  const invites = await PlatformAdminInviteModel.find({
    role: Role.PLATFORM_AGENT,
    status: "PENDING",
  })
    .sort({ createdAt: -1 })
    .lean<
      {
        _id: Types.ObjectId;
        createdAt?: Date;
        email: string;
        expiresAt: Date;
        name?: string;
      }[]
    >();

  return {
    invites: invites.map((invite) => ({
      email: invite.email,
      /** Reported rather than filtered out: an expired row is why nobody came. */
      expired: invite.expiresAt.getTime() < Date.now(),
      expiresAt: invite.expiresAt.toISOString(),
      id: invite._id.toString(),
      invitedAt: invite.createdAt?.toISOString() ?? null,
      name: invite.name ?? "",
    })),
  };
}

/**
 * Every hostel the team has filed, across all agents, with who filed it.
 *
 * This is the superadmin's audit surface — the notes ask for it in as many
 * words — and it deliberately shows the agent's name on every row rather than
 * making a reader cross-reference the roster above.
 */
export async function listTeamRegistrations(limit = 200) {
  await connectToDatabase();

  const subscriptions = await HostelSubscriptionModel.find({
    agentId: { $ne: null },
    source: "TEAM",
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<SubscriptionRow[]>();

  const [hostels, agents, money, invoices] = await Promise.all([
    HostelModel.find({ _id: { $in: subscriptions.map((row) => row.hostelId) } })
      .select("name slug status")
      .lean<{ _id: Types.ObjectId; name?: string; slug?: string; status?: string }[]>(),
    UserModel.find({
      _id: { $in: subscriptions.map((row) => row.agentId).filter(Boolean) },
    })
      .select("name email")
      .lean<{ _id: Types.ObjectId; email?: string; name?: string }[]>(),
    ledgerBySubscription(subscriptions.map((row) => row._id)),
    // The plan's invoice, not the setup fee's: that is the number a due is asked about.
    SubscriptionInvoiceModel.find({
      kind: { $ne: "SETUP_FEE" },
      subscriptionId: { $in: subscriptions.map((row) => row._id) },
    })
      .select("invoiceNumber subscriptionId")
      .lean<{ invoiceNumber: string; subscriptionId: Types.ObjectId }[]>(),
  ]);

  const hostelById = new Map(hostels.map((hostel) => [hostel._id.toString(), hostel]));
  const agentById = new Map(agents.map((agent) => [agent._id.toString(), agent]));
  const invoiceBySubscription = new Map(
    invoices.map((invoice) => [invoice.subscriptionId.toString(), invoice.invoiceNumber]),
  );

  return {
    registrations: subscriptions.map((row) => {
      const paid = money.get(row._id.toString()) ?? EMPTY_LEDGER;
      const agent = row.agentId ? agentById.get(row.agentId.toString()) : null;
      const price = row.cycleTotal ?? 0;

      return {
        agentEmail: agent?.email ?? "",
        agentName: agent?.name ?? "Unknown",
        cashCollected: paid.cash,
        dueBy: row.dueBy?.toISOString() ?? null,
        hostelId: row.hostelId.toString(),
        hostelName: hostelById.get(row.hostelId.toString())?.name ?? "Unnamed hostel",
        hostelStatus: hostelById.get(row.hostelId.toString())?.status ?? "",
        invoiceNumber: invoiceBySubscription.get(row._id.toString()) ?? "",
        onlineCollected: paid.online,
        outstanding: paid.outstanding,
        paid: paid.total,
        planName: row.planName ?? "",
        price,
        registeredAt: row.createdAt?.toISOString() ?? null,
        setupFee: paid.setupFee,
        subscriptionStatus: row.status,
      };
    }),
  };
}
