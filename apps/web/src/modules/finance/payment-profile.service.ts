import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { readStoredObject } from "@/lib/uploads/verify";
import { hostelPayeeIdentity } from "@/modules/finance/evidence-payee";
import { readEvidenceText } from "@/modules/finance/evidence-ocr";
import { hasQrPayee, readQrPayeeFromImage } from "@/modules/finance/qr-payee";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import {
  enabledGateways,
  type ExtraPaymentAccount,
  type GatewayConfig,
  HostelPaymentProfileModel,
  isPaymentProfileUsable,
  resolvePaymentTier,
  type PaymentTier,
} from "@hostel/db/models/HostelPaymentProfile";

import type { PaymentProfileUpdateInput } from "./payment-profile.validation";

/**
 * The payment profile screen's service (target §11.8, plan item 3.1).
 *
 * This closes current §7.11: there was nowhere to record how a hostel takes
 * money, so the product asked residents for proof of a payment it gave them no
 * instructions for. Everything the resident pay screen (3.3) renders is read
 * from here, which is why `usable` is computed on the way out — a profile with a
 * display name and nothing else is an empty form, and the resident has to be
 * told that rather than shown a blank card.
 */

export type PaymentProfileView = {
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  cashApprovalThreshold: number;
  displayName: string | null;
  esewaId: string | null;
  /** Accounts beyond the one bank, eSewa and Khalti above. */
  extraAccounts: ExtraPaymentAccount[];
  /**
   * Which providers currently take online payments for this hostel. Derived
   * from the gateway entries, never stored — see `resolvePaymentTier`. The
   * setup screen reads the full entries through `gateway-config.service.ts`;
   * this is the summary every other caller needs.
   */
  enabledProviders: string[];
  khaltiId: string | null;
  lastStatementUploadAt: string | null;
  /**
   * Can a receipt be checked against this hostel at all?
   *
   * `usable` says residents have *somewhere* to send money; this says we can
   * recognise the hostel on the receipt that comes back. They are not the same
   * profile: a hostel with only a static QR is perfectly usable and yet every
   * claim it receives reads `UNKNOWN` on the payee — the one check a payer
   * cannot satisfy by typing is switched off, silently, for that hostel.
   *
   * Deliberately computed from `hostelPayeeIdentity` rather than from a second
   * list of fields, so the banner that nags for a credential and the check that
   * consumes it can never disagree about what counts as one.
   */
  payeeVerifiable: boolean;
  paymentInstructions: string | null;
  /** Read off the QR poster, or typed by the admin when it could not be read. */
  qrPayeeName: string | null;
  qrPayeeNumber: string | null;
  qrPayeeSource: "MANUAL" | "OCR" | null;
  staticQrAssetId: string | null;
  statementCadenceDays: number;
  tier: PaymentTier;
  /** False means the resident pay screen must say "not set up yet". */
  usable: boolean;
};

type ProfileDocument = {
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  cashApprovalThreshold?: number;
  displayName?: string | null;
  esewaId?: string | null;
  extraAccounts?: ExtraPaymentAccount[] | null;
  gateways?: GatewayConfig[] | null;
  khaltiId?: string | null;
  lastStatementUploadAt?: Date | null;
  paymentInstructions?: string | null;
  qrPayeeName?: string | null;
  qrPayeeNumber?: string | null;
  qrPayeeSource?: "MANUAL" | "OCR" | null;
  staticQrAssetId?: Types.ObjectId | null;
  statementCadenceDays?: number;
};

/** The shape every read returns for a hostel that has never opened the form. */
const EMPTY: ProfileDocument = {};

