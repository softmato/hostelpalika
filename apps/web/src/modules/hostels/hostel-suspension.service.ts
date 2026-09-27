import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { UserModel } from "@hostel/db/models/User";
import {
  graceDeadline,
  issueSubscriptionInvoice,
  outstandingFor,
} from "@/modules/billing/subscription.service";
import { onPlanSuspensionStarted } from "@/modules/hostels/hostel-registration.events";
import {
  liftHostelSuspension,
  serializeSuspension,
  SUSPENSION_GRACE_DAYS,
  type SuspensionReason,
  type SuspensionRecord,
} from "@/modules/hostels/hostel-suspension";

/**
 * Starting and lifting a hostel's plan suspension — the platform's side.
 *
 * The read side, and why the stage is a clock rather than a job, is in
 * `hostel-suspension.ts`.
 */

export class HostelSuspensionError extends Error {
  constructor(
    message: string,
    public errorCode: string,
    public status = 409,
  ) {
    super(message);
  }
}

/**
 * An invoice raised this recently is the one `issueSubscriptionInvoice` just
 * created, and its own email has already carried the document.
 */
const JUST_RAISED_MS = 60_000;

function hostelObjectId(hostelId: string) {
  if (!Types.ObjectId.isValid(hostelId)) {
    throw new HostelSuspensionError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  return new Types.ObjectId(hostelId);
}

/**
 * Starts pre-suspension for an unpaid plan.
 *
 * 1. **The invoice.** The one already outstanding is chased — the same unpaid
 *    invoice goes out again — and the next one is raised only when nothing is
 *    open (`issueSubscriptionInvoice` returns an open invoice rather than
 *    duplicating it).
 * 2. **The clock.** `graceEndsAt` is the end of the Nepal day three days out,
 *    the same shape as every other due here.
 * 3. **The owner is told**: the amount, the invoice, and the date the portal
 *    stops.
 *
 * Refused when there is nothing to collect — no plan chosen, or a plan paid for
 * the period it is in. Suspending a hostel that owes nothing would lock its
 * residents out over a debt that does not exist.
 */
export async function startHostelSuspension(
  hostelId: string,
  input: { reason: SuspensionReason },
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const objectId = hostelObjectId(hostelId);
  const hostel = await HostelModel.findOne({ _id: objectId, isDeleted: { $ne: true } })
    .select("contact name ownerId parentHostelId slug suspension")
    .lean<{
      contact?: { email?: string };
      name?: string;
      ownerId?: Types.ObjectId;
      parentHostelId?: Types.ObjectId | null;
      slug?: string;
      suspension?: SuspensionRecord | null;
    } | null>();

  if (!hostel) {
    throw new HostelSuspensionError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  if (hostel.parentHostelId) {
    throw new HostelSuspensionError(
      "This is a branch, billed with its main hostel. Suspend the main hostel — its branches follow it.",
      "BRANCH_FOLLOWS_MAIN",
    );
  }

  const running = serializeSuspension(hostel.suspension);

  if (running) {
    throw new HostelSuspensionError(
      running.stage === "SUSPENDED"
        ? "This hostel is already suspended."
        : "This hostel is already in pre-suspension.",
      "ALREADY_SUSPENDED",
    );
  }

  const now = new Date();
  const subscription = await HostelSubscriptionModel.findOne({ hostelId: objectId })
    .select("currentPeriodEnd planId status")
    .lean<{ currentPeriodEnd?: Date | null; planId?: string | null; status?: string } | null>();

  if (!subscription?.planId) {
    throw new HostelSuspensionError(
      "This hostel has not chosen a plan, so there is no plan price to collect.",
      "NO_PLAN_SELECTED",
    );
  }

  if (
    subscription.status === "ACTIVE" &&
    subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd.getTime() > now.getTime()
  ) {
    throw new HostelSuspensionError(
      "This hostel's plan is paid for the period it is in. There is nothing to collect.",
      "PLAN_PAID",
    );
  }

  const invoice = await issueSubscriptionInvoice(hostelId, principal.userId, {
    requireVerified: false,
  });
  const { outstanding } = await outstandingFor(invoice);

  if (outstanding <= 0) {
    throw new HostelSuspensionError("Nothing is owed on this hostel's plan.", "NOTHING_OWED");
  }

  const graceEndsAt = graceDeadline(now, SUSPENSION_GRACE_DAYS);

  // Conditional, so a double-clicked Suspend starts one clock and sends one email.
  const started = await HostelModel.findOneAndUpdate(
    { _id: objectId, "suspension.startedAt": null },
    {
      $set: {
        suspension: {
          graceEndsAt,
          reason: input.reason,
          startedAt: now,
          startedBy: new Types.ObjectId(principal.userId),
        },
      },
    },
    { new: true },
  )
    .select("suspension")
    .lean<{ suspension?: SuspensionRecord | null } | null>();

  if (!started) {
    throw new HostelSuspensionError(
      "This hostel is already in pre-suspension.",
      "ALREADY_SUSPENDED",
    );
  }

  // Its branches are on the same plan, so the same clock runs on them. Every
  // guard reads `Hostel.suspension`, so copying it is all a branch needs.
  await HostelModel.updateMany(
    { isDeleted: { $ne: true }, parentHostelId: objectId },
    { $set: { suspension: started.suspension } },
  );

  const owner = hostel.ownerId
    ? await UserModel.findOne({ _id: hostel.ownerId, isDeleted: { $ne: true } })
        .select("email name")
        .lean<{ email?: string; name?: string } | null>()
    : null;

  const justRaised = Boolean(
    invoice.issuedAt &&
      Math.abs(now.getTime() - new Date(invoice.issuedAt).getTime()) < JUST_RAISED_MS,
  );

  const notification = await onPlanSuspensionStarted({
    amount: outstanding,
    attachInvoice: !justRaised,
    graceEndsAt,
    hostelName: hostel.name ?? "your hostel",
    hostelSlug: hostel.slug ?? null,
    invoiceNumber: invoice.invoiceNumber,
    ownerEmail: owner?.email ?? hostel.contact?.email ?? "",
    ownerName: owner?.name,
    planName: invoice.planName ?? "",
  });

  await AuditLogModel.create({
    action: "HOSTEL_SUSPENSION_STARTED",
    actorId: principal.userId,
    entityId: objectId.toString(),
    entityType: "Hostel",
    hostelId: objectId,
    metadata: {
      emailed: notification.sent,
      graceEndsAt,
      invoiceNumber: invoice.invoiceNumber,
      outstanding,
      reason: input.reason,
    },
  });

  return { notification, suspension: serializeSuspension(started.suspension) };
}

/** Lifts a suspension by hand. Paying in full lifts it without anyone doing this. */
export async function liftPlatformHostelSuspension(hostelId: string, principal: ApiPrincipal) {
  const lifted = await liftHostelSuspension(hostelObjectId(hostelId), {
    actorId: principal.userId,
    cause: "LIFTED",
  });

  if (!lifted) {
    throw new HostelSuspensionError("This hostel is not suspended.", "NOT_SUSPENDED");
  }

  return { lifted };
}
