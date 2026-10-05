import { jwtVerify, SignJWT } from "jose";
import { Types } from "mongoose";
import { z } from "zod";

import { jwtSecret } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { hostelCode, normalizeHostelCode } from "@/lib/hostel-code";
import { isValidDocumentClaimToken } from "@/lib/registration-documents";
import {
  AuthServiceError,
  otpResendCooldownMs,
  requestOtpChallenge,
  verifyOtpChallenge,
} from "@/modules/auth/auth.service";
import { countBranches } from "@/modules/billing/billing-hostel";
import { daysLeftThrough, getBillingHistory } from "@/modules/billing/billing-history.service";
import { planAfterPayment } from "@/modules/billing/subscription.service";
import {
  getPlanPaymentInstructions,
  submitPlanPaymentClaim,
} from "@/modules/billing/subscription-claim.service";
import { openSubscriptionCheckout } from "@/modules/billing/subscription-payment.service";
import {
  getSubscriptionState,
  invoiceIdFor,
  changeOpenInvoiceMonths,
  invoiceMonthsLocked,
  raiseRenewalInvoice,
  SubscriptionError,
} from "@/modules/billing/subscription.service";
import { isSoftmatoConfigured } from "@/modules/billing/softmato/config";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { OtpChallengeModel } from "@hostel/db/models/OtpChallenge";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { UserModel } from "@hostel/db/models/User";

/**
 * "Get plan" for a hostel that is already on the platform, without signing in.
 *
 * The owner proves the hostel is theirs the way a password reset does: they
 * name it (its email and Hostel ID), and we send a code to that email. The
 * code buys a short-lived checkout token scoped to that one hostel, and the
 * token is all the payment steps accept. Everything past that point is the
 * existing plan machinery — `raiseRenewalInvoice` for the invoice, the
 * Softmato checkout or the manual QR claim for the money, and `settlePayment`
 * extending the running plan when it clears.
 */

const TOKEN_TTL = "1h";
const TOKEN_TYPE = "plan-checkout";

function fail(message: string, errorCode: string, status: number): never {
  throw new SubscriptionError(message, errorCode, status);
}

export const planCheckoutSchema = z.discriminatedUnion("step", [
  z.object({
    email: z.string().trim().toLowerCase().email("Enter the hostel's email address."),
    hostelCode: z.string().trim().min(1, "Enter your Hostel ID."),
    step: z.literal("start"),
  }),
  z.object({
    challengeId: z.string().trim().min(1),
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code."),
    hostelCode: z.string().trim().min(1),
    step: z.literal("verify"),
  }),
  z.object({
    cycle: z.enum(["monthly", "halfYearly", "annual"]),
    /** Absent from the footer's "Pay for your hostel": the hostel's own plan is renewed. */
    planId: z.string().trim().min(1).optional(),
    step: z.literal("invoice"),
    token: z.string().min(1),
  }),
  z.object({ step: z.literal("pay"), token: z.string().min(1) }),
  /** The pay step's plan and month pickers, on an invoice nothing has touched yet. */
  z.object({
    months: z.coerce.number().int().min(1).max(12),
    planId: z.string().trim().min(1).optional(),
    step: z.literal("months"),
    token: z.string().min(1),
  }),
  /** A reload of the pay step: reads, never raises an invoice. */
  z.object({ step: z.literal("resume"), token: z.string().min(1) }),
  z.object({
    claimToken: z.string().min(1),
    fileAssetId: z.string().min(1),
    reference: z.string().trim().max(120).optional(),
    step: z.literal("claim"),
    token: z.string().min(1),
  }),
]);

export type PlanCheckoutInput = z.infer<typeof planCheckoutSchema>;

/**
 * Every refusal before a code is sent says exactly this. Which check failed is
 * never told: "no such email" vs "not a hostel's email" vs "wrong ID" would let
 * anyone probe which addresses own hostels on the platform.
 */
const NOT_MATCHED = "This email and Hostel ID don't match. Please check both.";

type HostelMatch = {
  _id: Types.ObjectId;
  name?: string;
  ownerId: Types.ObjectId;
  parentHostelId?: Types.ObjectId | null;
};

