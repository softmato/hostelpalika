import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  claimCounts,
  SCORE_RULES,
  SCORED_SOURCES,
  scoreEntries,
  type ScoreEvent,
  type ScoreInvoice,
} from "@/modules/finance/credit-score.rules";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { ensureResidentPaymentCode } from "@/modules/finance/reference-sequence.service";
import { findCurrentResident } from "@/modules/residents/resident-access";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ResidentModel } from "@hostel/db/models/Resident";

/** Every source the score or the claim counts read — one query feeds both. */
const READ_SOURCES = [...SCORED_SOURCES];

async function eventsAndInvoices(residentIds: Types.ObjectId[], invoiceId?: string) {
  const events = await PaymentEventModel.find({
    direction: "CREDIT",
    ...(invoiceId ? { invoiceId } : {}),
    residentId: { $in: residentIds },
    source: { $in: READ_SOURCES },
  })
    .select("createdAt direction invoiceId occurredAt residentId reversedByEventId settledAt source status")
    .lean<(ScoreEvent & { residentId: Types.ObjectId })[]>();
  const invoiceIds = [...new Set(events.map((event) => event.invoiceId?.toString()).filter(Boolean))];
  const invoices = invoiceIds.length
    ? await InvoiceModel.find({ _id: { $in: invoiceIds }, kind: "MONTHLY_RENT" })
        .select("coversFrom kind period")
        .lean<ScoreInvoice[]>()
    : [];

  return { events, invoices };
}

export type CreditScore = {
  approved: number;
  history: { day: number; invoiceId: string; paidAt: string; period: string; points: number; source: string }[];
  paymentCode: string | null;
  rules: typeof SCORE_RULES;
  score: number;
  shared: number;
};

async function scoreFor(resident: { _id: Types.ObjectId; hostelId: Types.ObjectId }): Promise<CreditScore> {
  const [{ events, invoices }, paymentCode] = await Promise.all([
    eventsAndInvoices([resident._id]),
    ensureResidentPaymentCode(resident.hostelId, resident._id).catch(() => null),
  ]);
  const entries = scoreEntries(invoices, events);
  const counts = claimCounts(events);

  return {
    approved: counts.approved,
    history: entries.map((entry) => ({
      day: entry.day,
      invoiceId: entry.invoiceId,
      paidAt: entry.paidAt.toISOString(),
      period: entry.period,
      points: entry.points,
      source: entry.source,
    })),
    paymentCode,
    rules: SCORE_RULES,
    score: entries.reduce((sum, entry) => sum + entry.points, 0),
    shared: counts.shared,
  };
}

/** B4: the signed-in resident's own score, counts and history. */
export async function getMyCreditScore(principal: ApiPrincipal): Promise<CreditScore> {
  await connectToDatabase();

  const resident = (await findCurrentResident(principal)) as unknown as {
    _id: Types.ObjectId;
    hostelId: Types.ObjectId;
  };

  return scoreFor(resident);
}

/** B4: one resident's score, for that hostel's admin or warden. */
export async function getResidentCreditScore(
  hostelId: Types.ObjectId | string,
  residentId: string,
): Promise<CreditScore> {
  await connectToDatabase();

  const resident = Types.ObjectId.isValid(residentId)
    ? await ResidentModel.findOne({ _id: residentId, hostelId, isDeleted: { $ne: true } })
        .select("hostelId")
        .lean<{ _id: Types.ObjectId; hostelId: Types.ObjectId } | null>()
    : null;

  if (!resident) {
    throw new FinanceServiceError("Resident was not found.", "RESIDENT_NOT_FOUND");
  }

  return scoreFor(resident);
}

/** Todo C3: the points this settlement earned — 0 when an earlier payment on the bill already did. */
export async function pointsEarnedBy(
  residentId: Types.ObjectId,
  invoiceId: string,
  eventId: string,
): Promise<number> {
  const { events, invoices } = await eventsAndInvoices([residentId], invoiceId);

  return scoreEntries(invoices, events).find((entry) => entry.eventId === eventId)?.points ?? 0;
}

/** D4: scores for many residents at once (Offer Program ranking). */
export async function creditScoresFor(residentIds: Types.ObjectId[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();

  if (residentIds.length === 0) return scores;

  const { events, invoices } = await eventsAndInvoices(residentIds);
  const byResident = new Map<string, typeof events>();

  for (const event of events) {
    const key = event.residentId.toString();
    byResident.set(key, [...(byResident.get(key) ?? []), event]);
  }

  for (const [key, list] of byResident) {
    scores.set(key, scoreEntries(invoices, list).reduce((sum, entry) => sum + entry.points, 0));
  }

  return scores;
}
