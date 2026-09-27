import "server-only";

import { Types } from "mongoose";

import { HostelModel } from "@hostel/db/models/Hostel";

import { connectToDatabase } from "@/lib/db";
import { hostelPeriodOf } from "@/lib/hostel-day";
import { photosOfKind, resolveHostelPhotoUrls, type HostelPhoto } from "@/lib/hostel-photos";
import { getBookingConfig, type BookingConfig } from "@/modules/bookings/booking-config";
import { bookingFee } from "@/modules/bookings/booking-terms";
import { dailyFloor } from "@/modules/bookings/short-stay";
import { isPayoutAccountVerified } from "@/modules/bookings/payout-account.service";
import {
  getEffectiveSchedule,
  rateForRoomType,
  sameRoomType,
} from "@/modules/finance/fee-schedule.service";
import { suspensionStage } from "@/modules/hostels/hostel-suspension";

/**
 * Whether a room type can be booked right now, and if not, why.
 *
 * One function answers for the Book buttons on the hostel page, the checkout's
 * quote and the create call, so the button a person pressed and the refusal
 * they might get can never disagree. Every reason is a stable code; the screens
 * word it.
 */

export type BookingUnavailableReason =
  /** Bookings are switched off platform-wide. */
  | "BOOKINGS_OFF"
  /** The hostel is not a live, verified listing. */
  | "HOSTEL_NOT_LIVE"
  /** The hostel's plan suspension has started. */
  | "HOSTEL_SUSPENDED"
  /** Strikes, or a superadmin, paused bookings on this hostel. */
  | "BOOKINGS_PAUSED"
  /** The platform has nowhere verified to pay the hostel its share. */
  | "NO_PAYOUT_ACCOUNT"
  /** The rate card has no current rent for this room type. */
  | "NOT_PRICED"
  /** No vacant bed of this room type. */
  | "FULL"
  /** The hostel does not list this room type. */
  | "ROOM_NOT_FOUND";

export type BookableHostel = {
  _id: Types.ObjectId;
  bookingPause?: { pausedAt?: Date | null } | null;
  contact?: { phone?: string | null } | null;
  hostelType?: string;
  isDeleted?: boolean;
  location?: { address?: string; area?: string; city?: string } | null;
  name: string;
  photos?: Array<HostelPhoto & { fileAssetId?: Types.ObjectId }>;
  roomConfigurations?: Array<{
    bedsPerRoom?: number;
    mealInclusion?: string;
    roomType: string;
    vacantBeds?: number;
  }>;
  shortStays?: {
    enabled?: boolean;
    minNights?: number;
    rates?: Array<{ dailyRate: number; roomType: string }>;
  } | null;
  slug: string;
  status?: string;
  suspension?: { graceEndsAt?: Date | null; startedAt?: Date | null } | null;
  verificationStatus?: string;
};

export type RoomAvailability = {
  bedsPerRoom: number | null;
  bookable: boolean;
  /**
   * A night's price for a short stay: the hostel's rate, never below today's
   * floor (a rent rise since the rate was set lifts it). Null when this room
   * type takes no short stays.
   */
  dailyRate: number | null;
  fee: number | null;
  mealInclusion: string | null;
  monthlyRent: number | null;
  /**
   * Only this room type's own ROOM photos, never the hostel's exterior or
   * another room's: the checkout shows them as the room being booked.
   */
  photos: string[];
  reason: BookingUnavailableReason | null;
  roomType: string;
  vacantBeds: number;
};

export type HostelAvailability = {
  /** Set when nothing on the hostel can be booked, whatever the room. */
  hostelReason: BookingUnavailableReason | null;
  rooms: RoomAvailability[];
  /** Set when the hostel takes short stays: the limits a date picker needs. */
  shortStays: { maxAdvanceDays: number; maxNights: number; minNights: number } | null;
};

const HOSTEL_FIELDS =
  "bookingPause contact hostelType isDeleted location name photos roomConfigurations shortStays slug status suspension verificationStatus";

export async function loadBookableHostel(ref: string): Promise<BookableHostel | null> {
  await connectToDatabase();

  const filter = Types.ObjectId.isValid(ref) ? { _id: new Types.ObjectId(ref) } : { slug: ref };

  return HostelModel.findOne(filter).select(HOSTEL_FIELDS).lean<BookableHostel | null>();
}

