import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { getCreditAmount } from "@/modules/finance/credit-balance.service";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { bedTypeLabel, isBedType, type BedType } from "@hostel/shared/types/bed-type";
import { findCurrentResident } from "@/modules/residents/resident-access";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { hasProvider } from "@/modules/finance/gateway/registry";
import { isGatewayPayable } from "@/modules/finance/gateway/secret-store";
import {
  type ExtraPaymentAccount,
  findGateway,
  FONEPAY_PERSONAL_DAILY_LIMIT,
  type GatewayConfig,
  type GatewayProviderName,
  HostelPaymentProfileModel,
  isPaymentProfileUsable,
  resolvePaymentTier,
  type PaymentTier,
} from "@hostel/db/models/HostelPaymentProfile";

/**
 * How to pay *this* invoice (target §11.1, plan item 3.3).
 *
 * Tier-aware by construction: the shape is the same at Tier 0 and Tier 1, and
 * `tier` says which of them the screen should lead with. Block 6 adds the intent
 * fields; nothing here changes when it does, which is the point of computing the
 * tier rather than storing it.
 *
 * **The reference code is the load-bearing field.** Everything downstream —
 * statement matching (Block 4), auto-settlement, the owner's review queue not
 * filling up with unidentifiable transfers — depends on the resident actually
 * typing it into their bank's remark box. It is returned first and the screen
 * gives it the strongest visual treatment on the page.
 */

export type PayMethod =
  /** A live checkout. Tapping it creates an intent and hands off to the provider. */
  | { kind: "GATEWAY"; provider: GatewayProviderName; sandbox: boolean }
  | {
      kind: "BANK";
      accountName: string | null;
      accountNumber: string;
      bankName: string | null;
    }
  | { kind: "ESEWA"; id: string }
  | { kind: "KHALTI"; id: string }
  | { kind: "QR"; assetId: string; notice: string | null };

export type PayInstructions = {
  /** What is still owed. Never the invoice total once part of it is settled. */
  amountDue: number;
  /**
   * What they are renting, spelled out — "Triple sharing" (target §11.1).
   *
   * On the screen next to the amount so the resident can sanity-check their own
   * bill before paying it. A resident who moved from a four-sharing to a double
   * has no other way to tell whether the number in front of them is the new rent
   * or the old one, and "is this amount right" is the question that stops a
   * payment.
   */
  bedLabel: string | null;
  /**
   * Credit carried from an earlier overpayment (target §9.4), shown above the
   * amount. Zero for almost everyone; when it is not, saying nothing means the
   * resident pays the full amount and overpays again.
   */
  credit: number;
  displayName: string | null;
  dueDate: string | null;
  instructions: string | null;
  invoiceId: string;
  /** Empty when the hostel has not set up a single way to be paid. */
  methods: PayMethod[];
  period: string | null;
  /** Null only for invoices migrated in 2.4, which were never on any transfer. */
  referenceCode: string | null;
  status: string;
  tier: PaymentTier;
  /** False means: tell the resident their hostel has not set this up. */
  usable: boolean;
};

type InvoiceRecord = {
  _id: Types.ObjectId;
  bedType?: BedType | null;
  dueDate?: Date;
  hostelId: Types.ObjectId;
  period?: string;
  referenceCode?: string;
  status: string;
  totalAmount: number;
};

/** The order gateways are offered in. eSewa first: it is the widest-held wallet. */
const GATEWAY_ORDER: GatewayProviderName[] = ["ESEWA", "KHALTI", "FONEPAY"];

/**
 * The methods, in the order a resident should see them.
 *
 * **Live checkouts first, manual below.** A gateway settles itself and needs no
 * screenshot, no review queue entry and no statement match, so it is the path
 * worth leading with. The manual methods stay on the screen underneath rather
 * than being replaced by it — a provider outage otherwise means nobody can pay
 * that month, and a resident without the wallet app never could.
 *
 * Within the manual block: QR first, because scanning is the shortest path and
 * the one least likely to be mistyped; bank last, because it is the slowest and
 * the one where the reference code matters most. A method with no value is not
 * rendered as an empty row — it is simply not a way this hostel can be paid.
 */