/**
 * A branch has no plan of its own — it rides its main hostel's — so a branch's
 * Hostel ID opens the main hostel's checkout. Resolved here, before the token
 * is signed, so every later step (invoice, months, resume, pay, claim) is
 * already about the account that is actually billed.
 */
async function billedHostel(match: HostelMatch): Promise<HostelMatch | null> {
  if (!match.parentHostelId) return match;

  return HostelModel.findOne({ _id: match.parentHostelId, isDeleted: { $ne: true } })
    .select("_id name ownerId")
    .lean<HostelMatch | null>();
}

/** What the Pay page names: the billed hostel, and how many branches its plan covers. */
async function checkoutHostel(hostelId: string, name: string | undefined) {
  return {
    branches: await countBranches(new Types.ObjectId(hostelId)),
    code: hostelCode(hostelId),
    name: name ?? "",
  };
}

/**
 * The hostel both details point at, or `null`. Three gates, in order, and a
 * code is only ever sent past all of them:
 *
 * 1. the email exists here — an account, or a hostel's contact address;
 * 2. it is bound to a hostel — that account owns one, or it is one's contact;
 * 3. the Hostel ID is one of *those* hostels, not merely a real ID.
 */
export async function findHostelForCheckout(email: string, code: string): Promise<HostelMatch | null> {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [accounts, contactHostels] = await Promise.all([
    UserModel.find({ email, isDeleted: { $ne: true } })
      .select("_id")
      .lean<{ _id: Types.ObjectId }[]>(),
    HostelModel.find({
      "contact.email": { $options: "i", $regex: `^${escaped}$` },
      isDeleted: { $ne: true },
    })
      .select("_id name ownerId parentHostelId")
      .lean<HostelMatch[]>(),
  ]);

  // 1. Unknown email.
  if (accounts.length === 0 && contactHostels.length === 0) {
    return null;
  }

  const ownedHostels = accounts.length
    ? await HostelModel.find({
        isDeleted: { $ne: true },
        ownerId: { $in: accounts.map((account) => account._id) },
      })
        .select("_id name ownerId parentHostelId")
        .lean<HostelMatch[]>()
    : [];
  const bound = [...ownedHostels, ...contactHostels];

  // 2. A real email that no hostel is bound to.
  if (bound.length === 0) {
    return null;
  }

  // 3. The ID must name one of this email's hostels.
  const wanted = normalizeHostelCode(code);

  const match = wanted && bound.find((hostel) => hostelCode(String(hostel._id)) === wanted);

  return match ? billedHostel(match) : null;
}

async function signCheckoutToken(hostelId: string, ownerId: string) {
  return new SignJWT({ ownerId, tokenType: TOKEN_TYPE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(hostelId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(jwtSecret("JWT_ACCESS_SECRET"));
}

export async function readCheckoutToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, jwtSecret("JWT_ACCESS_SECRET"));

    if (payload.tokenType !== TOKEN_TYPE || !payload.sub || typeof payload.ownerId !== "string") {
      throw new Error("wrong token");
    }

    return { hostelId: payload.sub, ownerId: payload.ownerId };
  } catch {
    return fail(
      "This checkout has expired. Start again with your hostel's email and ID.",
      "CHECKOUT_EXPIRED",
      401,
    );
  }
}

/** What the payment step needs: the invoice, the QR, and whether online pay is live. */
async function paymentState(hostelId: string) {
  const [state, instructions] = await Promise.all([
    getSubscriptionState(hostelId),
    getPlanPaymentInstructions(hostelId),
  ]);

  return {
    instructions,
    online: isSoftmatoConfigured(),
    plan: state
      ? {
          currentPeriodEnd: state.subscription.currentPeriodEnd,
          name: state.subscription.planName,
          status: state.subscription.status,
        }
      : null,
  };
}

type CheckoutInvoice = {
  _id: Types.ObjectId;
  amount: number;
  cycle: string;
  cycleMonths?: number;
  invoiceNumber: string;
  periodEnd?: Date | null;
  planId: string;
  planName: string;
  softmatoInvoiceId?: string | null;
  source?: string;
  status: string;
};