function toView(profile: ProfileDocument | null): PaymentProfileView {
  const source = profile ?? EMPTY;

  return {
    bankAccountName: source.bankAccountName ?? null,
    bankAccountNumber: source.bankAccountNumber ?? null,
    bankName: source.bankName ?? null,
    cashApprovalThreshold: source.cashApprovalThreshold ?? 20000,
    displayName: source.displayName ?? null,
    enabledProviders: enabledGateways(source).map((entry) => entry.provider),
    esewaId: source.esewaId ?? null,
    extraAccounts: (source.extraAccounts ?? []).map((account) => ({
      accountName: account.accountName ?? null,
      bankName: account.bankName ?? null,
      kind: account.kind,
      number: account.number,
    })),
    khaltiId: source.khaltiId ?? null,
    lastStatementUploadAt: source.lastStatementUploadAt
      ? new Date(source.lastStatementUploadAt).toISOString()
      : null,
    // Names are excluded on purpose. The hostel's own name is always available
    // to match on, so a name-based test would report "verifiable" for every
    // hostel on the platform and nag nobody. An account identifier is the part
    // an unconfigured hostel is actually missing.
    payeeVerifiable: hostelPayeeIdentity(source).accountIds.length > 0,
    paymentInstructions: source.paymentInstructions ?? null,
    qrPayeeName: source.qrPayeeName ?? null,
    qrPayeeNumber: source.qrPayeeNumber ?? null,
    qrPayeeSource: source.qrPayeeSource ?? null,
    staticQrAssetId: source.staticQrAssetId
      ? source.staticQrAssetId.toString()
      : null,
    statementCadenceDays: source.statementCadenceDays ?? 7,
    tier: resolvePaymentTier(source),
    usable: isPaymentProfileUsable(source),
  };
}

export async function getPaymentProfile(
  hostelId: Types.ObjectId | string,
): Promise<PaymentProfileView> {
  await connectToDatabase();

  return toView(
    await HostelPaymentProfileModel.findOne({ hostelId }).lean<ProfileDocument | null>(),
  );
}

/**
 * The QR is a *financial* asset (item 0.1), so it carries a `hostelId` and this
 * hostel's must match. Without the check an owner could paste any asset id and
 * publish another hostel's QR on their own pay screen — which is not a leak of
 * data so much as a redirection of money.
 */
async function assertQrAssetUsable(
  assetId: string,
  hostelId: Types.ObjectId | string,
) {
  const asset = Types.ObjectId.isValid(assetId)
    ? await FileAssetModel.findOne({
        _id: assetId,
        isDeleted: false,
        status: "ACTIVE",
      }).lean<{
        _id: Types.ObjectId;
        bucket?: string;
        hostelId?: Types.ObjectId;
        key?: string;
        mimeType?: string;
        uploadCompletedAt?: Date;
      } | null>()
    : null;

  if (!asset || asset.hostelId?.toString() !== hostelId.toString()) {
    throw new FinanceServiceError(
      "That image does not belong to this hostel. Upload the QR again.",
      "ASSET_NOT_OWNED",
    );
  }

  if (!asset.uploadCompletedAt) {
    throw new FinanceServiceError(
      "That image did not finish uploading. Please upload the QR again.",
      "ASSET_UPLOAD_INCOMPLETE",
    );
  }

  return asset;
}

/**
 * Read the poster's payee identity, and decide what it may overwrite.
 *
 * Ordered by who saw more. An admin who typed the name and number was looking at
 * the physical QR; a recogniser was looking at a JPEG of it. So `MANUAL` values
 * survive a re-read, and only a *new* upload — where the previous read describes
 * an image that is no longer the profile's QR — clears them.
 *
 * Every failure here is silent by design. The QR still saves, the resident pay
 * screen still renders it, and the admin screen asks for the two fields in a
 * box. A hostel must never be unable to publish its QR because a WASM binary did
 * not load.
 */
async function readQrPayeeFields(
  asset: { bucket?: string; key?: string; mimeType?: string },
  before: ProfileDocument | null,
  isNewQr: boolean,
): Promise<Record<string, unknown>> {
  if (!isNewQr && before?.qrPayeeSource === "MANUAL") {
    return {};
  }

  try {
    if (!asset.bucket || !asset.key) return {};

    const bytes = await readStoredObject({ bucket: asset.bucket, key: asset.key });

    if (!bytes) return {};

    const read = await readQrPayeeFromImage(bytes, asset.mimeType, readEvidenceText);

    if (!hasQrPayee(read)) {
      // A new poster we could not read must not keep the old one's identity —
      // that would match receipts against an account this hostel may no longer
      // collect in, which is the one outcome worse than `UNKNOWN`.
      return isNewQr
        ? { qrPayeeName: null, qrPayeeNumber: null, qrPayeeSource: null }
        : {};
    }

    return {
      qrPayeeName: read.name,
      qrPayeeNumber: read.accountNumber,
      qrPayeeSource: "OCR",
    };
  } catch {
    return {};
  }
}

