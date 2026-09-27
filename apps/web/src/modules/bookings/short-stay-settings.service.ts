import "server-only";

import type { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";

import { connectToDatabase } from "@/lib/db";
import { hostelPeriodOf } from "@/lib/hostel-day";
import { getBookingConfig, type BookingConfig } from "@/modules/bookings/booking-config";
import { BookingError } from "@/modules/bookings/booking.errors";
import { dailyFloor, shortStaysInputSchema, type ShortStaysInput } from "@/modules/bookings/short-stay";
import {
  getEffectiveSchedule,
  rateForRoomType,
  sameRoomType,
} from "@/modules/finance/fee-schedule.service";

/**
 * Whether a hostel takes short stays, its minimum nights and a daily rate per
 * room type. Read and written by the hostel's own Bookings → Settings, and
 * written once more by registration.
 */

export type HostelShortStays = {
  enabled: boolean;
  minNights: number;
  rates: Array<{ dailyRate: number; roomType: string }>;
};

export type ShortStayRoom = {
  dailyRate: number | null;
  /** The lowest daily rate this room type may be sold at. Null until it has a monthly rent. */
  floor: number | null;
  monthlyRent: number | null;
  roomType: string;
};

export type ShortStaySettingsView = {
  enabled: boolean;
  limits: { hostelSharePercent: number; maxNights: number; minMarkupPercent: number };
  minNights: number;
  rooms: ShortStayRoom[];
};

type HostelRooms = {
  roomConfigurations?: Array<{ roomType: string }>;
  shortStays?: Partial<HostelShortStays> | null;
};

/** Each room type the hostel lists, with its monthly rent from this month's rate card and its floor. */
export async function shortStayRooms(
  hostelId: Types.ObjectId | string,
  hostel: HostelRooms,
  config: BookingConfig,
  now = new Date(),
): Promise<ShortStayRoom[]> {
  const schedule = await getEffectiveSchedule(hostelId, hostelPeriodOf(now));
  const rates = hostel.shortStays?.rates ?? [];

  return (hostel.roomConfigurations ?? []).map((room) => {
    const monthly = rateForRoomType(schedule, room.roomType)?.monthlyAmount ?? null;
    const monthlyRent = typeof monthly === "number" && monthly > 0 ? monthly : null;

    return {
      dailyRate: rates.find((rate) => sameRoomType(rate.roomType, room.roomType))?.dailyRate ?? null,
      floor: monthlyRent ? dailyFloor(monthlyRent, config.shortStayMinMarkupPercent) : null,
      monthlyRent,
      roomType: room.roomType,
    };
  });
}

async function loadHostel(hostelId: Types.ObjectId | string) {
  const hostel = await HostelModel.findById(hostelId)
    .select("roomConfigurations shortStays")
    .lean<HostelRooms | null>();

  if (!hostel) {
    throw new BookingError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  return hostel;
}

export async function getShortStaySettings(hostelId: Types.ObjectId | string): Promise<ShortStaySettingsView> {
  await connectToDatabase();

  const [hostel, config] = await Promise.all([loadHostel(hostelId), getBookingConfig()]);

  return {
    enabled: Boolean(hostel.shortStays?.enabled),
    limits: {
      hostelSharePercent: config.shortStayHostelSharePercent,
      maxNights: config.shortStayMaxNights,
      minMarkupPercent: config.shortStayMinMarkupPercent,
    },
    minNights: hostel.shortStays?.minNights ?? 1,
    rooms: await shortStayRooms(hostelId, hostel, config),
  };
}

/**
 * Checks a proposal against the hostel's rooms and the platform's floor, and
 * returns it with each room type spelled the way the hostel lists it. A rate
 * below the floor is refused, never raised quietly: the owner has to see it.
 */
export function checkShortStays(
  input: ShortStaysInput,
  rooms: ShortStayRoom[],
  config: Pick<BookingConfig, "shortStayMaxNights">,
): HostelShortStays {
  if (input.minNights > config.shortStayMaxNights) {
    throw new BookingError(
      `The minimum stay can be at most ${config.shortStayMaxNights} nights. Longer stays are monthly.`,
      "SHORT_STAY_MIN_NIGHTS_TOO_HIGH",
      422,
    );
  }

  const rates: HostelShortStays["rates"] = [];

  for (const rate of input.rates) {
    const room = rooms.find((candidate) => sameRoomType(candidate.roomType, rate.roomType));

    if (!room) {
      throw new BookingError(`This hostel has no "${rate.roomType}" room type.`, "ROOM_NOT_FOUND", 422);
    }

    if (!room.floor) {
      throw new BookingError(
        `Set a monthly rent for ${room.roomType} on the rate card first. The daily rate is checked against it.`,
        "SHORT_STAY_ROOM_NOT_PRICED",
        422,
      );
    }

    if (rate.dailyRate < room.floor) {
      throw new BookingError(
        `${room.roomType} must be at least Rs ${room.floor.toLocaleString("en-IN")} a night.`,
        "SHORT_STAY_RATE_TOO_LOW",
        422,
        { floor: room.floor, roomType: room.roomType },
      );
    }

    if (!rates.some((existing) => sameRoomType(existing.roomType, room.roomType))) {
      rates.push({ dailyRate: rate.dailyRate, roomType: room.roomType });
    }
  }

  if (input.enabled && rates.length === 0) {
    throw new BookingError(
      "Give at least one room type a daily rate to take short stays.",
      "SHORT_STAY_NO_RATES",
      422,
    );
  }

  return { enabled: input.enabled, minNights: input.minNights, rates };
}

export async function saveShortStaySettings(
  hostelId: Types.ObjectId | string,
  rawInput: unknown,
  actorId: string,
): Promise<ShortStaySettingsView> {
  const input = shortStaysInputSchema.parse(rawInput);

  await connectToDatabase();

  const [hostel, config] = await Promise.all([loadHostel(hostelId), getBookingConfig()]);
  const shortStays = checkShortStays(input, await shortStayRooms(hostelId, hostel, config), config);

  await HostelModel.updateOne({ _id: hostelId }, { $set: { shortStays } });
  await AuditLogModel.create({
    action: "HOSTEL_SHORT_STAYS_SAVED",
    actorId,
    actorType: "USER",
    entityId: String(hostelId),
    entityType: "Hostel",
    hostelId,
    metadata: shortStays,
  }).catch(() => undefined);

  return getShortStaySettings(hostelId);
}

/**
 * A registration's short stays, checked against the monthly rents the same form
 * states. Undefined when it takes none. Runs before anything is written, so a
 * rate under its floor refuses the whole registration cleanly.
 */
export async function registrationShortStays(input: {
  roomConfigurations: Array<{ monthlyRent?: number; roomType: string }>;
  shortStays?: ShortStaysInput;
}): Promise<HostelShortStays | undefined> {
  if (!input.shortStays?.enabled) {
    return undefined;
  }

  const config = await getBookingConfig();
  const rooms = input.roomConfigurations.map((room): ShortStayRoom => {
    const monthlyRent = room.monthlyRent && room.monthlyRent > 0 ? room.monthlyRent : null;

    return {
      dailyRate: null,
      floor: monthlyRent ? dailyFloor(monthlyRent, config.shortStayMinMarkupPercent) : null,
      monthlyRent,
      roomType: room.roomType,
    };
  });

  return checkShortStays(input.shortStays, rooms, config);
}