/** The pay step: the invoice, the hostel's billing trace, and where the plan lands once paid. */
async function checkoutView(hostelId: string, invoice: CheckoutInvoice | null) {
  const history = await getBillingHistory(hostelId);
  /*
   * Where the plan stands once this invoice is settled in full — the same
   * rule `startPlanPeriod` applies: a running period that already reaches
   * the invoice's end is kept, otherwise the plan runs to the invoice's.
   */
  const runningEnd = history.plan?.currentPeriodEnd ? new Date(history.plan.currentPeriodEnd) : null;
  const invoiceEnd = invoice?.periodEnd ?? null;
  const runsUntil =
    runningEnd && (!invoiceEnd || runningEnd.getTime() >= invoiceEnd.getTime()) ? runningEnd : invoiceEnd;
  // Settlement keeps the higher plan (`planAfterPayment`); the months bought are added to it.
  const held = history.plan;
  const keeps = Boolean(
    invoice &&
      held?.planId &&
      (await planAfterPayment({ cycleMonths: held.cycleMonths ?? null, planId: held.planId }, invoice)) ===
        "current",
  );
  const bought = invoice?.cycleMonths ?? 0;

  return {
    afterPayment: invoice
      ? {
          cycleLabel: keeps
            ? (held?.cycleLabel ?? "")
            : (history.invoices.find((row) => row.invoiceNumber === invoice.invoiceNumber)?.cycleLabel ??
              invoice.cycle),
          daysRemaining: daysLeftThrough(runsUntil),
          note: keeps
            ? `${bought} ${bought === 1 ? "month" : "months"} of ${invoice.planName} added to your ${held?.planName} · ${held?.cycleLabel} plan.`
            : null,
          planName: keeps ? (held?.planName ?? invoice.planName) : invoice.planName,
          runsUntil: runsUntil?.toISOString() ?? null,
        }
      : null,
    history: { invoices: history.invoices, payments: history.payments, plan: history.plan },
    invoice: invoice
      ? {
          amount: invoice.amount,
          cycle: invoice.cycle,
          invoiceNumber: invoice.invoiceNumber,
          // Whether the page may still offer the month picker (see `invoiceMonthsLocked`).
          monthsLocked: await invoiceMonthsLocked(invoice),
          months: invoice.cycleMonths ?? null,
          periodEnd: invoice.periodEnd?.toISOString() ?? null,
          planId: invoice.planId,
          planName: invoice.planName,
        }
      : null,
    ...(await paymentState(hostelId)),
  };
}