/** Field names the form may write, so an unexpected key cannot reach the update. */
const TEXT_FIELDS = [
  "bankAccountName",
  "bankAccountNumber",
  "bankName",
  "displayName",
  "esewaId",
  "khaltiId",
  "paymentInstructions",
] as const;

export async function updatePaymentProfile(
  hostelId: Types.ObjectId | string,
  input: PaymentProfileUpdateInput,
  principal: ApiPrincipal,
): Promise<PaymentProfileView> {
  await connectToDatabase();

  const before = await HostelPaymentProfileModel.findOne({
    hostelId,
  }).lean<ProfileDocument | null>();

  const update: Record<string, unknown> = { updatedBy: principal.userId };

  for (const field of TEXT_FIELDS) {
    if (input[field] !== undefined) update[field] = input[field];
  }

  if (input.cashApprovalThreshold !== undefined) {
    update.cashApprovalThreshold = input.cashApprovalThreshold;
  }

  if (input.statementCadenceDays !== undefined) {
    update.statementCadenceDays = input.statementCadenceDays;
  }

  if (input.extraAccounts !== undefined) {
    update.extraAccounts = input.extraAccounts.map((account) => ({
      accountName: account.accountName || undefined,
      bankName: account.kind === "BANK" ? account.bankName || undefined : undefined,
      kind: account.kind,
      number: account.number,
    }));
  }

  // Typed by an admin who was looking at the poster, so it outranks any read of
  // it — recorded as `MANUAL` precisely so a later re-read cannot undo it.
  if (input.qrPayeeName !== undefined || input.qrPayeeNumber !== undefined) {
    if (input.qrPayeeName !== undefined) update.qrPayeeName = input.qrPayeeName;
    if (input.qrPayeeNumber !== undefined) update.qrPayeeNumber = input.qrPayeeNumber;
    update.qrPayeeSource = "MANUAL";
  }

  if (input.staticQrAssetId !== undefined) {
    if (input.staticQrAssetId) {
      const asset = await assertQrAssetUsable(input.staticQrAssetId, hostelId);

      update.staticQrAssetId = asset._id;

      const isNewQr = before?.staticQrAssetId?.toString() !== asset._id.toString();

      // Only when the admin is not typing the fields in the same request: their
      // value is the one that was just chosen deliberately.
      if (update.qrPayeeSource !== "MANUAL") {
        Object.assign(update, await readQrPayeeFields(asset, before, isNewQr));
      }
    } else {
      // The QR is gone, so an identity read off it is no longer this hostel's
      // registered account and must not go on matching receipts.
      update.staticQrAssetId = null;

      if (before?.qrPayeeSource === "OCR") {
        update.qrPayeeName = null;
        update.qrPayeeNumber = null;
        update.qrPayeeSource = null;
      }
    }
  }

  const saved = await HostelPaymentProfileModel.findOneAndUpdate(
    { hostelId },
    { $set: update, $setOnInsert: { createdBy: principal.userId, hostelId } },
    { new: true, upsert: true },
  ).lean<ProfileDocument | null>();

  // The threshold is the one *amount* on this form, and changing it changes who
  // may release money without a second person — so it is the before/after the
  // audit envelope (§5.3) requires. Everything else on the profile is text.
  await auditFinanceAction(principal, {
    action: "PAYMENT_PROFILE_UPDATED",
    amountAfter: saved?.cashApprovalThreshold ?? 20000,
    amountBefore: before?.cashApprovalThreshold ?? 20000,
    entityId: new Types.ObjectId(String(hostelId)),
    entityType: "HostelPaymentProfile",
    hostelId,
    source: "PAYMENT_PROFILE_EDITOR",
  });

  return toView(saved);
}
