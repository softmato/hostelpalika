/**
 * Resident Offer Program — `GET /resident/offer-program`.
 *
 * Typed off `getResidentOfferProgram` in
 * `apps/web/src/modules/offer-program/offer-program.service.ts`. Certified
 * receipts are not here: they ride on the payments payload
 * (`receipts[].certificationCode`), so the two screens cannot disagree.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

export type OfferKind = "FEE_OFF" | "GIFT";

export type OfferPerk = {
  description: string;
  giftValue: number | null;
  id: string;
  imageUrl: string;
  kind: OfferKind;
  /** Who gives it — "HostelPalika" when the platform owner left it blank. */
  partner: string;
  percentOff: number | null;
  title: string;
};

export type OfferAward = {
  appliedAmount: number | null;
  /** `Kartik 2083 BS` — the bill a fee-off was paid on. */
  appliedPeriod: string | null;
  awardedAt: string;
  id: string;
  kind: OfferKind;
  percentOff: number | null;
  quarterLabel: string;
  status: "AWARDED" | "APPLIED" | "DELIVERED" | "CANCELLED";
  title: string;
};

export type ResidentOfferProgram = {
  awards: OfferAward[];
  perks: OfferPerk[];
  quarter: {
    certifiedAmount: number;
    certifiedCount: number;
    key: string;
    /** `Shrawan – Aswin 2083 BS` */
    label: string;
  };
};

export async function getOfferProgram() {
  const response = await api.get<ApiEnvelope<ResidentOfferProgram>>("/resident/offer-program");

  return unwrap(response);
}

/** `50% off your next monthly fee`, or `Gift`. */
export function perkTerms(perk: { kind: OfferKind; percentOff: number | null }): string {
  return perk.kind === "FEE_OFF" ? `${perk.percentOff ?? 0}% off your next monthly fee` : "Gift";
}

export type PublicOfferPerks = {
  perks: OfferPerk[];
  /** `Shrawan – Aswin 2083 BS` */
  quarter: string;
};

/** The active catalogue for anyone — `GET /public/offer-perks`, no session. */
export async function getPublicOfferPerks() {
  const response = await api.get<ApiEnvelope<PublicOfferPerks>>("/public/offer-perks");

  return unwrap(response);
}
