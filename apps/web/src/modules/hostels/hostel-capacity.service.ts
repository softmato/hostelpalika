import type { Types } from "mongoose";

import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { HostelModel } from "@hostel/db/models/Hostel";

/**
 * Occupancy is tracked as counts, not records.
 *
 * `hostel.roomConfigurations` is the single source of truth: for each room type
 * the owner tells us how many rooms there are, how many beds each holds, and
 * how many of those beds are currently free. Taking a resident in decrements
 * that type's `vacantBeds`; moving them out adds it back. There are no Room or
 * Bed documents anywhere in the system.
 *
 * `hostel.capacitySummary` is derived from the same array so the public listing
 * and the admin dashboard never disagree with each other.
 */

export type RoomConfiguration = {
  bedsPerRoom?: number;
  mealInclusion?: string;
  monthlyRent?: number;
  rooms?: number;
  roomType: string;
  vacantBeds?: number;
};

export class CapacityError extends Error {
  constructor(
    message: string,
    public errorCode = "CAPACITY_ERROR",
    public status = 409,
  ) {
    super(message);
  }
}

function totalBedsFor(config: RoomConfiguration) {
  return (config.rooms ?? 0) * Math.max(1, config.bedsPerRoom ?? 1);
}

export function summarizeConfigurations(configurations: RoomConfiguration[]) {
  return configurations.reduce(
    (summary, config) => ({
      totalBeds: summary.totalBeds + totalBedsFor(config),
      totalRooms: summary.totalRooms + (config.rooms ?? 0),
      vacantBeds: summary.vacantBeds + (config.vacantBeds ?? 0),
    }),
    { totalBeds: 0, totalRooms: 0, vacantBeds: 0 },
  );
}

async function loadConfigurations(hostelId: Types.ObjectId) {
  const hostel = await HostelModel.findOne({ _id: hostelId, isDeleted: false })
    .select("roomConfigurations")
    .lean<{ roomConfigurations?: RoomConfiguration[] } | null>();

  if (!hostel) {
    throw new CapacityError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  return hostel.roomConfigurations ?? [];
}

export async function writeConfigurations(
  hostelId: Types.ObjectId,
  configurations: RoomConfiguration[],
) {
  await HostelModel.updateOne(
    { _id: hostelId, isDeleted: false },
    {
      $set: {
        capacitySummary: summarizeConfigurations(configurations),
        roomConfigurations: configurations,
      },
    },
  );

  // Every claim, release and move lands here, so one publish covers all three.
  // Vacancy counts drive the intake form's room-type dropdown — two admins
  // admitting residents at once must not both be shown the same free bed.
  await publishResourceChange({
    hostelIds: [hostelId.toString()],
    topics: [REALTIME_TOPIC.ROOMS, REALTIME_TOPIC.RESIDENTS],
  });
}

/** Recomputes capacitySummary from roomConfigurations. */
export async function refreshCapacitySummary(hostelId: Types.ObjectId) {
  const configurations = await loadConfigurations(hostelId);

  await HostelModel.updateOne(
    { _id: hostelId, isDeleted: false },
    { $set: { capacitySummary: summarizeConfigurations(configurations) } },
  );
}

/**
 * Every room type the hostel offers, vacant or not, with its current rent.
 *
 * The rate card needs this rather than {@link listAvailableRoomTypes}: a room
 * type that is full still has to be priced, and pricing only what has vacancy
 * today would silently drop a rate the next time the card was saved.
 */
export async function listAllRoomTypes(hostelId: Types.ObjectId) {
  const configurations = await loadConfigurations(hostelId);

  return configurations
    .map((config) => ({
      monthlyRent: config.monthlyRent ?? 0,
      roomType: config.roomType,
    }))
    .sort((a, b) => a.roomType.localeCompare(b.roomType));
}

/** Room types with at least one free bed, for the resident intake dropdown. */
export async function listAvailableRoomTypes(hostelId: Types.ObjectId) {
  const configurations = await loadConfigurations(hostelId);

  return configurations
    .filter((config) => (config.vacantBeds ?? 0) > 0)
    .map((config) => ({
      monthlyRent: config.monthlyRent ?? 0,
      roomType: config.roomType,
      vacantBeds: config.vacantBeds ?? 0,
    }))
    .sort((a, b) => a.roomType.localeCompare(b.roomType));
}

/**
 * Claims one bed of the given room type. Throws if the type is unknown to the
 * hostel or has no vacancy left, so a resident is never admitted into a room
 * type that is already full.
 */
export async function claimBedForRoomType(hostelId: Types.ObjectId, roomType: string) {
  const configurations = await loadConfigurations(hostelId);
  const target = configurations.find((config) => config.roomType === roomType);

  if (!target) {
    throw new CapacityError(
      `"${roomType}" is not one of this hostel's room types.`,
      "ROOM_TYPE_NOT_FOUND",
      404,
    );
  }

  if ((target.vacantBeds ?? 0) <= 0) {
    throw new CapacityError(
      `No vacant beds left in "${roomType}".`,
      "ROOM_TYPE_FULL",
      409,
    );
  }

  const next = configurations.map((config) =>
    config.roomType === roomType
      ? { ...config, vacantBeds: (config.vacantBeds ?? 0) - 1 }
      : config,
  );

  await writeConfigurations(hostelId, next);

  return { roomType, vacantBeds: (target.vacantBeds ?? 0) - 1 };
}

/**
 * Returns a bed to the pool when a resident moves out. Capped at the type's
 * total beds so repeated move-outs can never report more vacancy than exists.
 * A room type that no longer exists is ignored rather than treated as an error
 * — the resident still needs to be able to leave.
 */
export async function releaseBedForRoomType(hostelId: Types.ObjectId, roomType: string) {
  const configurations = await loadConfigurations(hostelId);
  const target = configurations.find((config) => config.roomType === roomType);

  if (!target) {
    return { released: false, roomType };
  }

  const capped = Math.min((target.vacantBeds ?? 0) + 1, totalBedsFor(target));
  const next = configurations.map((config) =>
    config.roomType === roomType ? { ...config, vacantBeds: capped } : config,
  );

  await writeConfigurations(hostelId, next);

  return { released: true, roomType, vacantBeds: capped };
}

/**
 * Moves a resident between room types in one step, so a failure to claim the
 * new type never leaves their old bed released.
 */
export async function moveBedBetweenRoomTypes(
  hostelId: Types.ObjectId,
  fromRoomType: string,
  toRoomType: string,
) {
  if (fromRoomType === toRoomType) {
    return;
  }

  await claimBedForRoomType(hostelId, toRoomType);
  await releaseBedForRoomType(hostelId, fromRoomType);
}
