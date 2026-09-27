import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { hostelNameKey } from "@/modules/hostels/hostel-name-key";
import { bsMonthsEnd } from "@hostel/shared/calendar/bs";
import { FreePlanClaimModel } from "@hostel/db/models/FreePlanClaim";
import { HostelModel } from "@hostel/db/models/Hostel";
import { UserModel } from "@hostel/db/models/User";

/**
 * Free months, once per building.
 *
 * A plan's free months are claimed by the **hostel**, and a hostel is a
 * building, not a Gmail address. So before a hostel is given any, it is matched
 * against every earlier claim — archived and purged hostels included — and any
 * one of these makes it the same building:
 *
 * - the map pin within {@link SAME_PIN_METRES};
 * - the same name (`hostelNameKey`) in the same area;
 * - the same PAN/VAT number;
 * - the same owner phone in the same area.
 *
 * The phone counts only inside one area: an owner may run two separate
 * hostels in two parts of town, and each is its own building.
 */

/** Two pins closer than this are one building. */
export const SAME_PIN_METRES = 50;

export type BuildingPrint = {
  area: string;
  lat: number | null;
  lng: number | null;
  nameKey: string;
  ownerPhone: string | null;
  panNumber: string | null;
};

/** The last ten digits, so `+977 980-0000000` and `9800000000` are one number. */
export function phoneKey(phone?: string | null) {
  const digits = (phone ?? "").replace(/\D/g, "");

  return digits.length >= 7 ? digits.slice(-10) : null;
}

/** Digits only. Anything that is not nine digits is no PAN at all. */
export function panKey(pan?: string | null) {
  const digits = (pan ?? "").replace(/\D/g, "");

  return digits.length === 9 ? digits : null;
}

export function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;

  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Is this earlier claim the same building? The whole rule, in one place. */
export function isSameBuilding(claim: BuildingPrint, print: BuildingPrint) {
  const sameArea = Boolean(print.area) && claim.area === print.area;

  if (print.nameKey && sameArea && claim.nameKey === print.nameKey) return true;
  if (print.panNumber && claim.panNumber === print.panNumber) return true;
  if (print.ownerPhone && sameArea && claim.ownerPhone === print.ownerPhone) return true;

  return (
    print.lat !== null &&
    print.lng !== null &&
    claim.lat !== null &&
    claim.lng !== null &&
    metresBetween(
      { lat: claim.lat, lng: claim.lng },
      { lat: print.lat, lng: print.lng },
    ) <= SAME_PIN_METRES
  );
}

async function buildingPrint(hostelId: Types.ObjectId): Promise<BuildingPrint | null> {
  const hostel = await HostelModel.findById(hostelId)
    .select("contact location name ownerId panNumber")
    .lean<{
      contact?: { phone?: string };
      location?: { area?: string; lat?: number; lng?: number };
      name?: string;
      ownerId?: Types.ObjectId;
      panNumber?: string;
    } | null>();

  if (!hostel) return null;

  const owner = hostel.ownerId
    ? await UserModel.findById(hostel.ownerId).select("phone").lean<{ phone?: string } | null>()
    : null;

  return {
    area: (hostel.location?.area ?? "").trim().toLowerCase(),
    lat: typeof hostel.location?.lat === "number" ? hostel.location.lat : null,
    lng: typeof hostel.location?.lng === "number" ? hostel.location.lng : null,
    nameKey: hostelNameKey(hostel.name ?? ""),
    ownerPhone: phoneKey(owner?.phone ?? hostel.contact?.phone),
    panNumber: panKey(hostel.panNumber),
  };
}

/** The oldest earlier claim this building matches, if any. */
async function findEarlierClaim(print: BuildingPrint, hostelId: Types.ObjectId) {
  // ~0.0005° is ~55 m of latitude: a box a little wider than the circle.
  const box = 0.0005;
  const or: Record<string, unknown>[] = [];

  if (print.nameKey && print.area) or.push({ area: print.area, nameKey: print.nameKey });
  if (print.panNumber) or.push({ panNumber: print.panNumber });
  if (print.ownerPhone && print.area) or.push({ area: print.area, ownerPhone: print.ownerPhone });
  if (print.lat !== null && print.lng !== null) {
    or.push({
      lat: { $gte: print.lat - box, $lte: print.lat + box },
      lng: { $gte: print.lng - box, $lte: print.lng + box },
    });
  }

  if (or.length === 0) return null;

  const candidates = await FreePlanClaimModel.find({ $or: or, hostelId: { $ne: hostelId } })
    .sort({ claimedAt: 1 })
    .lean<Array<BuildingPrint & { hostelId: Types.ObjectId }>>();

  return candidates.find((claim) => isSameBuilding(claim, print)) ?? null;
}

/**
 * The free months this hostel gets on this plan — claimed now, once.
 *
 * Idempotent on the hostel: a second call returns the first answer, so going
 * live twice (an approval retried, a team filing replayed) never grants a
 * second period. The row is written even when the answer is zero, so this
 * building is fingerprinted for whoever registers it next.
 */
export async function claimFreeMonths(
  hostelId: Types.ObjectId | string,
  plan: { freeMonths?: number; id: string },
) {
  await connectToDatabase();

  const id = typeof hostelId === "string" ? new Types.ObjectId(hostelId) : hostelId;
  const existing = await FreePlanClaimModel.findOne({ hostelId: id })
    .select("freeMonths matchedHostelId")
    .lean<{ freeMonths: number; matchedHostelId?: Types.ObjectId | null } | null>();

  if (existing) {
    return { freeMonths: existing.freeMonths, matchedHostelId: existing.matchedHostelId ?? null };
  }

  const print = await buildingPrint(id);
  const earlier = print ? await findEarlierClaim(print, id) : null;
  const freeMonths = earlier ? 0 : Math.max(0, plan.freeMonths ?? 0);

  // Upsert, not create: two go-lives racing each other land on one row.
  const row = await FreePlanClaimModel.findOneAndUpdate(
    { hostelId: id },
    {
      $setOnInsert: {
        ...(print ?? {}),
        claimedAt: new Date(),
        freeMonths,
        hostelId: id,
        matchedHostelId: earlier?.hostelId ?? null,
        planId: plan.id,
      },
    },
    { new: true, upsert: true },
  ).lean<{ freeMonths: number; matchedHostelId?: Types.ObjectId | null } | null>();

  return { freeMonths: row?.freeMonths ?? freeMonths, matchedHostelId: row?.matchedHostelId ?? null };
}

/**
 * Which free month a hostel is in: `month` of `of`, with `left` more after it.
 * `null` once the free months are over, or for a hostel given none. **Pure.**
 *
 * Months are the plan's own BS months from the day it went live, so month 2
 * of a plan started on Bhadra 26 begins on Aswin 26 — the same boundaries
 * `freeUntil` was cut on.
 */
export function freeMonthOf(
  input: { activatedAt?: Date | null; freeMonths?: number | null; freeUntil?: Date | null },
  now = new Date(),
) {
  const { activatedAt, freeMonths, freeUntil } = input;

  if (!activatedAt || !freeUntil || !freeMonths || now.getTime() > freeUntil.getTime()) {
    return null;
  }

  for (let month = 1; month <= freeMonths; month += 1) {
    const endsAt = bsMonthsEnd(activatedAt, month);

    if (now.getTime() <= endsAt.getTime()) {
      return { endsAt, left: freeMonths - month, month, of: freeMonths };
    }
  }

  return null;
}
