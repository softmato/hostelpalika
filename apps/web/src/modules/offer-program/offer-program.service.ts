import type { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { formatBsPeriod } from "@/lib/hostel-day";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { appendEvent, settleEvent } from "@/modules/finance/payment-event.service";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import {
  feeOffAmount,
  isOfferQuarter,
  offerQuarterBounds,
  offerQuarterOf,
  shiftOfferQuarter,
} from "@/modules/offer-program/offer-program.rules";
import type {
  awardCreateSchema,
  perkCreateSchema,
  perkUpdateSchema,
} from "@/modules/offer-program/offer-program.validation";
import { findCurrentResident, normalizeObjectId } from "@/modules/residents/resident-access";
import {
  appUrl,
  resolveResidentContact,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { offerAwardedEmail } from "@hostel/shared/email/templates/resident/offer-awarded";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { OfferAwardModel } from "@hostel/db/models/OfferAward";
import { OfferPerkModel } from "@hostel/db/models/OfferPerk";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * The Resident Offer Program.
 *
 * A receipt is certified when its payment quoted the invoice's reference code
 * and was verified (see `qualifiesForOfferProgram`). Every quarter — three BS
 * months — the platform owner looks at who holds certified receipts and gives
 * some of them a perk from the catalogue: a share of their next monthly fee,
 * paid by HostelPalika, or a gift.
 */

export class OfferProgramError extends Error {
  constructor(
    message: string,
    public errorCode = "OFFER_PROGRAM_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

type PerkRecord = {
  _id: Types.ObjectId;
  description?: string;
  giftValue?: number | null;
  imageUrl?: string;
  isActive: boolean;
  kind: "FEE_OFF" | "GIFT";
  partner?: string;
  percentOff?: number | null;
  sortOrder: number;
  title: string;
};

type AwardRecord = {
  _id: Types.ObjectId;
  appliedAmount?: number | null;
  appliedAt?: Date | null;
  appliedInvoiceId?: Types.ObjectId | null;
  cancelledAt?: Date | null;
  createdAt: Date;
  deliveredAt?: Date | null;
  hostelId: Types.ObjectId;
  hostelPaidAt?: Date | null;
  kind: "FEE_OFF" | "GIFT";
  note?: string;
  percentOff?: number | null;
  quarter: string;
  residentId: Types.ObjectId;
  status: "AWARDED" | "APPLIED" | "DELIVERED" | "CANCELLED";
  title: string;
};

type ResidentRecord = {
  _id: Types.ObjectId;
  email?: string;
  firstName: string;
  fullName?: string;
  hostelId: Types.ObjectId;
  isDeleted?: boolean;
  lastName: string;
  status?: string;
  userId?: Types.ObjectId;
};

const OPEN_INVOICE_STATUSES = ["OPEN", "PARTIAL", "OVERDUE"];

/** A certified receipt, not voided, certified inside `[from, to]`. */
function certifiedIn(from: Date, to: Date) {
  return {
    certificationCode: { $type: "string" },
    certifiedAt: { $gte: from, $lte: to },
    voidedAt: null,
  };
}

function serializePerk(perk: PerkRecord) {
  return {
    description: perk.description ?? "",
    giftValue: perk.giftValue ?? null,
    id: perk._id.toString(),
    imageUrl: perk.imageUrl ?? "",
    isActive: perk.isActive,
    kind: perk.kind,
    partner: perk.partner || PLATFORM_NAME,
    percentOff: perk.percentOff ?? null,
    sortOrder: perk.sortOrder ?? 0,
    title: perk.title,
  };
}

function quarterLabel(quarter: string) {
  return isOfferQuarter(quarter) ? offerQuarterBounds(quarter).label : quarter;
}

function serializeAward(award: AwardRecord, appliedPeriod?: string | null) {
  return {
    appliedAmount: award.appliedAmount ?? null,
    appliedAt: award.appliedAt?.toISOString() ?? null,
    /** `Kartik 2083 BS` — which month's fee it came off. */
    appliedPeriod: appliedPeriod ? formatBsPeriod(appliedPeriod) || appliedPeriod : null,
    awardedAt: award.createdAt.toISOString(),
    deliveredAt: award.deliveredAt?.toISOString() ?? null,
    hostelPaidAt: award.hostelPaidAt?.toISOString() ?? null,
    id: award._id.toString(),
    kind: award.kind,
    note: award.note ?? "",
    percentOff: award.percentOff ?? null,
    quarter: award.quarter,
    quarterLabel: quarterLabel(award.quarter),
    status: award.status,
    title: award.title,
  };
}

function residentName(resident?: Partial<ResidentRecord> | null) {
  return (
    resident?.fullName ||
    [resident?.firstName, resident?.lastName].filter(Boolean).join(" ") ||
    "Resident"
  );
}

async function periodsByInvoice(awards: AwardRecord[]) {
  const ids = awards.flatMap((award) => (award.appliedInvoiceId ? [award.appliedInvoiceId] : []));

  if (ids.length === 0) {
    return new Map<string, string>();
  }

  const invoices = await InvoiceModel.find({ _id: { $in: ids } })
    .select("period")
    .lean<{ _id: Types.ObjectId; period?: string | null }[]>();

  return new Map(invoices.map((invoice) => [invoice._id.toString(), invoice.period ?? ""]));
}

/* -------------------------------------------------------------------------- */
/* Resident                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The resident's own programme: this quarter's certified total, the catalogue,
 * and what they have been given. Certified receipts themselves come with the
 * payments payload, so this does not repeat them.
 */
export async function getResidentOfferProgram(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = (await findCurrentResident(principal)) as unknown as ResidentRecord;
  const quarter = offerQuarterBounds(offerQuarterOf(new Date()));

  const [totals, perks, awards] = await Promise.all([
    ReceiptModel.aggregate<{ amount: number; count: number }>([
      { $match: { residentId: resident._id, ...certifiedIn(quarter.from, quarter.to) } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    OfferPerkModel.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean<PerkRecord[]>(),
    OfferAwardModel.find({ residentId: resident._id, status: { $ne: "CANCELLED" } })
      .sort({ createdAt: -1 })
      .lean<AwardRecord[]>(),
  ]);

  const periods = await periodsByInvoice(awards);

  return {
    awards: awards.map((award) =>
      serializeAward(award, periods.get(award.appliedInvoiceId?.toString() ?? "")),
    ),
    perks: perks.map(serializePerk),
    quarter: {
      certifiedAmount: totals[0]?.amount ?? 0,
      certifiedCount: totals[0]?.count ?? 0,
      from: quarter.from.toISOString(),
      key: quarter.key,
      label: quarter.label,
      to: quarter.to.toISOString(),
    },
  };
}

/**
 * The catalogue as anyone may see it — what a resident can earn this quarter,
 * for the public explainer. Active perks only, and nothing about any resident.
 */
export async function getPublicOfferPerks() {
  await connectToDatabase();

  const perks = await OfferPerkModel.find({ isActive: true })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean<PerkRecord[]>();

  return {
    perks: perks.map((perk) => {
      const { description, giftValue, id, imageUrl, kind, partner, percentOff, title } =
        serializePerk(perk);
      return { description, giftValue, id, imageUrl, kind, partner, percentOff, title };
    }),
    quarter: offerQuarterBounds(offerQuarterOf(new Date())).label,
  };
}

/* -------------------------------------------------------------------------- */
/* Platform owner                                                             */
/* -------------------------------------------------------------------------- */

function resolveQuarter(input?: string | null) {
  const current = offerQuarterOf(new Date());
  const key = isOfferQuarter(input) && input <= current ? input : current;

  try {
    return { bounds: offerQuarterBounds(key), current };
  } catch {
    // Outside the BS conversion table.
    return { bounds: offerQuarterBounds(current), current };
  }
}

/**
 * One quarter at a glance: who is eligible, who has been given what, the
 * catalogue, and what HostelPalika still owes hostels for fee-off awards.
 *
 * Eligible = at least one certified receipt in the quarter. Sorted by how many
 * different bills were certified, then by amount — a resident who paid all
 * three months with their code comes before one who paid one month in parts.
 */
export async function getOfferProgramOverview(quarterInput?: string | null) {
  await connectToDatabase();

  const { bounds, current } = resolveQuarter(quarterInput);

  const [groups, awards, perks, owed] = await Promise.all([
    ReceiptModel.aggregate<{
      _id: Types.ObjectId;
      amount: number;
      bills: number;
      count: number;
      hostelId: Types.ObjectId;
    }>([
      { $match: certifiedIn(bounds.from, bounds.to) },
      {
        $group: {
          _id: "$residentId",
          amount: { $sum: "$amount" },
          bills: { $addToSet: "$invoiceId" },
          count: { $sum: 1 },
          hostelId: { $first: "$hostelId" },
        },
      },
      { $project: { amount: 1, bills: { $size: "$bills" }, count: 1, hostelId: 1 } },
      { $sort: { bills: -1, amount: -1 } },
      // ponytail: first 500 only; page this when a quarter has more certified residents.
      { $limit: 500 },
    ]),
    OfferAwardModel.find({ quarter: bounds.key }).sort({ createdAt: -1 }).lean<AwardRecord[]>(),
    OfferPerkModel.find({}).sort({ sortOrder: 1, createdAt: 1 }).lean<PerkRecord[]>(),
    OfferAwardModel.aggregate<{ amount: number; count: number }>([
      { $match: { hostelPaidAt: null, status: "APPLIED" } },
      { $group: { _id: null, amount: { $sum: "$appliedAmount" }, count: { $sum: 1 } } },
    ]),
  ]);

  const residentIds = [
    ...groups.map((group) => group._id),
    ...awards.map((award) => award.residentId),
  ];
  const hostelIds = [
    ...groups.map((group) => group.hostelId),
    ...awards.map((award) => award.hostelId),
  ];

  const [residents, hostels, periods] = await Promise.all([
    ResidentModel.find({ _id: { $in: residentIds } })
      .select("firstName fullName lastName status isDeleted")
      .lean<ResidentRecord[]>(),
    HostelModel.find({ _id: { $in: hostelIds } })
      .select("name")
      .lean<{ _id: Types.ObjectId; name?: string }[]>(),
    periodsByInvoice(awards),
  ]);

  const residentById = new Map(residents.map((resident) => [resident._id.toString(), resident]));
  const hostelName = new Map(hostels.map((hostel) => [hostel._id.toString(), hostel.name ?? "Hostel"]));
  const awardByResident = new Map(awards.map((award) => [award.residentId.toString(), award]));

  const who = (residentId: Types.ObjectId, hostelId: Types.ObjectId) => {
    const resident = residentById.get(residentId.toString());

    return {
      hostelName: hostelName.get(hostelId.toString()) ?? "Hostel",
      residentId: residentId.toString(),
      residentName: residentName(resident),
      residentStatus: resident?.isDeleted ? "DELETED" : (resident?.status ?? "UNKNOWN"),
    };
  };

  return {
    awards: awards.map((award) => ({
      ...serializeAward(award, periods.get(award.appliedInvoiceId?.toString() ?? "")),
      ...who(award.residentId, award.hostelId),
    })),
    eligible: groups.map((group) => {
      const award = awardByResident.get(group._id.toString());

      return {
        ...who(group._id, group.hostelId),
        award: award ? { id: award._id.toString(), status: award.status, title: award.title } : null,
        bills: group.bills,
        certifiedAmount: group.amount,
        certifiedCount: group.count,
      };
    }),
    owedToHostels: { amount: owed[0]?.amount ?? 0, count: owed[0]?.count ?? 0 },
    perks: perks.map(serializePerk),
    quarter: {
      from: bounds.from.toISOString(),
      isCurrent: bounds.key === current,
      key: bounds.key,
      label: bounds.label,
      next: bounds.key < current ? shiftOfferQuarter(bounds.key, 1) : null,
      previous: shiftOfferQuarter(bounds.key, -1),
      to: bounds.to.toISOString(),
    },
  };
}

async function audit(
  principal: ApiPrincipal,
  action: string,
  entity: { id: Types.ObjectId; type: string },
  metadata: Record<string, unknown>,
  hostelId?: Types.ObjectId,
) {
  try {
    await AuditLogModel.create({
      action,
      actorId: principal.userId,
      entityId: entity.id.toString(),
      entityType: entity.type,
      ...(hostelId ? { hostelId } : {}),
      metadata,
    });
  } catch {
    // Worth logging, never worth failing the change the owner just made.
  }
}

/* Catalogue ---------------------------------------------------------------- */

type PerkCreate = z.infer<typeof perkCreateSchema>;
type PerkUpdate = z.infer<typeof perkUpdateSchema>;

export async function createPerk(input: PerkCreate, principal: ApiPrincipal) {
  await connectToDatabase();

  const perk = (await OfferPerkModel.create({
    ...input,
    createdBy: principal.userId,
  })) as unknown as PerkRecord;

  await audit(principal, "OFFER_PERK_CREATED", { id: perk._id, type: "OfferPerk" }, { title: perk.title });

  return serializePerk(perk);
}

export async function updatePerk(perkId: string, input: PerkUpdate, principal: ApiPrincipal) {
  await connectToDatabase();

  const perk = await OfferPerkModel.findOneAndUpdate(
    { _id: normalizeObjectId(perkId, "perk id") },
    { $set: input },
    { new: true, runValidators: true },
  ).lean<PerkRecord | null>();

  if (!perk) {
    throw new OfferProgramError("Perk was not found.", "OFFER_PERK_NOT_FOUND", 404);
  }

  await audit(principal, "OFFER_PERK_UPDATED", { id: perk._id, type: "OfferPerk" }, { fields: Object.keys(input) });

  return serializePerk(perk);
}

/** Awards keep their own copy of the perk, so deleting one rewrites nothing. */
export async function deletePerk(perkId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const perk = await OfferPerkModel.findOneAndDelete({
    _id: normalizeObjectId(perkId, "perk id"),
  }).lean<PerkRecord | null>();

  if (!perk) {
    throw new OfferProgramError("Perk was not found.", "OFFER_PERK_NOT_FOUND", 404);
  }

  await audit(principal, "OFFER_PERK_DELETED", { id: perk._id, type: "OfferPerk" }, { title: perk.title });

  return { deleted: true };
}

/* Awards ------------------------------------------------------------------- */

type AwardCreate = z.infer<typeof awardCreateSchema>;

export async function awardOffer(input: AwardCreate, principal: ApiPrincipal) {
  await connectToDatabase();

  const { bounds, current } = resolveQuarter(input.quarter);

  if (bounds.key !== input.quarter || input.quarter > current) {
    throw new OfferProgramError("Offers are given for this quarter or an earlier one.", "OFFER_QUARTER_INVALID");
  }

  const [perk, resident] = await Promise.all([
    OfferPerkModel.findOne({ _id: normalizeObjectId(input.perkId, "perk id"), isActive: true }).lean<PerkRecord | null>(),
    ResidentModel.findOne({ _id: normalizeObjectId(input.residentId, "resident id"), isDeleted: false })
      .select("email firstName fullName hostelId lastName status userId")
      .lean<ResidentRecord | null>(),
  ]);

  if (!perk) {
    throw new OfferProgramError("That perk is not active.", "OFFER_PERK_NOT_FOUND", 404);
  }

  if (!resident) {
    throw new OfferProgramError("Resident was not found.", "RESIDENT_NOT_FOUND", 404);
  }

  const eligible = await ReceiptModel.exists({
    residentId: resident._id,
    ...certifiedIn(bounds.from, bounds.to),
  });

  if (!eligible) {
    throw new OfferProgramError(
      `${residentName(resident)} has no certified receipt in ${bounds.label}.`,
      "OFFER_NOT_ELIGIBLE",
    );
  }

  let award: AwardRecord;

  try {
    award = (await OfferAwardModel.create({
      awardedBy: principal.userId,
      hostelId: resident.hostelId,
      kind: perk.kind,
      note: input.note,
      percentOff: perk.kind === "FEE_OFF" ? perk.percentOff : null,
      perkId: perk._id,
      quarter: bounds.key,
      residentId: resident._id,
      title: perk.title,
      userId: resident.userId ?? null,
    })) as unknown as AwardRecord;
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      throw new OfferProgramError(
        `${residentName(resident)} already has an offer for ${bounds.label}.`,
        "OFFER_ALREADY_AWARDED",
        409,
      );
    }

    throw error;
  }

  await audit(
    principal,
    "OFFER_AWARDED",
    { id: award._id, type: "OfferAward" },
    { kind: award.kind, quarter: award.quarter, residentId: resident._id.toString(), title: award.title },
    resident.hostelId,
  );

  if (award.kind === "FEE_OFF") {
    await applyPendingFeeOffs(resident._id, principal);
  }

  await notifyAward(award, resident, bounds.label);

  return serializeAward(
    (await OfferAwardModel.findOne({ _id: award._id }).lean<AwardRecord>()) ?? award,
  );
}

/**
 * Takes each waiting fee-off award off the resident's oldest open monthly bill.
 *
 * HostelPalika's money, recorded as a payment on the invoice — source
 * `OFFER_PROGRAM` — so the hostel's ledger reads the bill as paid and the
 * resident gets a receipt, exactly like any other payment. It never enters
 * statement matching, which only reads resident claims.
 *
 * Idempotent per award (`offer-award:<id>`): a crash between recording and
 * marking the award applied is finished by the next call, not repeated. Called
 * when an award is given and by the billing run after each new invoice.
 */
export async function applyPendingFeeOffs(
  residentId: Types.ObjectId | string,
  principal?: ApiPrincipal,
): Promise<number> {
  await connectToDatabase();

  const pending = await OfferAwardModel.find({ kind: "FEE_OFF", residentId, status: "AWARDED" })
    .sort({ createdAt: 1 })
    .lean<AwardRecord[]>();

  let applied = 0;
  const hostels = new Set<string>();

  for (const award of pending) {
    const invoice = await InvoiceModel.findOne({
      hostelId: award.hostelId,
      kind: "MONTHLY_RENT",
      residentId,
      status: { $in: OPEN_INVOICE_STATUSES },
      totalAmount: { $gt: 0 },
    })
      .sort({ period: 1 })
      .select("_id totalAmount")
      .lean<{ _id: Types.ObjectId; totalAmount: number } | null>();

    if (!invoice) {
      break;
    }

    const amount = feeOffAmount(invoice.totalAmount, award.percentOff ?? 0);

    if (amount < 1) {
      continue;
    }

    const { event } = await appendEvent({
      amount,
      confirmation: "MANUAL_REVIEW",
      hostelId: award.hostelId,
      idempotencyKey: `offer-award:${award._id.toString()}`,
      invoiceId: invoice._id,
      rawPayload: { awardId: award._id.toString(), fundedBy: PLATFORM_NAME, perk: award.title },
      residentId,
      source: "OFFER_PROGRAM",
      status: "PENDING",
    });

    if (event.status === "PENDING") {
      try {
        await settleEvent(event._id, { confirmation: "MANUAL_REVIEW", principal });
      } catch (error) {
        // A concurrent call settled it first — the money is on the bill once.
        if (!(error instanceof FinanceServiceError && error.errorCode === "SETTLED_EVENT_IMMUTABLE")) {
          throw error;
        }
      }
    }

    await OfferAwardModel.updateOne(
      { _id: award._id, status: "AWARDED" },
      {
        $set: {
          appliedAmount: event.amount,
          appliedAt: new Date(),
          appliedEventId: event._id,
          appliedInvoiceId: event.invoiceId ?? invoice._id,
          status: "APPLIED",
        },
      },
    );

    applied += 1;
    hostels.add(award.hostelId.toString());
  }

  if (applied > 0) {
    await publishResourceChange({ hostelIds: [...hostels], topics: [REALTIME_TOPIC.PAYMENTS] });
  }

  return applied;
}

/** The billing run's hook. Never throws: a bill that went out must not fail on a perk. */
export async function applyPendingFeeOffsQuietly(residentId: Types.ObjectId | string) {
  try {
    await applyPendingFeeOffs(residentId);
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "offer_fee_off_apply_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown error",
        residentId: residentId.toString(),
      }),
    );
  }
}

export type AwardAction = "cancel" | "deliver" | "hostel-paid";

/**
 * - `deliver` — a gift was handed over.
 * - `hostel-paid` — HostelPalika settled an applied fee-off with the hostel.
 * - `cancel` — withdrawn before use. An applied fee-off is money on a bill and
 *   is undone by reversing that payment, not from here.
 */
export async function updateAward(awardId: string, action: AwardAction, principal: ApiPrincipal) {
  await connectToDatabase();

  const now = new Date();
  const rules: Record<AwardAction, { filter: Record<string, unknown>; set: Record<string, unknown> }> = {
    cancel: { filter: { status: "AWARDED" }, set: { cancelledAt: now, status: "CANCELLED" } },
    deliver: { filter: { kind: "GIFT", status: "AWARDED" }, set: { deliveredAt: now, status: "DELIVERED" } },
    "hostel-paid": { filter: { hostelPaidAt: null, status: "APPLIED" }, set: { hostelPaidAt: now } },
  };
  const rule = rules[action];

  const award = await OfferAwardModel.findOneAndUpdate(
    { _id: normalizeObjectId(awardId, "award id"), ...rule.filter },
    { $set: rule.set },
    { new: true },
  ).lean<AwardRecord | null>();

  if (!award) {
    throw new OfferProgramError("That offer cannot be changed that way now.", "OFFER_AWARD_STATE", 409);
  }

  await audit(principal, `OFFER_AWARD_${action.toUpperCase().replace("-", "_")}`, { id: award._id, type: "OfferAward" }, { status: award.status }, award.hostelId);

  return serializeAward(award);
}

async function notifyAward(award: AwardRecord, resident: ResidentRecord, label: string) {
  try {
    const body =
      award.kind === "FEE_OFF"
        ? `${award.title}: ${award.percentOff}% of your next monthly fee, paid by ${PLATFORM_NAME}.`
        : `${award.title}: a gift from ${PLATFORM_NAME}. Our team will contact you.`;

    if (resident.userId) {
      await createInAppNotification({
        actionUrl: "/resident/offer-program",
        body,
        category: "PAYMENT",
        hostelId: resident.hostelId.toString(),
        kind: "NORMAL",
        title: "You got a Resident Offer Program offer",
        userId: resident.userId.toString(),
      });
    }

    const contact = await resolveResidentContact(resident);

    if (!contact) {
      return;
    }

    const email = offerAwardedEmail({
      kind: award.kind,
      offerProgramUrl: appUrl("/resident/offer-program"),
      percentOff: award.percentOff,
      quarterLabel: label,
      residentName: contact.name ?? resident.firstName,
      title: award.title,
    });

    await sendNotificationEmail({
      action: "offer_awarded",
      html: email.html,
      subject: email.subject,
      to: contact.email,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "offer_award_notification_failed",
        awardId: award._id.toString(),
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
      }),
    );
  }
}
