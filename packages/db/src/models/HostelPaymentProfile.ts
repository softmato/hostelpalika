import { Schema, model, models } from "mongoose";

/**
 * How residents pay this hostel (target §4.1, fixes current §7.11).
 *
 * There was nowhere in the schema to record a hostel's eSewa ID, bank account or
 * payment QR — the product asked residents for proof of a payment it gave them
 * no instructions for, and every hostel communicated that out of band.
 *
 * One profile per hostel (target §16.5): merchant and bank accounts belong to a
 * legal entity, and reference-code prefixes are per hostel, so an owner with
 * three hostels has three profiles.
 */

/**
 * One provider's configuration, on the hostel that owns it (plan item 6.1).
 *
 * An array rather than the single `gatewayProvider` column this replaced,
 * because a hostel takes eSewa *and* Khalti, not one of them. The single column
 * would have made the second provider a migration; nothing had ever written it,
 * so it was removed outright rather than carried as dead compatibility.
 *
 * **No secret and no secret reference live here.** The signing key is found by
 * `{hostelId, provider, purpose}` in `EncryptedSecret`. A `secretRef` per entry
 * would be a second source of truth for the same relationship, and the two would
 * eventually disagree — at which point a hostel signs with another provider's
 * key. This document is also read on every resident pay screen, so a secret
 * reachable from it is a secret pulled into every one of those requests.
 */
const gatewayConfigSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["ESEWA", "FONEPAY", "KHALTI"],
      required: true,
    },
    /**
     * Whether this is a registered merchant account or somebody's personal
     * wallet.
     *
     * Load-bearing for Fonepay: a personal Fonepay QR caps at NPR 5,000 credited
     * per day, so a hostel collecting 12,000 rents through one has residents'
     * payments silently rejected mid-month. `PERSONAL` can therefore never be
     * enabled as a gateway — it is shown as a manual method with the cap stated,
     * and the owner is pointed at their bank account instead.
     */
    accountKind: {
      type: String,
      enum: ["MERCHANT", "PERSONAL"],
      default: "MERCHANT",
    },
    /**
     * The provider's public identifier for this merchant — eSewa's product code,
     * Fonepay's merchant code. Not a secret: it names whose account is credited
     * and is echoed back in every callback. Khalti identifies the merchant by its
     * key alone and leaves this empty.
     */
    merchantCode: { type: String, trim: true },
    /**
     * Which of the provider's environments this entry talks to.
     *
     * Stored per entry rather than inferred from `NODE_ENV` so a production
     * deployment can run one hostel against sandbox for a live acceptance test
     * without every other hostel following it there.
     */
    mode: { type: String, enum: ["LIVE", "SANDBOX"], default: "SANDBOX" },
    /** Null until the owner finishes setup. Clearing it is the rollback. */
    enabledAt: Date,
    /** Last callback or verification we saw. Silence here drives health (6.7). */
    lastEventAt: Date,
    /** Last time we successfully reached the provider's API with these details. */
    lastVerifiedAt: Date,
    /** Why we turned it off, when we did it rather than the owner. */
    disabledReason: { type: String, trim: true },

    // ---- Health (item 6.7) ----
    /**
     * What the last health check concluded.
     *
     * Stored rather than computed on read because the alert needs to know
     * whether this is *new*. A provider that has been failing for three days
     * should be mailed about once, not every time the job runs.
     */
    healthStatus: {
      type: String,
      enum: ["DEGRADED", "FAILING", "HEALTHY", "QUIET", "UNKNOWN"],
      default: "UNKNOWN",
    },
    healthCheckedAt: Date,
    /**
     * The sentence behind the status, stored so the setup screen can show it
     * without recounting a week of attempts on every page load.
     */
    healthDetail: { type: String, trim: true },
    /** When we last told the owner. Throttles a daily job into a useful alert. */
    healthNotifiedAt: Date,

    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

/**
 * A second bank, a second wallet — accounts beyond the one of each kind the
 * profile's own fields hold. Residents see every one on the pay screen, and a
 * receipt paid into any of them matches the hostel as payee.
 */
