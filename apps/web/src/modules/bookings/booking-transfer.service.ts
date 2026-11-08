import "server-only";

import { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { BookingModel } from "@hostel/db/models/Booking";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelPayoutAccountModel } from "@hostel/db/models/HostelPayoutAccount";
import { bookingRefundSentEmail } from "@hostel/shared/email/templates/booking/guest";
import { bookingPayoutSentEmail } from "@hostel/shared/email/templates/booking/hostel";
import { rupees } from "@hostel/shared/email/templates/booking/parts";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Role } from "@/lib/roles";
import { allocate } from "@/modules/billing/documents/issue";
import {
  appUrl,
  bookingFacts,
  guestBookingPath,
  hostelBookingsPath,
  notifyGuest,
  notifyHostel,
  when,
} from "@/modules/bookings/booking-notify";
import {
  describeDestination,
  destinationText,
  type BookingRecord,
  type TransferRecord,
} from "@/modules/bookings/booking-views";
import { refundScope } from "@/modules/bookings/booking.service";
import { markTransferSentSchema } from "@/modules/bookings/booking.validation";
import { BookingError } from "@/modules/bookings/booking.errors";
import { revealHostelPayoutAccount } from "@/modules/bookings/payout-account.service";
import type { PayoutMethod } from "@/lib/bookings/payout-account.validation";
import { openValue } from "@/modules/finance/gateway/secret-store";
import type { TransferBlock, TransferView } from "@/lib/bookings/booking.types";
export type { TransferBlock } from "@/lib/bookings/booking.types";
export type { TransferView } from "@/lib/bookings/booking.types";

/**
 * Money leaving HostelPalika: refunds to people, shares to hostels.
 *
 * By hand for now (docs/BOOKINGS.md): a superadmin moves the money in a
 * banking app, then records it here with the transaction id. The record keeps
 * a masked copy of where it went at that moment, gets its refund note or
 * payout advice number, and tells the person or the hostel.
 *
 * **A payout never goes to an account we have not verified.** The queue shows
 * it as blocked and marking it sent is refused, whoever asks.
 */

type Destination = {
  bankName?: string;
  holderName: string;
  method: PayoutMethod;
  numberLast4: string;
};

type PayoutAccountRow = Destination & { hostelId: Types.ObjectId; status: string };

function assertSuperadmin(principal: ApiPrincipal) {
  if (principal.role !== Role.SUPERADMIN) {
    throw new BookingError("Only a superadmin can send booking money.", "FORBIDDEN", 403);
  }
}

function payoutBlock(account: PayoutAccountRow | null): TransferBlock | null {
  if (!account) return "NO_PAYOUT_ACCOUNT";

  return account.status === "VERIFIED" ? null : "PAYOUT_ACCOUNT_NOT_VERIFIED";
}

function toTransferView(
  transfer: TransferRecord,
  booking: BookingRecord,
  payoutAccount: PayoutAccountRow | null,
): TransferView {
  // Sent: where it went. Due: where it would go today.
  const onFile = transfer.kind === "REFUND" ? booking.refundAccount : payoutAccount;
  const destination =
    transfer.status === "SENT" ? (transfer.destination as Partial<Destination> | undefined) : onFile;

  return {
    amount: transfer.amount,
    blocked: transfer.status === "DUE" && transfer.kind === "PAYOUT" ? payoutBlock(payoutAccount) : null,
    bookingCode: booking.code,
    bookingId: String(booking._id),
    destination: describeDestination(destination),
    documentNumber: transfer.documentNumber ?? null,
    dueSince: transfer.createdAt ? new Date(transfer.createdAt).toISOString() : null,
    guestName: booking.guest.name,
    hostelName: booking.hostelSnapshot.name,
    id: String(transfer._id),
    kind: transfer.kind,
    roomType: booking.roomType,
    sentAt: transfer.sentAt ? new Date(transfer.sentAt).toISOString() : null,
    status: transfer.status,
    transactionId: transfer.transactionId ?? null,
  };
}