function methodsFrom(
  profile: {
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
    bankName?: string | null;
    esewaId?: string | null;
    extraAccounts?: ExtraPaymentAccount[] | null;
    gateways?: GatewayConfig[] | null;
    khaltiId?: string | null;
    staticQrAssetId?: Types.ObjectId | null;
  },
  amountDue: number,
): PayMethod[] {
  const methods: PayMethod[] = [];
  const live = new Set<GatewayProviderName>();

  for (const provider of GATEWAY_ORDER) {
    const entry = findGateway(profile, provider);

    // `hasProvider` as well as `isGatewayPayable`: a hostel can configure a
    // provider whose adapter has not shipped, and offering that button gives the
    // resident a checkout that fails after they have committed to paying.
    if (!isGatewayPayable(entry) || !hasProvider(provider)) {
      continue;
    }

    live.add(provider);
    methods.push({
      kind: "GATEWAY",
      provider,
      sandbox: entry?.mode !== "LIVE",
    });
  }

  if (profile.staticQrAssetId) {
    methods.push({
      kind: "QR",
      assetId: profile.staticQrAssetId.toString(),
      notice: qrNotice(profile, amountDue),
    });
  }

  // A wallet id is suppressed once that wallet's checkout is live: offering
  // "pay with eSewa" and "transfer to this eSewa id yourself" side by side asks
  // the resident to choose between two things they cannot tell apart, and the
  // manual one costs somebody a screenshot review.
  if (profile.esewaId && !live.has("ESEWA")) {
    methods.push({ kind: "ESEWA", id: profile.esewaId });
  }

  if (profile.khaltiId && !live.has("KHALTI")) {
    methods.push({ kind: "KHALTI", id: profile.khaltiId });
  }

  const extra = profile.extraAccounts ?? [];

  for (const account of extra) {
    if (account.kind === "ESEWA" && !live.has("ESEWA")) methods.push({ kind: "ESEWA", id: account.number });
    if (account.kind === "KHALTI" && !live.has("KHALTI")) methods.push({ kind: "KHALTI", id: account.number });
  }

  if (profile.bankAccountNumber) {
    methods.push({
      kind: "BANK",
      accountName: profile.bankAccountName ?? null,
      accountNumber: profile.bankAccountNumber,
      bankName: profile.bankName ?? null,
    });
  }

  for (const account of extra) {
    if (account.kind === "BANK") {
      methods.push({
        kind: "BANK",
        accountName: account.accountName ?? null,
        accountNumber: account.number,
        bankName: account.bankName ?? null,
      });
    }
  }

  return methods;
}

/**
 * The warning on a static QR that cannot accept this month's rent.
 *
 * A personal Fonepay wallet caps at NPR 5,000 credited per day, so a resident
 * scanning one for a 12,000 invoice has their payment rejected by the network
 * with no explanation we control. Saying so on our screen is the difference
 * between a resident splitting the payment and a resident assuming the hostel's
 * QR is broken.
 */
function qrNotice(
  profile: { gateways?: GatewayConfig[] | null },
  amountDue: number,
): string | null {
  const fonepay = findGateway(profile, "FONEPAY");

  if (fonepay?.accountKind !== "PERSONAL" || amountDue <= FONEPAY_PERSONAL_DAILY_LIMIT) {
    return null;
  }

  return (
    `This QR is a personal Fonepay account, which can receive at most ` +
    `NPR ${FONEPAY_PERSONAL_DAILY_LIMIT.toLocaleString("en-IN")} per day. ` +
    `Pay in parts across days, or use the bank transfer below.`
  );
}

/**
 * How this hostel can be paid, without an invoice to hang it on.
 *
 * The resident's own screen ({@link getPayInstructions}) answers for one
 * invoice, from that resident's session. The intake desk needs the same answer
 * a moment earlier and from the other side of the counter: the warden has just
 * registered somebody, the invoices carry reference codes, and the resident is
 * standing there asking where to send the money. Reading the resident's
 * endpoint is not open to them — it resolves `findCurrentResident` off the
 * caller's own principal — and re-listing the methods on the intake screen
 * would be a second answer to "how do I pay you" that drifts from the first.
 *
 * So the method list is `methodsFrom`, unchanged and in the same order, and
 * everything invoice-shaped is left to the caller.
 *
 * `amountDue` only decides the Fonepay personal-wallet notice; pass the total
 * being collected so a joining payment over the daily cap says so at the desk
 * rather than after a rejected transfer.
 */
