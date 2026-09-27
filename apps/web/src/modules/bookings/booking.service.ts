import "server-only";

import { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { BookingModel } from "@hostel/db/models/Booking";
import { BookingPaymentModel } from "@hostel/db/models/BookingPayment";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";
import { ConsentLogModel } from "@hostel/db/models/ConsentLog";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { hostelToday } from "@hostel/shared/calendar/bs";
import {
  bookingInvoiceEmail,
  bookingProofReceivedEmail,
} from "@hostel/shared/email/templates/booking/guest";
import { bookingProofToCheckEmail } from "@hostel/shared/email/templates/booking/platform";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { allocate } from "@/modules/billing/documents/issue";
import {
  findRoom,
  hostelAddress,
  hostelAvailability,
  hostelCoverPhoto,
  hostelCoverPhotos,
  loadBookableHostel,
  type BookingUnavailableReason,
  type HostelAvailability,
  type RoomAvailability,
} from "@/modules/bookings/booking-availability";
import { bookingPolicyVersion, newBookingCode } from "@/modules/bookings/booking-code";
import { amountDue, quoteStay, type BookingStay } from "@/modules/bookings/short-stay";
import { getBookingConfig, type BookingConfig } from "@/modules/bookings/booking-config";
import { endBooking, moveBooking } from "@/modules/bookings/booking-lifecycle";
import {
  appUrl,
  bookingFacts,
  guestBookingPath,
  notifyGuest,
  notifyPlatform,
  PLATFORM_BOOKINGS_PATH,
  when,
} from "@/modules/bookings/booking-notify";
import { bookingDocumentAttachment } from "@/modules/bookings/booking-documents.service";
import { DAY_MS, HOUR_MS, termsFromConfig, type BookingTerms } from "@/modules/bookings/booking-terms";
import {
  createBookingSchema,
  submitBookingPaymentSchema,
} from "@/modules/bookings/booking.validation";
import {
  policySummary,
  toGuestView,
  type BookingRecord,
  type GuestBookingView,
  type PolicySummary,
  type TransferRecord,
} from "@/modules/bookings/booking-views";
import { BookingError } from "@/modules/bookings/booking.errors";
import { raiseBookingInvoiceSoon } from "@/modules/bookings/booking-softmato.service";
import { sealValue } from "@/modules/finance/gateway/secret-store";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";

/**
 * A person booking a room: the quote, the booking, the screenshot.
 *
 * docs/BOOKINGS.md item 5. The hostel's answer and cancellations live in
 * `booking-answer.service.ts`, the clock in `booking-sweep.service.ts`, check-in
 * in `booking-checkin.service.ts`; the superadmin's payment check in
 * `booking-review.service.ts`.
 */

export const REFUND_ACCOUNT_PURPOSE = "BOOKING_REFUND_ACCOUNT";

/** Mirrors the rotation script: the envelope opens only in this booking. */
export function refundScope(bookingId: Types.ObjectId | string) {
  return { hostelId: String(bookingId), purpose: REFUND_ACCOUNT_PURPOSE };
}

/** How far ahead a person may say they plan to arrive. Informational only. */
const PLANNED_MOVE_IN_MAX_DAYS = 60;

/** Same fortnight the resident and plan claim paths allow. */
const PROOF_MAX_AGE_MS = 14 * DAY_MS;

const BOOKING_ROLES = new Set<string>([Role.PUBLIC, Role.RESIDENT]);

const UNAVAILABLE_MESSAGES: Record<BookingUnavailableReason, string> = {
  BOOKINGS_OFF: "Room booking is not open yet.",
  BOOKINGS_PAUSED: "This hostel is not taking bookings right now.",
  FULL: "This room type is full.",
  HOSTEL_NOT_LIVE: "This hostel is not listed right now.",
  HOSTEL_SUSPENDED: "This hostel is not taking bookings right now.",
  NOT_PRICED: "This room type has no rent set yet, so it cannot be booked.",
  NO_PAYOUT_ACCOUNT: "This hostel is not taking bookings yet.",
  ROOM_NOT_FOUND: "This hostel does not have that room type.",
};

export function unavailableMessage(reason: BookingUnavailableReason) {
  return UNAVAILABLE_MESSAGES[reason];
}

/* ── The payment step ─────────────────────────────────────────────────── */

export type PayInstructions = {
  amount: number;
  checkHours: number;
  payBy: string;
  qr: { label: string; url: string } | null;
  /** What goes in the remarks box: the booking code. */
  reference: string;
};

async function payInstructions(booking: BookingRecord): Promise<PayInstructions | null> {
  if (booking.status !== "AWAITING_PAYMENT") {
    return null;
  }

  const [operations, config] = await Promise.all([getOperationsConfig(), getBookingConfig()]);

  return {
    amount: amountDue(booking),
    checkHours: config.paymentCheckHours,
    payBy: new Date(booking.paymentDueBy).toISOString(),
    qr: operations.collectionQrUrl
      ? { label: operations.collectionQrLabel || "Scan to pay", url: operations.collectionQrUrl }
      : null,
    reference: booking.code,
  };
}

export type GuestBookingDetail = GuestBookingView & {
  coverPhotoUrl: string | null;
  pay: PayInstructions | null;
};

async function detailFor(booking: BookingRecord, now = new Date()): Promise<GuestBookingDetail> {
  const [refundTransfer, hostel, pay] = await Promise.all([
    BookingTransferModel.findOne({ bookingId: booking._id, kind: "REFUND" }).lean<TransferRecord | null>(),
    loadBookableHostel(String(booking.hostelId)),
    payInstructions(booking),
  ]);

  return {
    ...toGuestView(booking, { now, refundTransfer }),
    coverPhotoUrl: hostel ? hostelCoverPhoto(hostel) : null,
    pay,
  };
}

/* ── The quote ────────────────────────────────────────────────────────── */

export type BookingQuote = {
  available: boolean;
  fee: number | null;
  hostel: {
    address: string;
    coverPhotoUrl: string | null;
    hostelType: string | null;
    id: string;
    name: string;
    phone: string;
    slug: string;
  };
  /** The person's open booking elsewhere, which would block a new one. */
  openBooking: { code: string; hostelName: string; id: string } | null;
  payment: { checkHours: number; qrReady: boolean; unpaidWindowHours: number };
  policy: PolicySummary | null;
  policyVersion: string;
  reason: BookingUnavailableReason | null;
  reasonMessage: string | null;
  room: RoomAvailability;
  /**
   * The short-stay side of the same room. `quote` is priced once both dates are
   * given and valid; `error` says why dates were refused.
   */
  shortStay: {
    available: boolean;
    dailyRate: number | null;
    error: { code: string; message: string } | null;
    limits: { maxAdvanceDays: number; maxNights: number; minNights: number } | null;
    quote: {
      fee: number;
      holdBlocks: number;
      moveIn: string;
      moveOut: string;
      nights: number;
      stayAmount: number;
      total: number;
    } | null;
  };
  terms: { feePercent: number; holdDays: number; hostelAnswerHours: number };
};

/**
 * Prices a short stay on this room, or throws why it cannot be had. The one
 * rule the quote and the create call share.
 */
function priceShortStay(
  availability: HostelAvailability,
  room: RoomAvailability,
  dates: { moveIn?: string | null; moveOut?: string | null },
  config: BookingConfig,
  now: Date,
): BookingStay {
  if (!availability.shortStays || !room.dailyRate) {
    throw new BookingError("This room does not take short stays.", "SHORT_STAYS_OFF", 409);
  }

  return quoteStay({
    dailyRate: room.dailyRate,
    holdDays: config.holdDays,
    hostelSharePercent: config.shortStayHostelSharePercent,
    maxAdvanceDays: availability.shortStays.maxAdvanceDays,
    maxNights: availability.shortStays.maxNights,
    minNights: availability.shortStays.minNights,
    moveIn: dates.moveIn ?? "",
    moveOut: dates.moveOut ?? "",
    now,
  });
}

function shortStayQuote(
  availability: HostelAvailability,
  room: RoomAvailability,
  dates: { moveIn?: string | null; moveOut?: string | null },
  config: BookingConfig,
  now: Date,
): BookingQuote["shortStay"] {
  const base = {
    available: Boolean(availability.shortStays && room.dailyRate && room.bookable),
    dailyRate: room.dailyRate,
    error: null,
    limits: availability.shortStays,
    quote: null,
  };

  if (!base.available || !room.fee || !dates.moveIn || !dates.moveOut) {
    return base;
  }

  try {
    const stay = priceShortStay(availability, room, dates, config, now);
    const fee = room.fee * stay.holdBlocks;

    return {
      ...base,
      quote: {
        fee,
        holdBlocks: stay.holdBlocks,
        moveIn: dates.moveIn,
        moveOut: dates.moveOut,
        nights: stay.nights,
        stayAmount: stay.amount,
        total: fee + stay.amount,
      },
    };
  } catch (error) {
    if (!(error instanceof BookingError)) throw error;

    return { ...base, error: { code: error.errorCode, message: error.message } };
  }
}

/**
 * Everything the checkout draws before a booking exists.
 *
 * Public: a signed-out visitor sees the same price and policy, and signs in at
 * the button. `principal` only adds the one fact that depends on who is
 * looking — an open booking that would stop them.
 */
export async function getBookingQuote(
  hostelRef: string,
  roomType: string,
  principal: ApiPrincipal | null,
  dates: { moveIn?: string | null; moveOut?: string | null } = {},
): Promise<BookingQuote> {
  await connectToDatabase();

  const now = new Date();
  const [config, hostel, legal, operations] = await Promise.all([
    getBookingConfig(),
    loadBookableHostel(hostelRef),
    getSiteConfigSection("legal"),
    getOperationsConfig(),
  ]);

  if (!hostel || hostel.isDeleted || hostel.status !== "PUBLISHED") {
    throw new BookingError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const availability = await hostelAvailability(hostel, { config, now });
  const room = findRoom(availability, roomType);

  if (!room) {
    throw new BookingError(unavailableMessage("ROOM_NOT_FOUND"), "ROOM_NOT_FOUND", 404);
  }

  const terms = termsFromConfig(config);
  const openBooking = principal ? await findOpenBooking(principal.userId) : null;

  return {
    available: room.bookable,
    fee: room.fee,
    hostel: {
      address: hostelAddress(hostel),
      coverPhotoUrl: hostelCoverPhoto(hostel),
      hostelType: hostel.hostelType ?? null,
      id: String(hostel._id),
      name: hostel.name,
      phone: hostel.contact?.phone ?? "",
      slug: hostel.slug,
    },
    openBooking,
    payment: {
      checkHours: config.paymentCheckHours,
      qrReady: Boolean(operations.collectionQrUrl),
      unpaidWindowHours: config.unpaidWindowHours,
    },
    policy: room.fee ? policySummary(terms, room.fee) : null,
    policyVersion: bookingPolicyVersion(terms, legal.refund),
    reason: room.reason,
    reasonMessage: room.reason ? unavailableMessage(room.reason) : null,
    room,
    shortStay: shortStayQuote(availability, room, dates, config, now),
    terms: {
      feePercent: terms.feePercent,
      holdDays: terms.holdDays,
      hostelAnswerHours: terms.hostelAnswerHours,
    },
  };
}

async function findOpenBooking(userId: string) {
  const open = await BookingModel.findOne({ isOpen: true, userId })
    .select("code hostelSnapshot")
    .lean<{ _id: Types.ObjectId; code: string; hostelSnapshot: { name: string } } | null>();

  return open ? { code: open.code, hostelName: open.hostelSnapshot.name, id: String(open._id) } : null;
}

/* ── Creating a booking ───────────────────────────────────────────────── */

function isDuplicateKey(error: unknown, field: string) {
  const mongo = error as { code?: number; keyPattern?: Record<string, unknown> } | null;

  return mongo?.code === 11000 && Boolean(mongo.keyPattern && field in mongo.keyPattern);
}

function parsePlannedMoveIn(value: string | null | undefined, now: Date) {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00.000Z`);
  const today = hostelToday(now);

  if (
    Number.isNaN(date.getTime()) ||
    date.getTime() < today.getTime() ||
    date.getTime() > today.getTime() + PLANNED_MOVE_IN_MAX_DAYS * DAY_MS
  ) {
    throw new BookingError(
      `Pick a move-in date between today and ${PLANNED_MOVE_IN_MAX_DAYS} days from now.`,
      "VALIDATION_ERROR",
      422,
    );
  }

  return date;
}

export async function createBooking(
  rawInput: unknown,
  principal: ApiPrincipal,
  source: "MOBILE" | "WEB",
): Promise<GuestBookingDetail> {
  if (!BOOKING_ROLES.has(principal.role)) {
    throw new BookingError(
      "Room booking is for personal accounts. Sign in with your own account to book.",
      "BOOKING_ACCOUNT_NOT_ALLOWED",
      403,
    );
  }

  const input = createBookingSchema.parse(rawInput);

  await connectToDatabase();

  const now = new Date();
  const [config, hostel, legal] = await Promise.all([
    getBookingConfig(),
    loadBookableHostel(input.hostel),
    getSiteConfigSection("legal"),
  ]);

  if (!hostel) {
    throw new BookingError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const availability = await hostelAvailability(hostel, { config, now });
  const room = findRoom(availability, input.roomType);

  if (!room) {
    throw new BookingError(unavailableMessage("ROOM_NOT_FOUND"), "ROOM_NOT_FOUND", 404);
  }

  if (!room.bookable || !room.fee || !room.monthlyRent) {
    const reason = room.reason ?? "NOT_PRICED";

    throw new BookingError(unavailableMessage(reason), `BOOKING_UNAVAILABLE_${reason}`, 409);
  }

  const terms: BookingTerms = termsFromConfig(config);
  const policyVersion = bookingPolicyVersion(terms, legal.refund);

  if (policyVersion !== input.policyVersion) {
    throw new BookingError(
      "The booking terms changed while this page was open. Read the updated refund policy and accept it again.",
      "BOOKING_POLICY_CHANGED",
      409,
      { policyVersion },
    );
  }

  const user = await UserModel.findById(principal.userId)
    .select("email name phone")
    .lean<{ email?: string | null; name: string; phone?: string | null } | null>();

  if (!user?.email) {
    throw new BookingError(
      "Add an email address to your account first. Your invoice and receipt are sent there.",
      "BOOKING_EMAIL_REQUIRED",
      422,
    );
  }

  const open = await findOpenBooking(principal.userId);

  if (open) {
    throw new BookingError(
      `You already have an open booking (${open.code} at ${open.hostelName}). Finish or cancel it first.`,
      "OPEN_BOOKING_EXISTS",
      409,
      { bookingId: open.id, code: open.code },
    );
  }

  const livesHere = await ResidentModel.exists({
    hostelId: hostel._id,
    isDeleted: { $ne: true },
    status: { $in: ["ACTIVE", "PENDING"] },
    userId: principal.userId,
  });

  if (livesHere) {
    throw new BookingError("You already live at this hostel.", "ALREADY_RESIDENT", 409);
  }

  const stay = input.kind === "SHORT_STAY" ? priceShortStay(availability, room, input, config, now) : null;
  const fee = stay ? room.fee * stay.holdBlocks : room.fee;
  const plannedMoveIn = stay ? stay.moveIn : parsePlannedMoveIn(input.plannedMoveIn, now);
  const bookingId = new Types.ObjectId();
  const refundNumber = input.refundAccount.number;
  const invoiceNumber = await allocate("BOOKING_INVOICE", now);

  let created: BookingRecord | null = null;

  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    try {
      const document = await BookingModel.create({
        _id: bookingId,
        code: newBookingCode(),
        fee,
        guest: { email: user.email, name: user.name, phone: user.phone ?? "" },
        hostelId: hostel._id,
        hostelSnapshot: {
          address: hostelAddress(hostel),
          name: hostel.name,
          phone: hostel.contact?.phone ?? "",
          slug: hostel.slug,
        },
        invoiceNumber,
        isOpen: true,
        kind: input.kind,
        monthlyRent: room.monthlyRent,
        paymentDueBy: new Date(now.getTime() + config.unpaidWindowHours * HOUR_MS),
        plannedMoveIn,
        policy: { acceptedAt: now, source, version: policyVersion },
        refundAccount: {
          bankName: input.refundAccount.bankName,
          branch: input.refundAccount.branch,
          holderName: input.refundAccount.holderName,
          method: input.refundAccount.method,
          number: sealValue(refundNumber, refundScope(bookingId)),
          numberLast4: refundNumber.slice(-4),
        },
        roomType: room.roomType,
        status: "AWAITING_PAYMENT",
        stay,
        terms,
        userId: principal.userId,
      });

      created = document.toObject() as BookingRecord;
    } catch (error) {
      if (isDuplicateKey(error, "userId")) {
        throw new BookingError(
          "You already have an open booking. Finish or cancel it first.",
          "OPEN_BOOKING_EXISTS",
          409,
        );
      }

      if (!isDuplicateKey(error, "code")) {
        throw error;
      }
    }
  }

  if (!created) {
    throw new BookingError("The booking could not be created. Try again.", "BOOKING_NOT_CREATED", 500);
  }

  await Promise.all([
    ConsentLogModel.create({
      consentType: "BOOKING_REFUND_POLICY",
      granted: true,
      hostelId: hostel._id,
      policyVersion,
      recordedAt: now,
      source,
      userId: principal.userId,
    }).catch(() => undefined),
    AuditLogModel.create({
      action: "BOOKING_CREATED",
      actorId: principal.userId,
      actorType: "USER",
      entityId: String(created._id),
      entityType: "Booking",
      hostelId: hostel._id,
      metadata: {
        code: created.code,
        fee: created.fee,
        invoiceNumber,
        kind: input.kind,
        roomType: created.roomType,
        total: amountDue(created),
      },
    }).catch(() => undefined),
  ]);

  const policy = policySummary(terms, created.fee);

  // The invoice rides along with the mail that asks for the money.
  const invoicePaper = await bookingDocumentAttachment("invoice", created);

  // Softmato raises the fee's invoice now, so the first email already carries its number.
  await raiseBookingInvoiceSoon(created);
  created = (await BookingModel.findById(created._id).lean<BookingRecord | null>()) ?? created;

  await notifyGuest(created, {
    action: "booking_invoice",
    attachments: invoicePaper ? [invoicePaper] : undefined,
    body: `Pay Rs ${amountDue(created).toLocaleString("en-IN")} with code ${created.code} to book ${created.roomType} at ${created.hostelSnapshot.name}.`,
    email: bookingInvoiceEmail({
      booking: bookingFacts(created),
      bookingUrl: appUrl(guestBookingPath(created)),
      hostelAnswerHours: terms.hostelAnswerHours,
      invoiceNumber,
      name: user.name,
      noShowRefund: policy.noShowRefund,
      payBy: when(created.paymentDueBy),
      paymentCheckHours: config.paymentCheckHours,
      policyUrl: appUrl("/refund-policy"),
      refundRows: policy.rows,
    }),
    title: "Pay your booking fee",
    type: "BOOKING_CREATED",
  });

  return detailFor(created, now);
}

/* ── Sending the screenshot ───────────────────────────────────────────── */

async function loadBookingProof(assetId: string, actorId: string) {
  const asset = await FileAssetModel.findOne({
    _id: assetId,
    isDeleted: false,
    status: "ACTIVE",
  }).lean<{
    _id: Types.ObjectId;
    hostelId?: Types.ObjectId | null;
    kind?: string;
    ownerId?: Types.ObjectId | null;
    systemDocumentKind?: string | null;
    uploadCompletedAt?: Date | null;
  } | null>();

  // A missing file and somebody else's answer alike: probing ids learns nothing.
  if (!asset || String(asset.ownerId) !== actorId || asset.kind !== "BOOKING_PAYMENT_PROOF" || asset.hostelId) {
    throw new BookingError(
      "That file is not yours to send. Attach the screenshot again.",
      "PROOF_NOT_OWNED",
      403,
    );
  }

  if (!asset.uploadCompletedAt || asset.uploadCompletedAt.getTime() < Date.now() - PROOF_MAX_AGE_MS) {
    throw new BookingError(
      "That upload did not finish or has expired. Attach the screenshot again.",
      "PROOF_UPLOAD_INCOMPLETE",
      422,
    );
  }

  if (asset.systemDocumentKind) {
    throw new BookingError(
      "That is a document we issued, not proof of your payment. Attach the screenshot from your banking app.",
      "PROOF_IS_OUR_DOCUMENT",
      422,
    );
  }

  return asset;
}

export async function loadOwnBooking(bookingId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const booking = Types.ObjectId.isValid(bookingId)
    ? await BookingModel.findOne({ _id: bookingId, userId: principal.userId }).lean<BookingRecord | null>()
    : null;

  if (!booking) {
    throw new BookingError("Booking not found.", "BOOKING_NOT_FOUND", 404);
  }

  return booking;
}

/** Drops an unpaid booking whose window has closed. Holds nothing, owes nothing. */
export async function expireUnpaidBooking(booking: BookingRecord, now = new Date()) {
  return endBooking(booking, {
    actorId: null,
    from: ["AWAITING_PAYMENT"],
    now,
    reason: "No payment arrived in time.",
    status: "EXPIRED",
  });
}

export async function submitBookingPayment(
  bookingId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
): Promise<GuestBookingDetail> {
  const input = submitBookingPaymentSchema.parse(rawInput);
  const booking = await loadOwnBooking(bookingId, principal);
  const now = new Date();

  if (booking.status === "PAYMENT_IN_REVIEW") {
    throw new BookingError(
      "We already have your screenshot and are checking it.",
      "BOOKING_PAYMENT_IN_REVIEW",
      409,
    );
  }

  if (booking.status !== "AWAITING_PAYMENT") {
    throw new BookingError("This booking is not waiting for payment.", "BOOKING_NOT_AWAITING_PAYMENT", 409);
  }

  if (new Date(booking.paymentDueBy).getTime() <= now.getTime()) {
    await expireUnpaidBooking(booking, now);

    throw new BookingError(
      "The time to pay for this booking has run out. Book again if the room is still free.",
      "BOOKING_EXPIRED",
      410,
    );
  }

  const proof = await loadBookingProof(input.proofAssetId, principal.userId);
  const moved = await moveBooking(booking._id, "AWAITING_PAYMENT", {
    paymentSubmittedAt: now,
    status: "PAYMENT_IN_REVIEW",
  });

  if (!moved) {
    throw new BookingError("This booking is not waiting for payment.", "BOOKING_NOT_AWAITING_PAYMENT", 409);
  }

  const payment = await BookingPaymentModel.create({
    amount: amountDue(booking),
    bookingId: booking._id,
    hostelId: booking.hostelId,
    note: input.note || null,
    proofAssetId: proof._id,
    reference: input.reference || null,
    status: "IN_REVIEW",
    submittedAt: now,
    userId: booking.userId,
  });

  await AuditLogModel.create({
    action: "BOOKING_PAYMENT_SUBMITTED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(payment._id),
    entityType: "BookingPayment",
    hostelId: booking.hostelId,
    metadata: { amount: amountDue(booking), code: booking.code, proofAssetId: String(proof._id) },
  }).catch(() => undefined);

  const config = await getBookingConfig();
  const checkBy = new Date(now.getTime() + config.paymentCheckHours * HOUR_MS);

  await Promise.all([
    notifyGuest(moved, {
      action: "booking_proof_received",
      body: `We are checking your payment for ${moved.code}. You will hear from us by ${when(checkBy)}.`,
      email: bookingProofReceivedEmail({
        booking: bookingFacts(moved),
        bookingUrl: appUrl(guestBookingPath(moved)),
        checkBy: when(checkBy),
        name: moved.guest.name,
        reference: input.reference || null,
      }),
      title: "Payment screenshot received",
      type: "BOOKING_PROOF_RECEIVED",
    }),
    notifyPlatform(moved, {
      action: "booking_proof_to_check",
      body: `${moved.guest.name} sent a screenshot for Rs ${amountDue(moved).toLocaleString("en-IN")} (${moved.code}).`,
      email: bookingProofToCheckEmail({
        amount: amountDue(moved),
        checkBy: when(checkBy),
        code: moved.code,
        guestName: moved.guest.name,
        hostelName: moved.hostelSnapshot.name,
        queueUrl: appUrl(`${PLATFORM_BOOKINGS_PATH}?tab=payments`),
        reference: input.reference || null,
      }),
      tab: "payments",
      title: "Booking payment to check",
      type: "BOOKING_PROOF_TO_CHECK",
    }),
  ]);

  return detailFor(moved, now);
}

/* ── Reading one's own bookings ───────────────────────────────────────── */

export type GuestBookingSummary = {
  code: string;
  /** The hostel's cover, so the list is recognisable at a glance. */
  coverPhotoUrl: string | null;
  createdAt: string;
  fee: number;
  holdEndsAt: string | null;
  hostelName: string;
  id: string;
  roomType: string;
  status: GuestBookingView["status"];
  statusLabel: string;
};

export async function listMyBookings(principal: ApiPrincipal): Promise<GuestBookingSummary[]> {
  await connectToDatabase();

  const bookings = await BookingModel.find({ userId: principal.userId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<BookingRecord[]>();

  const covers = await hostelCoverPhotos(bookings.map((booking) => String(booking.hostelId)));

  return bookings.map((booking) => {
    const view = toGuestView(booking);

    return {
      code: view.code,
      coverPhotoUrl: covers.get(String(booking.hostelId)) ?? null,
      createdAt: view.createdAt,
      fee: view.fee,
      holdEndsAt: view.holdEndsAt,
      hostelName: view.hostel.name,
      id: view.id,
      roomType: view.roomType,
      status: view.status,
      statusLabel: view.statusLabel,
    };
  });
}

export async function getMyBooking(bookingId: string, principal: ApiPrincipal) {
  const booking = await loadOwnBooking(bookingId, principal);

  // An unpaid booking past its window is shown as what it is, not as payable.
  if (booking.status === "AWAITING_PAYMENT" && new Date(booking.paymentDueBy).getTime() <= Date.now()) {
    const expired = await expireUnpaidBooking(booking);

    return detailFor(expired ?? booking);
  }

  return detailFor(booking);
}