/** Money owed, oldest first. Payouts to an unverified account are listed, marked blocked. */
export async function listTransfersDue(kind?: "PAYOUT" | "REFUND"): Promise<TransferView[]> {
  await connectToDatabase();

  const transfers = await BookingTransferModel.find({ status: "DUE", ...(kind ? { kind } : {}) })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean<TransferRecord[]>();

  if (transfers.length === 0) {
    return [];
  }

  const bookings = await BookingModel.find({ _id: { $in: transfers.map((transfer) => transfer.bookingId) } })
    .lean<BookingRecord[]>();
  const accounts = await HostelPayoutAccountModel.find({
    hostelId: { $in: bookings.map((booking) => booking.hostelId) },
  }).lean<PayoutAccountRow[]>();
  const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));
  const accountByHostel = new Map(accounts.map((account) => [String(account.hostelId), account]));

  return transfers.flatMap((transfer) => {
    const booking = bookingById.get(String(transfer.bookingId));

    return booking
      ? [toTransferView(transfer, booking, accountByHostel.get(String(booking.hostelId)) ?? null)]
      : [];
  });
}

async function loadTransfer(transferId: string) {
  const transfer = Types.ObjectId.isValid(transferId)
    ? await BookingTransferModel.findById(transferId).lean<TransferRecord | null>()
    : null;

  if (!transfer) {
    throw new BookingError("Transfer not found.", "TRANSFER_NOT_FOUND", 404);
  }

  return transfer;
}

async function loadTransferProof(assetId: string, actorId: string) {
  const asset = await FileAssetModel.findOne({ _id: assetId, isDeleted: { $ne: true } })
    .select("_id hostelId kind ownerId")
    .lean<{ _id: Types.ObjectId; hostelId?: Types.ObjectId | null; kind: string; ownerId?: Types.ObjectId } | null>();

  if (!asset || String(asset.ownerId) !== actorId || asset.kind !== "BOOKING_TRANSFER_PROOF" || asset.hostelId) {
    throw new BookingError("Attach the screenshot of the transfer you sent.", "PROOF_NOT_OWNED", 422);
  }

  return asset._id;
}