const extraAccountSchema = new Schema(
  {
    kind: { type: String, enum: ["BANK", "ESEWA", "KHALTI"], required: true },
    bankName: { type: String, trim: true },
    accountName: { type: String, trim: true },
    number: { type: String, trim: true, required: true },
  },
  { _id: false },
);

const hostelPaymentProfileSchema = new Schema(
  {
    hostelId: {
      ref: "Hostel",
      required: true,
      type: Schema.Types.ObjectId,
      unique: true,
    },
    /** Shown on the resident's pay screen, and must match the QR's registered name. */
    displayName: { type: String, trim: true },

    // ---- Tier 0. At least one of these makes the profile usable. ----
    staticQrAssetId: { ref: "FileAsset", type: Schema.Types.ObjectId },
    esewaId: { type: String, trim: true },
    khaltiId: { type: String, trim: true },
    bankName: { type: String, trim: true },
    bankAccountName: { type: String, trim: true },
    bankAccountNumber: { type: String, trim: true },
    extraAccounts: { type: [extraAccountSchema], default: [] },
    /**
     * Who the QR poster says it pays, read off the image at upload.
     *
     * A static QR prints the account holder and the account/wallet number beside
     * the code, so a QR-only hostel has already given us its payee identity —
     * `evidence-payee.ts` simply had no way to reach it, and returned `UNKNOWN`
     * on every claim such a hostel received. These carry that identity into the
     * database, where the payee check can compare a receipt against it.
     *
     * `qrPayeeSource` exists so a re-upload knows what it may overwrite: an
     * `OCR` value is ours to replace with a fresh read, a `MANUAL` one was typed
     * by an admin who saw the poster with their own eyes and outranks us.
     */
    qrPayeeName: { type: String, trim: true },
    qrPayeeNumber: { type: String, trim: true },
    qrPayeeSource: { enum: ["OCR", "MANUAL"], type: String },
    /** Free text shown under the QR, e.g. "please add your room number". */
    paymentInstructions: { type: String, trim: true },

    // ---- Tier 1. One entry per provider the hostel accepts (item 6.1). ----
    gateways: { type: [gatewayConfigSchema], default: [] },

    /**
     * Cash above this needs a second approver (target §9.1). Per hostel because
     * NPR 20,000 is a routine month's rent in one hostel and a red flag in
     * another — a platform-wide number would be wrong for everybody. Zero means
     * every cash entry needs two people; a hostel that wants none sets it high
     * deliberately, which is a decision on the record rather than a default.
     */
    cashApprovalThreshold: { default: 20000, min: 0, type: Number },

    // ---- Statement import (Tier 0.5) ----
    lastStatementUploadAt: Date,
    statementCadenceDays: { type: Number, default: 7, min: 1 },

    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

export type PaymentTier = "TIER_0" | "TIER_1";

export type ExtraPaymentAccount = {
  accountName?: string | null;
  bankName?: string | null;
  kind: "BANK" | "ESEWA" | "KHALTI";
  number: string;
};
export type GatewayProviderName = "ESEWA" | "FONEPAY" | "KHALTI";
export type GatewayAccountKind = "MERCHANT" | "PERSONAL";
export type GatewayMode = "LIVE" | "SANDBOX";

export type GatewayHealthStatus =
  | "DEGRADED"
  | "FAILING"
  | "HEALTHY"
  | "QUIET"
  | "UNKNOWN";

export type GatewayConfig = {
  accountKind?: GatewayAccountKind;
  disabledReason?: string | null;
  enabledAt?: Date | null;
  healthCheckedAt?: Date | null;
  healthDetail?: string | null;
  healthNotifiedAt?: Date | null;
  healthStatus?: GatewayHealthStatus;
  lastEventAt?: Date | null;
  lastVerifiedAt?: Date | null;
  merchantCode?: string | null;
  mode?: GatewayMode;
  provider: GatewayProviderName;
};

type ProfileWithGateways = { gateways?: GatewayConfig[] | null } | null;

/**
 * What a personal Fonepay wallet can receive in a day, in rupees.
 *
 * Stated in one place because it is the reason personal accounts are refused as
 * a gateway. A hostel collecting 12,000 rents into one has payments start
 * failing partway through the month, and the resident sees the provider's
 * rejection rather than anything we could explain.
 */
export const FONEPAY_PERSONAL_DAILY_LIMIT = 5000;

/**
 * The entries a resident may actually be sent to.
 *
 * Eligibility is part of the filter, not a separate check callers remember to
 * make. An entry can be marked enabled and still be unusable — a personal wallet
 * is the case this exists for — and counting one of those as a live gateway
 * makes the pay screen claim the hostel can be paid while rendering nothing.
 *
 * The environment rule lives in `isGatewayPayable` rather than here, because
 * this module has no business reading `NODE_ENV`.
 */
export function enabledGateways(profile: ProfileWithGateways): GatewayConfig[] {
  return (profile?.gateways ?? []).filter(
    (entry) => Boolean(entry?.enabledAt) && isGatewayEligible(entry),
  );
}

export function findGateway(
  profile: ProfileWithGateways,
  provider: GatewayProviderName,
): GatewayConfig | null {
  return (profile?.gateways ?? []).find((entry) => entry?.provider === provider) ?? null;
}

/**
 * Whether this entry may be switched on at all.
 *
 * A personal wallet never may — see {@link FONEPAY_PERSONAL_DAILY_LIMIT}. Khalti
 * identifies its merchant by key alone, so it is the one provider that needs no
 * merchant code; the others cannot sign a request without one.
 */
export function isGatewayEligible(entry: GatewayConfig | null): boolean {
  if (!entry || entry.accountKind === "PERSONAL") {
    return false;
  }

  return entry.provider === "KHALTI" ? true : Boolean(entry.merchantCode);
}

/**
 * Tier is **derived, never stored** (target §4.1).
 *
 * A stored column can disagree with reality — a hostel whose gateway was
 * disabled but whose `tier` column still said TIER_1 would send residents to a
 * dead payment screen. Deriving it means the two cannot drift apart. Rollback
 * for Block 6 is exactly this: clear every `enabledAt` and the hostel falls back
 * to Tier 0, which stays fully functional.
 *
 * Exported as a plain function because virtuals do not survive `.lean()`, and
 * every read path in this codebase is lean. One definition, both call styles.
 */
export function resolvePaymentTier(profile: ProfileWithGateways): PaymentTier {
  return enabledGateways(profile).length > 0 ? "TIER_1" : "TIER_0";
}

/**
 * Whether residents can actually be told how to pay. A profile with no QR, no
 * wallet id, no bank account and no live gateway is an empty form, not a payment
 * method — the resident pay screen must say "your hostel has not set this up
 * yet" rather than render a blank card.
 */
export function isPaymentProfileUsable(
  profile:
    | ({
        bankAccountNumber?: string | null;
        esewaId?: string | null;
        extraAccounts?: ExtraPaymentAccount[] | null;
        khaltiId?: string | null;
        staticQrAssetId?: unknown;
      } & { gateways?: GatewayConfig[] | null })
    | null,
): boolean {
  return Boolean(
    profile &&
      (profile.staticQrAssetId ||
        profile.esewaId ||
        profile.khaltiId ||
        profile.bankAccountNumber ||
        (profile.extraAccounts?.length ?? 0) > 0 ||
        enabledGateways(profile).length > 0),
  );
}

hostelPaymentProfileSchema.virtual("tier").get(function tierVirtual(this: {
  gateways?: GatewayConfig[] | null;
}) {
  return resolvePaymentTier(this);
});

hostelPaymentProfileSchema.set("toJSON", { virtuals: true });
hostelPaymentProfileSchema.set("toObject", { virtuals: true });

export const HostelPaymentProfileModel =
  models.HostelPaymentProfile ||
  model("HostelPaymentProfile", hostelPaymentProfileSchema);