export function hostelAddress(hostel: BookableHostel) {
  return [hostel.location?.address, hostel.location?.area, hostel.location?.city]
    .map((part) => part?.trim())
    .filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index)
    .join(", ");
}

export function hostelCoverPhoto(hostel: BookableHostel) {
  return resolveHostelPhotoUrls(hostel.photos, "EXTERIOR")[0] ?? null;
}

/**
 * The same cover for a set of hostels in one read, keyed by hostel id — the
 * bookings list draws one per row and must not read a hostel per booking.
 */
export async function hostelCoverPhotos(hostelIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(hostelIds)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));

  if (ids.length === 0) {
    return new Map();
  }

  await connectToDatabase();

  const hostels = await HostelModel.find({ _id: { $in: ids } })
    .select("photos")
    .lean<Array<{ _id: Types.ObjectId; photos?: HostelPhoto[] }>>();

  const covers = new Map<string, string>();

  for (const hostel of hostels) {
    const url = resolveHostelPhotoUrls(hostel.photos, "EXTERIOR")[0];

    if (url) {
      covers.set(String(hostel._id), url);
    }
  }

  return covers;
}

/** The hostel-wide refusal, before any room is looked at. */
export async function hostelUnavailableReason(
  hostel: BookableHostel,
  config: BookingConfig,
  now = new Date(),
): Promise<BookingUnavailableReason | null> {
  if (!config.enabled) {
    return "BOOKINGS_OFF";
  }

  if (hostel.isDeleted || hostel.status !== "PUBLISHED" || hostel.verificationStatus !== "VERIFIED") {
    return "HOSTEL_NOT_LIVE";
  }

  // Pre-suspension too: a hostel days from losing its portal cannot promise to
  // answer a booking, let alone hold a bed for a week.
  if (suspensionStage(hostel.suspension as Parameters<typeof suspensionStage>[0], now)) {
    return "HOSTEL_SUSPENDED";
  }

  if (hostel.bookingPause?.pausedAt) {
    return "BOOKINGS_PAUSED";
  }

  if (!(await isPayoutAccountVerified(hostel._id))) {
    return "NO_PAYOUT_ACCOUNT";
  }

  return null;
}

export async function hostelAvailability(
  hostel: BookableHostel,
  options: { config?: BookingConfig; now?: Date } = {},
): Promise<HostelAvailability> {
  const now = options.now ?? new Date();
  const config = options.config ?? (await getBookingConfig());
  const hostelReason = await hostelUnavailableReason(hostel, config, now);
  const schedule = await getEffectiveSchedule(hostel._id, hostelPeriodOf(now));

  const shortStays = hostel.shortStays?.enabled ? hostel.shortStays : null;
  const rooms = (hostel.roomConfigurations ?? []).map((room): RoomAvailability => {
    const rent = rateForRoomType(schedule, room.roomType)?.monthlyAmount ?? null;
    const setRate = shortStays?.rates?.find((rate) => sameRoomType(rate.roomType, room.roomType))?.dailyRate;
    const vacantBeds = Math.max(0, room.vacantBeds ?? 0);
    const priced = typeof rent === "number" && rent > 0;
    const reason: BookingUnavailableReason | null =
      hostelReason ?? (!priced ? "NOT_PRICED" : vacantBeds <= 0 ? "FULL" : null);

    return {
      bedsPerRoom: room.bedsPerRoom ?? null,
      bookable: reason === null,
      dailyRate:
        priced && setRate ? Math.max(setRate, dailyFloor(rent, config.shortStayMinMarkupPercent)) : null,
      fee: priced ? bookingFee(rent, config.feePercent) : null,
      mealInclusion: room.mealInclusion ?? null,
      monthlyRent: priced ? rent : null,
      photos: photosOfKind(hostel.photos, "ROOM", room.roomType)
        .map((photo) => photo.url ?? "")
        .slice(0, 6),
      reason,
      roomType: room.roomType,
      vacantBeds,
    };
  });

  return {
    hostelReason,
    rooms,
    shortStays: shortStays
      ? {
          maxAdvanceDays: config.shortStayMaxAdvanceDays,
          maxNights: config.shortStayMaxNights,
          minNights: Math.min(shortStays.minNights ?? 1, config.shortStayMaxNights),
        }
      : null,
  };
}

export function findRoom(availability: HostelAvailability, roomType: string) {
  return availability.rooms.find((room) => sameRoomType(room.roomType, roomType)) ?? null;
}