export async function markTransferSent(
  transferId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
  now = new Date(),
): Promise<TransferView> {
  assertSuperadmin(principal);

  const input = markTransferSentSchema.parse(rawInput);

  await connectToDatabase();

  const transfer = await loadTransfer(transferId);

  if (transfer.status !== "DUE") {
    throw new BookingError("This has already been marked sent.", "TRANSFER_ALREADY_SENT", 409);
  }

  const booking = await BookingModel.findById(transfer.bookingId).lean<BookingRecord | null>();

  if (!booking) {
    throw new BookingError("The booking behind this transfer is missing.", "BOOKING_NOT_FOUND", 404);
  }

  const payoutAccount =
    transfer.kind === "PAYOUT"
      ? await HostelPayoutAccountModel.findOne({ hostelId: booking.hostelId }).lean<PayoutAccountRow | null>()
      : null;

  if (transfer.kind === "PAYOUT" && payoutBlock(payoutAccount)) {
    throw new BookingError(
      "Verify this hostel's payout account before sending it money.",
      "PAYOUT_ACCOUNT_NOT_VERIFIED",
      409,
    );
  }

  const source: Destination = transfer.kind === "PAYOUT" ? payoutAccount! : booking.refundAccount;
  const destination = {
    bankName: source.bankName ?? "",
    holderName: source.holderName,
    method: source.method,
    numberLast4: source.numberLast4,
  };
  const proofAssetId = input.proofAssetId ? await loadTransferProof(input.proofAssetId, principal.userId) : null;

  const sent = await BookingTransferModel.findOneAndUpdate(
    { _id: transfer._id, status: "DUE" },
    {
      $set: {
        destination,
        note: input.note?.trim() || null,
        proofAssetId,
        sentAt: now,
        sentBy: principal.userId,
        status: "SENT",
        transactionId: input.transactionId,
      },
    },
    { new: true },
  ).lean<TransferRecord | null>();

  if (!sent) {
    throw new BookingError("This has already been marked sent.", "TRANSFER_ALREADY_SENT", 409);
  }

  // Numbered once the money is recorded as gone, so a lost race never burns a number.
  const documentNumber = await allocate(transfer.kind === "REFUND" ? "BOOKING_REFUND" : "BOOKING_PAYOUT", now)
    .then(async (number) => {
      await BookingTransferModel.updateOne({ _id: sent._id }, { $set: { documentNumber: number } });

      return number;
    })
    .catch((error: unknown) => {
      logger.error("Booking transfer was marked sent but could not be numbered.", {
        error: error instanceof Error ? error.message : String(error),
        transferId: String(sent._id),
      });

      return null;
    });

  await AuditLogModel.create({
    action: "BOOKING_TRANSFER_SENT",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(sent._id),
    entityType: "BookingTransfer",
    hostelId: booking.hostelId,
    metadata: {
      amount: sent.amount,
      code: booking.code,
      documentNumber,
      kind: sent.kind,
      transactionId: input.transactionId,
    },
  }).catch(() => undefined);

  const sentTo = destinationText(destination);
  const sentOn = when(now);

  if (sent.kind === "REFUND") {
    await notifyGuest(booking, {
      action: "booking_refund_sent",
      body: `${rupees(sent.amount)} refunded to ${sentTo}. Transaction ${input.transactionId}.`,
      email: bookingRefundSentEmail({
        amount: sent.amount,
        booking: bookingFacts(booking),
        bookingUrl: appUrl(guestBookingPath(booking)),
        documentNumber,
        name: booking.guest.name,
        refundTo: sentTo,
        sentOn,
        transactionId: input.transactionId,
      }),
      title: "Refund sent",
      type: "BOOKING_REFUND_SENT",
    });
  } else {
    await notifyHostel(booking, {
      action: "booking_payout_sent",
      body: `${rupees(sent.amount)} for booking ${booking.code} sent to ${sentTo}. Transaction ${input.transactionId}.`,
      email: (contact) =>
        bookingPayoutSentEmail({
          amount: sent.amount,
          bookingsUrl: appUrl(hostelBookingsPath(booking)),
          code: booking.code,
          documentNumber,
          guestName: booking.guest.name,
          hostelName: booking.hostelSnapshot.name,
          name: contact.name,
          paidTo: sentTo,
          roomType: booking.roomType,
          sentOn,
          transactionId: input.transactionId,
        }),
      title: "Payout sent",
      type: "BOOKING_PAYOUT_SENT",
    });
  }

  return toTransferView({ ...sent, documentNumber }, booking, payoutAccount);
}

/** The full account number, for the superadmin typing it into a banking app. Audited. */
export async function revealTransferDestination(transferId: string, principal: ApiPrincipal) {
  assertSuperadmin(principal);

  await connectToDatabase();

  const transfer = await loadTransfer(transferId);

  if (transfer.kind === "PAYOUT") {
    const hostelId = transfer.hostelId
      ? String(transfer.hostelId)
      : String((await BookingModel.findById(transfer.bookingId).lean<BookingRecord | null>())?.hostelId ?? "");

    return { account: await revealHostelPayoutAccount(hostelId, principal), kind: "PAYOUT" as const };
  }

  const booking = await BookingModel.findById(transfer.bookingId).lean<
    (BookingRecord & { refundAccount: BookingRecord["refundAccount"] & { number: Parameters<typeof openValue>[0] } }) | null
  >();

  if (!booking) {
    throw new BookingError("The booking behind this transfer is missing.", "BOOKING_NOT_FOUND", 404);
  }

  const number = openValue(booking.refundAccount.number, refundScope(booking._id));

  await AuditLogModel.create({
    action: "BOOKING_REFUND_ACCOUNT_REVEALED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(booking._id),
    entityType: "Booking",
    hostelId: booking.hostelId,
    metadata: { code: booking.code, last4: booking.refundAccount.numberLast4 },
  });

  return {
    account: {
      ...describeDestination(booking.refundAccount)!,
      branch: booking.refundAccount.branch ?? "",
      number,
    },
    kind: "REFUND" as const,
  };
}