export async function runPlanCheckout(
  input: PlanCheckoutInput,
  context?: { ipAddress?: string; userAgent?: string },
  step?: (name: "invoice" | "session") => void,
) {
  await connectToDatabase();

  switch (input.step) {
    case "start": {
      const hostel = await findHostelForCheckout(input.email, input.hostelCode);

      if (!hostel) {
        fail(NOT_MATCHED, "HOSTEL_NOT_MATCHED", 404);
      }

      try {
        const challenge = await requestOtpChallenge(
          { channel: "email", identifier: input.email, purpose: "plan-checkout" },
          context,
        );

        // The code goes to the inbox only — never back in this response, not
        // even in development, where it is written to the server log instead.
        if ("devCode" in challenge && process.env.NODE_ENV !== "production") {
          console.info(`[plan-checkout] code for ${input.email}: ${challenge.devCode}`);
        }

        return {
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          resendInSeconds: Math.ceil(otpResendCooldownMs() / 1000),
          resumed: false,
        };
      } catch (error) {
        /*
         * A code went to this inbox moments ago — the owner pressed back, or
         * reloaded, and asked again. Refusing locked them out of a code they
         * already hold, so hand back that same challenge instead. Nothing new
         * is sent and the id alone is useless without the code in the email.
         */
        if (!(error instanceof AuthServiceError) || error.errorCode !== "OTP_RESEND_COOLDOWN") {
          throw error;
        }

        const live = await OtpChallengeModel.findOne({
          channel: "email",
          consumedAt: null,
          expiresAt: { $gt: new Date() },
          identifier: input.email,
          purpose: "plan-checkout",
        })
          .sort({ createdAt: -1 })
          .lean<{ _id: Types.ObjectId; codeLastSentAt: Date; expiresAt: Date } | null>();

        if (!live) {
          throw error;
        }

        const waitMs = otpResendCooldownMs() - (Date.now() - live.codeLastSentAt.getTime());

        return {
          challengeId: String(live._id),
          expiresAt: live.expiresAt,
          resendInSeconds: Math.max(0, Math.ceil(waitMs / 1000)),
          resumed: true,
        };
      }
    }

    case "verify": {
      const verified = await verifyOtpChallenge({ challengeId: input.challengeId, code: input.code });
      const challenge = await OtpChallengeModel.findById(input.challengeId)
        .select("purpose")
        .lean<{ purpose: string } | null>();

      if (challenge?.purpose !== "plan-checkout") {
        fail("That code is not for a plan checkout.", "OTP_INVALID", 400);
      }

      const hostel = await findHostelForCheckout(verified.identifier, input.hostelCode);

      if (!hostel) {
        fail(NOT_MATCHED, "HOSTEL_NOT_MATCHED", 404);
      }

      // One code, one checkout.
      await OtpChallengeModel.updateOne({ _id: input.challengeId }, { $set: { consumedAt: new Date() } });

      const hostelId = String(hostel._id);

      return {
        hostel: await checkoutHostel(hostelId, hostel.name),
        token: await signCheckoutToken(hostelId, String(hostel.ownerId)),
        ...(await paymentState(hostelId)),
      };
    }

    case "invoice": {
      const { hostelId, ownerId } = await readCheckoutToken(input.token);
      const { invoice, reused } = await raiseRenewalInvoice(
        hostelId,
        { cycle: input.cycle, planId: input.planId ?? (await currentPlanId(hostelId)) },
        ownerId,
        // Raised on Softmato at Pay, so the months can still change here.
        { deferDocument: true },
      );

      return { reused, ...(await checkoutView(hostelId, invoice)) };
    }

    case "months": {
      const { hostelId, ownerId } = await readCheckoutToken(input.token);

      return checkoutView(
        hostelId,
        await changeOpenInvoiceMonths(hostelId, input.months, ownerId, input.planId),
      );
    }

    case "resume": {
      const { hostelId } = await readCheckoutToken(input.token);
      const [hostel, open] = await Promise.all([
        HostelModel.findById(hostelId).select("name").lean<{ name?: string } | null>(),
        SubscriptionInvoiceModel.findOne({
          hostelId,
          kind: { $ne: "SETUP_FEE" },
          status: { $in: ["OPEN", "PARTIAL"] },
        })
          .sort({ createdAt: -1 })
          .lean<CheckoutInvoice | null>(),
      ]);

      return {
        hostel: await checkoutHostel(hostelId, hostel?.name),
        ...(await checkoutView(hostelId, open)),
      };
    }

    case "pay": {
      const { hostelId, ownerId } = await readCheckoutToken(input.token);

      return openSubscriptionCheckout(await invoiceIdFor(hostelId), ownerId, step);
    }

    case "claim": {
      const { hostelId, ownerId } = await readCheckoutToken(input.token);

      if (
        !Types.ObjectId.isValid(input.fileAssetId) ||
        !isValidDocumentClaimToken(input.fileAssetId, input.claimToken)
      ) {
        fail("Attach the payment screenshot again.", "PROOF_NOT_OWNED", 403);
      }

      // The screenshot came through the anonymous upload, so nobody owns it
      // yet; the claim token proves it is this browser's, and it becomes the
      // owner's proof for this hostel.
      await FileAssetModel.updateOne(
        { _id: new Types.ObjectId(input.fileAssetId), ownerId: null },
        {
          $set: {
            hostelId: new Types.ObjectId(hostelId),
            kind: "PAYMENT_PROOF",
            ownerId: new Types.ObjectId(ownerId),
          },
        },
      );

      return submitPlanPaymentClaim(
        hostelId,
        { proofAssetId: input.fileAssetId, reference: input.reference },
        ownerId,
      );
    }
  }
}

/** The plan the hostel is on, or `""` — which `pricePlan` answers with "choose another one". */
async function currentPlanId(hostelId: string) {
  const subscription = await HostelSubscriptionModel.findOne({ hostelId: new Types.ObjectId(hostelId) })
    .select("planId")
    .lean<{ planId?: string | null } | null>();

  return subscription?.planId ?? "";
}
