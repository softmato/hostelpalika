import { jwtVerify, SignJWT } from "jose";
import { Types } from "mongoose";

import { jwtSecret } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { siteUrl } from "@/lib/site";
import { HostelModel } from "@hostel/db/models/Hostel";

/**
 * The "Pay now" link in a plan email, opening the website's plan checkout
 * (`/plans-pricing/checkout`) on this hostel with no email-and-code step.
 *
 * The email is the proof: the code that step sends goes to the same inbox
 * this link arrived in. So the link carries what that step would have
 * established — this hostel, this owner — and nothing more. It buys a plan
 * checkout for one hostel; it does not sign anyone in to the portal, so a
 * forwarded email can at worst pay somebody's bill.
 *
 * Kept apart from `plan-checkout.service.ts` on purpose: the emails that sign
 * it live in modules that service itself imports.
 */

const LINK_TYPE = "plan-pay-link";
/** Long enough for an email read days later; the checkout it opens lasts an hour. */
const LINK_TTL = "14d";

type Billed = { _id: Types.ObjectId; ownerId?: Types.ObjectId; parentHostelId?: Types.ObjectId | null };

/** A branch pays on its main hostel, like everywhere else in plan billing. */
async function billed(filter: Record<string, unknown>): Promise<Billed | null> {
  await connectToDatabase();

  const hostel = await HostelModel.findOne({ ...filter, isDeleted: { $ne: true } })
    .select("_id ownerId parentHostelId")
    .lean<Billed | null>();

  if (!hostel?.parentHostelId) return hostel;

  return HostelModel.findOne({ _id: hostel.parentHostelId, isDeleted: { $ne: true } })
    .select("_id ownerId parentHostelId")
    .lean<Billed | null>();
}

/**
 * The link for this hostel, by id or slug. Falls back to `fallback` — the
 * signed-in billing page — when the hostel cannot be resolved, so an email is
 * never sent without a way to pay.
 */
export async function planPayLink(hostel: { id?: string; slug?: string }, fallback: string) {
  try {
    const row = await billed(
      hostel.id && Types.ObjectId.isValid(hostel.id) ? { _id: new Types.ObjectId(hostel.id) } : { slug: hostel.slug },
    );

    if (!row?.ownerId) return fallback;

    const token = await new SignJWT({ ownerId: row.ownerId.toString(), tokenType: LINK_TYPE })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(row._id.toString())
      .setIssuedAt()
      .setExpirationTime(LINK_TTL)
      .sign(jwtSecret("JWT_ACCESS_SECRET"));

    return `${siteUrl()}/plans-pricing/checkout?link=${encodeURIComponent(token)}`;
  } catch {
    return fallback;
  }
}

/** The hostel and owner a link names, or `null` when it is expired, forged, or the hostel changed hands. */
export async function readPlanPayLink(link: string) {
  try {
    const { payload } = await jwtVerify(link, jwtSecret("JWT_ACCESS_SECRET"));

    if (payload.tokenType !== LINK_TYPE || !payload.sub || typeof payload.ownerId !== "string") return null;

    const row = await billed({ _id: new Types.ObjectId(payload.sub) });

    return row && row.ownerId?.toString() === payload.ownerId
      ? { hostelId: row._id.toString(), ownerId: payload.ownerId }
      : null;
  } catch {
    return null;
  }
}