export type HostelPayMethods = {
  displayName: string | null;
  instructions: string | null;
  methods: PayMethod[];
  tier: PaymentTier;
  /** False means: this hostel has not set up a single way to be paid. */
  usable: boolean;
};

export async function getHostelPayMethods(
  hostelId: Types.ObjectId | string,
  amountDue: number,
): Promise<HostelPayMethods> {
  await connectToDatabase();

  const profile = await HostelPaymentProfileModel.findOne({ hostelId }).lean<{
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
    bankName?: string | null;
    displayName?: string | null;
    esewaId?: string | null;
    extraAccounts?: ExtraPaymentAccount[] | null;
    gateways?: GatewayConfig[] | null;
    khaltiId?: string | null;
    paymentInstructions?: string | null;
    staticQrAssetId?: Types.ObjectId | null;
  } | null>();

  return {
    displayName: profile?.displayName ?? null,
    instructions: profile?.paymentInstructions ?? null,
    methods: profile ? methodsFrom(profile, amountDue) : [],
    tier: resolvePaymentTier(profile),
    usable: isPaymentProfileUsable(profile),
  };
}

export async function getPayInstructions(
  invoiceId: string,
  principal: ApiPrincipal,
): Promise<PayInstructions> {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  const invoice = await InvoiceModel.findOne({
    _id: Types.ObjectId.isValid(invoiceId) ? invoiceId : new Types.ObjectId(),
    hostelId: resident.hostelId,
    residentId: resident._id,
  }).lean<InvoiceRecord | null>();

  // Out of scope and non-existent answer identically — an invoice id must not
  // become an existence oracle for anyone probing them (RULES.md §3).
  if (!invoice || invoice.status === "VOID") {
    throw new FinanceServiceError("Invoice was not found.", "INVOICE_NOT_FOUND");
  }

  const [balance, profile, credit] = await Promise.all([
    InvoiceBalanceModel.findOne({ invoiceId: invoice._id }).lean<{
      settledAmount?: number;
    } | null>(),
    HostelPaymentProfileModel.findOne({ hostelId: resident.hostelId }).lean<{
      bankAccountName?: string | null;
      bankAccountNumber?: string | null;
      bankName?: string | null;
      displayName?: string | null;
      esewaId?: string | null;
      extraAccounts?: ExtraPaymentAccount[] | null;
      gateways?: GatewayConfig[] | null;
      khaltiId?: string | null;
      paymentInstructions?: string | null;
      staticQrAssetId?: Types.ObjectId | null;
    } | null>(),
    getCreditAmount(resident.hostelId, resident._id),
  ]);

  // Outstanding, not the invoice total: a resident paying the second half of a
  // part-paid month must be shown the half, or they pay the whole thing twice.
  const amountDue = Math.max(0, invoice.totalAmount - (balance?.settledAmount ?? 0));

  return {
    amountDue,
    // Read off the invoice, not the resident: the invoice records what they were
    // billed for, and a resident who has since moved rooms must still see the
    // bed type this particular month was priced at.
    bedLabel: isBedType(invoice.bedType) ? bedTypeLabel(invoice.bedType) : null,
    credit,
    displayName: profile?.displayName ?? null,
    dueDate: invoice.dueDate ? new Date(invoice.dueDate).toISOString() : null,
    instructions: profile?.paymentInstructions ?? null,
    invoiceId: invoice._id.toString(),
    methods: profile ? methodsFrom(profile, amountDue) : [],
    period: invoice.period ?? null,
    referenceCode: invoice.referenceCode ?? null,
    status: invoice.status,
    tier: resolvePaymentTier(profile),
    usable: isPaymentProfileUsable(profile),
  };
}
