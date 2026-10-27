import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  CapacityError,
  moveBedBetweenRoomTypes,
  type RoomConfiguration,
  summarizeConfigurations,
  writeConfigurations,
} from "@/modules/hostels/hostel-capacity.service";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelRoomModel } from "@hostel/db/models/HostelRoom";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { ResidentModel } from "@hostel/db/models/Resident";
import { RoomChangeRequestModel } from "@hostel/db/models/RoomChangeRequest";

/**
 * Floors and numbered rooms (docs/FIELD_FIXES_2026_10.md §3).
 *
 * A room belongs to one room type — the rate card still prices by type — and
 * has a number of beds. Who is in it is read from the residents
 * (`Resident.roomId`), never counted into a field, so a free bed is always
 * `beds − residents living there`.
 *
 * The per-type counts on `Hostel.roomConfigurations` (rooms, beds per room,
 * free beds) are what the public listing shows. Once a hostel lays out its
 * rooms, every change here re-derives them, so the listing follows the floor
 * plan instead of being typed twice.
 */

export class RoomError extends Error {
  constructor(
    message: string,
    public errorCode = "ROOM_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

const LIVE = ["ACTIVE", "PENDING", "SUSPENDED"];
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id.");

export const addRoomsSchema = z.object({
  beds: z.coerce.number().int().min(1).max(40),
  floor: z.coerce.number().int().min(-5).max(200),
  hostelId: objectId.optional(),
  /** "101", "102"… — the app builds them from a first number and a count. */
  numbers: z.array(z.string().trim().min(1).max(20)).min(1).max(100),
  roomType: z.string().trim().min(1).max(80),
});

export const updateRoomSchema = z.object({
  beds: z.coerce.number().int().min(1).max(40).optional(),
  floor: z.coerce.number().int().min(-5).max(200).optional(),
  hostelId: objectId.optional(),
  number: z.string().trim().min(1).max(20).optional(),
  roomType: z.string().trim().min(1).max(80).optional(),
});

export const roomTrackingSchema = z.object({
  enabled: z.boolean(),
  hostelId: objectId.optional(),
});

export const roomChangeAskSchema = z.object({
  note: z.string().trim().max(200).optional(),
  toRoomId: objectId,
});

export const roomChangeAnswerSchema = z.object({
  action: z.enum(["approve", "decline"]),
  hostelId: objectId.optional(),
  reason: z.string().trim().max(200).optional(),
});

type RoomRow = {
  _id: Types.ObjectId;
  beds: number;
  floor: number;
  number: string;
  roomType: string;
};

type LiveResident = {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  roomId?: Types.ObjectId | null;
  roomType: string;
};

export type RoomView = {
  beds: number;
  floor: number;
  free: number;
  id: string;
  number: string;
  residents: { id: string; name: string }[];
  roomType: string;
};

/** "Ground floor", "1st floor", "Basement". */
export function floorLabel(floor: number) {
  if (floor === 0) return "Ground floor";
  if (floor < 0) return floor === -1 ? "Basement" : `Basement ${-floor}`;

  const tens = floor % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[floor % 10] ?? "th";

  return `${floor}${suffix} floor`;
}

const oid = (value: Types.ObjectId | string) => new Types.ObjectId(String(value));

/**
 * Floor-wise: the owner's choice, made on KYC or in Settings. Unchosen, it is
 * off — except for a hostel that already numbered rooms before the choice
 * existed, which keeps them.
 */
export async function isRoomTracking(hostelId: Types.ObjectId | string) {
  const settings = await HostelSettingsModel.findOne({ hostelId: oid(hostelId) })
    .select("roomTracking")
    .lean<{ roomTracking?: boolean } | null>();

  if (typeof settings?.roomTracking === "boolean") return settings.roomTracking;

  return Boolean(await HostelRoomModel.exists({ hostelId: oid(hostelId), isDeleted: false }));
}

async function loadRooms(hostelId: Types.ObjectId) {
  return HostelRoomModel.find({ hostelId, isDeleted: false })
    .sort({ floor: 1, number: 1 })
    .select("beds floor number roomType")
    .lean<RoomRow[]>();
}

async function loadLiveResidents(hostelId: Types.ObjectId) {
  return ResidentModel.find({ hostelId, isDeleted: { $ne: true }, status: { $in: LIVE } })
    .select("firstName lastName roomId roomType")
    .lean<LiveResident[]>();
}

function viewRooms(rooms: RoomRow[], residents: LiveResident[]): RoomView[] {
  const byRoom = new Map<string, LiveResident[]>();

  for (const resident of residents) {
    if (!resident.roomId) continue;
    const key = resident.roomId.toString();
    byRoom.set(key, [...(byRoom.get(key) ?? []), resident]);
  }

  return rooms.map((room) => {
    const inRoom = byRoom.get(room._id.toString()) ?? [];

    return {
      beds: room.beds,
      floor: room.floor,
      free: Math.max(room.beds - inRoom.length, 0),
      id: room._id.toString(),
      number: room.number,
      residents: inRoom.map((resident) => ({
        id: resident._id.toString(),
        name: `${resident.firstName} ${resident.lastName}`.trim(),
      })),
      roomType: room.roomType,
    };
  });
}

/**
 * The per-type counts a floor plan implies. Once any room is laid out the plan
 * is the only truth: a type with no numbered rooms counts zero, so "Not
 * floor-wise", the listing and the floor plan all show the same hostel. Free
 * beds are counted per type — a resident not yet given a room still holds a
 * bed of their type.
 */
export function deriveTypeCounts(
  configurations: RoomConfiguration[],
  rooms: Pick<RoomRow, "beds" | "roomType">[],
  residents: Pick<LiveResident, "roomType">[],
): RoomConfiguration[] {
  return configurations.map((config) => {
    const ofType = rooms.filter((room) => room.roomType === config.roomType);
    const beds = ofType.reduce((sum, room) => sum + room.beds, 0);
    const living = residents.filter((resident) => resident.roomType === config.roomType).length;

    return {
      ...config,
      bedsPerRoom: ofType.length ? Math.max(1, Math.round(beds / ofType.length)) : config.bedsPerRoom,
      rooms: ofType.length,
      vacantBeds: Math.max(beds - living, 0),
    };
  });
}

const sameCounts = (a: RoomConfiguration[], b: RoomConfiguration[]) =>
  a.every((config, at) => config.rooms === b[at]?.rooms && config.vacantBeds === b[at]?.vacantBeds && config.bedsPerRoom === b[at]?.bedsPerRoom);

/** The floor plan, who is where, and who still has no room. */
export async function getRoomLayout(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const id = oid(hostelId);
  const [rooms, residents, tracking, hostel, pending] = await Promise.all([
    loadRooms(id),
    loadLiveResidents(id),
    isRoomTracking(id),
    HostelModel.findById(id).select("roomConfigurations").lean<{ roomConfigurations?: RoomConfiguration[] } | null>(),
    RoomChangeRequestModel.countDocuments({ hostelId: id, status: "PENDING" }),
  ]);
  const roomIds = new Set(rooms.map((room) => room._id.toString()));
  const configurations = hostel?.roomConfigurations ?? [];
  const planned = tracking && rooms.length > 0;
  const derived = planned ? deriveTypeCounts(configurations, rooms, residents) : configurations;

  // Hostels whose counts were typed before the plan became the truth heal the
  // first time their rooms are opened; afterwards every change keeps them equal.
  if (planned && !sameCounts(derived, configurations)) await writeConfigurations(id, derived);

  const summary = summarizeConfigurations(derived);

  return {
    pendingRequests: pending,
    rooms: viewRooms(rooms, residents),
    roomTypes: configurations.map((config) => config.roomType),
    // One set of totals for both views (field review A1).
    totals: tracking
      ? { beds: rooms.reduce((sum, room) => sum + room.beds, 0), free: planned ? summary.vacantBeds : 0, rooms: rooms.length }
      : { beds: summary.totalBeds, free: summary.vacantBeds, rooms: summary.totalRooms },
    tracking,
    // A room that was deleted under them counts as no room.
    unassigned: residents
      .filter((resident) => !resident.roomId || !roomIds.has(resident.roomId.toString()))
      .map((resident) => ({
        id: resident._id.toString(),
        name: `${resident.firstName} ${resident.lastName}`.trim(),
        roomType: resident.roomType,
      })),
  };
}

/**
 * Re-derives the listing's per-type counts from the floor plan. A hostel with
 * no rooms laid out keeps what was typed — switching floor-wise on must not
 * empty its listing before the first floor exists.
 */
async function syncTypeCounts(hostelId: Types.ObjectId) {
  const [rooms, residents, hostel] = await Promise.all([
    loadRooms(hostelId),
    loadLiveResidents(hostelId),
    HostelModel.findById(hostelId).select("roomConfigurations").lean<{ roomConfigurations?: RoomConfiguration[] } | null>(),
  ]);

  if (!hostel || rooms.length === 0) return;

  await writeConfigurations(hostelId, deriveTypeCounts(hostel.roomConfigurations ?? [], rooms, residents));
}

async function assertRoomType(hostelId: Types.ObjectId, roomType: string) {
  const hostel = await HostelModel.findById(hostelId)
    .select("roomConfigurations.roomType")
    .lean<{ roomConfigurations?: { roomType: string }[] } | null>();

  if (!hostel?.roomConfigurations?.some((config) => config.roomType === roomType)) {
    throw new RoomError(`"${roomType}" is not one of this hostel's room types. Add it under room types first.`, "ROOM_TYPE_UNKNOWN", 422);
  }
}

/** A floor's rooms in one go: "101–105, Double, 2 beds". */
export async function addRooms(
  hostelId: Types.ObjectId | string,
  input: z.infer<typeof addRoomsSchema>,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const id = oid(hostelId);
  const numbers = [...new Set(input.numbers.map((number) => number.trim()))];

  await assertRoomType(id, input.roomType);

  const taken = await HostelRoomModel.find({ hostelId: id, isDeleted: false, number: { $in: numbers } })
    .select("number")
    .lean<{ number: string }[]>();

  if (taken.length > 0) {
    throw new RoomError(
      `Room ${taken.map((room) => room.number).join(", ")} already exists.`,
      "ROOM_NUMBER_TAKEN",
      409,
    );
  }

  await HostelRoomModel.insertMany(
    numbers.map((number) => ({
      beds: input.beds,
      createdBy: principal.userId,
      floor: input.floor,
      hostelId: id,
      number,
      roomType: input.roomType,
    })),
  );
  await syncTypeCounts(id);

  return getRoomLayout(id);
}

async function residentsIn(roomId: Types.ObjectId) {
  return ResidentModel.countDocuments({ isDeleted: { $ne: true }, roomId, status: { $in: LIVE } });
}

export async function updateRoom(
  hostelId: Types.ObjectId | string,
  roomId: string,
  input: z.infer<typeof updateRoomSchema>,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const id = oid(hostelId);
  const room = await HostelRoomModel.findOne({ _id: oid(roomId), hostelId: id, isDeleted: false }).lean<RoomRow | null>();

  if (!room) throw new RoomError("Room was not found.", "ROOM_NOT_FOUND", 404);

  const living = await residentsIn(room._id);

  if (input.beds !== undefined && input.beds < living) {
    throw new RoomError(`${living} people live in Room ${room.number}. It needs at least ${living} beds.`, "ROOM_TOO_SMALL", 409);
  }

  if (input.roomType && input.roomType !== room.roomType) {
    if (living > 0) {
      throw new RoomError(`Move the ${living} people out of Room ${room.number} before changing its type — their rent follows the type.`, "ROOM_OCCUPIED", 409);
    }

    await assertRoomType(id, input.roomType);
  }

  if (input.number && input.number !== room.number) {
    const clash = await HostelRoomModel.exists({ _id: { $ne: room._id }, hostelId: id, isDeleted: false, number: input.number });

    if (clash) throw new RoomError(`Room ${input.number} already exists.`, "ROOM_NUMBER_TAKEN", 409);
  }

  const changes = { beds: input.beds, floor: input.floor, number: input.number, roomType: input.roomType };

  await HostelRoomModel.updateOne(
    { _id: room._id },
    { $set: { ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)), updatedBy: principal.userId } },
  );

  // The number and floor are copied onto residents so lists need no join.
  if (input.number || input.floor !== undefined) {
    await ResidentModel.updateMany(
      { roomId: room._id },
      { $set: { floor: input.floor ?? room.floor, roomNumber: input.number ?? room.number } },
    );
  }

  await syncTypeCounts(id);

  return getRoomLayout(id);
}

export async function deleteRoom(hostelId: Types.ObjectId | string, roomId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const id = oid(hostelId);
  const room = await HostelRoomModel.findOne({ _id: oid(roomId), hostelId: id, isDeleted: false }).lean<RoomRow | null>();

  if (!room) throw new RoomError("Room was not found.", "ROOM_NOT_FOUND", 404);

  const living = await residentsIn(room._id);

  if (living > 0) {
    throw new RoomError(`${living} people live in Room ${room.number}. Move them first.`, "ROOM_OCCUPIED", 409);
  }

  await HostelRoomModel.updateOne({ _id: room._id }, { $set: { isDeleted: true, updatedBy: principal.userId } });
  await RoomChangeRequestModel.updateMany({ status: "PENDING", toRoomId: room._id }, { $set: { status: "CANCELLED" } });
  await syncTypeCounts(id);

  return getRoomLayout(id);
}

export async function setRoomTracking(hostelId: Types.ObjectId | string, enabled: boolean, principal: ApiPrincipal) {
  await connectToDatabase();

  await HostelSettingsModel.updateOne(
    { hostelId: oid(hostelId) },
    { $set: { roomTracking: enabled, updatedBy: principal.userId }, $setOnInsert: { createdBy: principal.userId } },
    { upsert: true },
  );
  // Either way the type counts start from the plan, so the totals do not jump.
  await syncTypeCounts(oid(hostelId));

  return getRoomLayout(hostelId);
}

/**
 * The room a resident is being put in, checked: this hostel's, and a free bed.
 * `ignoreResidentId` is the resident being moved, who must not count against
 * their own new room. Returns null when no room was asked for.
 */
export async function resolveRoom(
  hostelId: Types.ObjectId | string,
  roomId: string | null | undefined,
  ignoreResidentId?: Types.ObjectId | string,
) {
  if (!roomId) return null;

  const room = await HostelRoomModel.findOne({ _id: oid(roomId), hostelId: oid(hostelId), isDeleted: false })
    .select("beds floor number roomType")
    .lean<RoomRow | null>();

  if (!room) throw new RoomError("That room is not in this hostel.", "ROOM_NOT_FOUND", 404);

  const living = await ResidentModel.countDocuments({
    ...(ignoreResidentId ? { _id: { $ne: oid(ignoreResidentId) } } : {}),
    isDeleted: { $ne: true },
    roomId: room._id,
    status: { $in: LIVE },
  });

  if (living >= room.beds) {
    throw new RoomError(`Room ${room.number} is full.`, "ROOM_FULL", 409);
  }

  return room;
}

/**
 * Puts a resident in a room — the one move both a warden's change and an
 * approved request make. A different room type moves the bed between types
 * (and their rent follows the type from the next bill).
 */
export async function moveResidentToRoom(
  hostelId: Types.ObjectId | string,
  residentId: Types.ObjectId | string,
  roomId: string,
  principal: ApiPrincipal,
) {
  const id = oid(hostelId);
  const resident = await ResidentModel.findOne({ _id: oid(residentId), hostelId: id, isDeleted: { $ne: true }, status: { $in: LIVE } })
    .select("roomType roomId")
    .lean<{ _id: Types.ObjectId; roomId?: Types.ObjectId | null; roomType: string } | null>();

  if (!resident) throw new RoomError("Resident was not found.", "RESIDENT_NOT_FOUND", 404);

  const room = await resolveRoom(id, roomId, resident._id);

  if (!room) throw new RoomError("Pick a room.", "ROOM_REQUIRED", 422);

  if (room.roomType !== resident.roomType) {
    await moveBedBetweenRoomTypes(id, resident.roomType, room.roomType).catch((error: unknown) => {
      if (error instanceof CapacityError) {
        throw new RoomError(`No free ${room.roomType} bed is counted for this hostel.`, "ROOM_FULL", 409);
      }
      throw error;
    });
  }

  await ResidentModel.updateOne(
    { _id: resident._id },
    { $set: { floor: room.floor, roomId: room._id, roomNumber: room.number, roomType: room.roomType, updatedBy: principal.userId } },
  );
  // Whatever they had asked for is answered by the move.
  await RoomChangeRequestModel.updateMany(
    { residentId: resident._id, status: "PENDING", toRoomId: { $ne: room._id } },
    { $set: { status: "CANCELLED" } },
  );

  if (room.roomType !== resident.roomType) {
    await syncTypeCounts(id);
  }

  return room;
}

/* -------------------------------------------------------------------------- */
/* Room change requests (§3.8)                                                */
/* -------------------------------------------------------------------------- */

async function ownResident(principal: ApiPrincipal) {
  const resident = await ResidentModel.findOne({
    hostelId: { $in: principal.hostelIds.filter((id) => Types.ObjectId.isValid(id)).map(oid) },
    isDeleted: { $ne: true },
    status: "ACTIVE",
    userId: oid(principal.userId),
  })
    .select("firstName lastName hostelId roomId roomNumber floor roomType")
    .lean<{
      _id: Types.ObjectId;
      firstName: string;
      floor?: number | null;
      hostelId: Types.ObjectId;
      lastName: string;
      roomId?: Types.ObjectId | null;
      roomNumber?: string | null;
      roomType: string;
    } | null>();

  if (!resident) throw new RoomError("You are not living in a hostel right now.", "RESIDENT_NOT_FOUND", 404);

  return resident;
}

/** The resident's view: where they are, where a bed is free, and their open request. */
export async function getMyRoomOptions(principal: ApiPrincipal) {
  await connectToDatabase();

  const me = await ownResident(principal);
  const [rooms, residents, request, tracking] = await Promise.all([
    loadRooms(me.hostelId),
    loadLiveResidents(me.hostelId),
    RoomChangeRequestModel.findOne({ residentId: me._id, status: { $in: ["PENDING", "DECLINED"] } })
      .sort({ createdAt: -1 })
      .lean<{ _id: Types.ObjectId; createdAt: Date; declineReason?: string; status: string; toRoomId: Types.ObjectId } | null>(),
    isRoomTracking(me.hostelId),
  ]);
  const views = viewRooms(rooms, residents);
  const target = request ? views.find((room) => room.id === request.toRoomId.toString()) : null;

  return {
    current: me.roomId
      ? { floor: me.floor ?? null, number: me.roomNumber ?? null, roomType: me.roomType }
      : null,
    // Other residents' names are not the asker's business: only counts go out.
    freeRooms: views
      .filter((room) => room.free > 0 && room.id !== me.roomId?.toString())
      .map((room) => ({ beds: room.beds, floor: room.floor, free: room.free, id: room.id, number: room.number, roomType: room.roomType })),
    request: request
      ? {
          createdAt: request.createdAt,
          declineReason: request.declineReason ?? null,
          id: request._id.toString(),
          status: request.status,
          to: target ? { floor: target.floor, number: target.number, roomType: target.roomType } : null,
        }
      : null,
    tracking,
  };
}

export async function askRoomChange(principal: ApiPrincipal, input: z.infer<typeof roomChangeAskSchema>) {
  await connectToDatabase();

  const me = await ownResident(principal);

  if (!(await isRoomTracking(me.hostelId))) {
    throw new RoomError("Your hostel does not keep residents by room number.", "ROOM_TRACKING_OFF", 409);
  }

  if (me.roomId?.toString() === input.toRoomId) {
    throw new RoomError("You are already in that room.", "SAME_ROOM", 409);
  }

  const room = await resolveRoom(me.hostelId, input.toRoomId, me._id);

  if (!room) throw new RoomError("Pick a room.", "ROOM_REQUIRED", 422);

  // One open request at a time: a new pick replaces the old one.
  await RoomChangeRequestModel.updateMany({ residentId: me._id, status: { $in: ["PENDING", "DECLINED"] } }, { $set: { status: "CANCELLED" } });
  await RoomChangeRequestModel.create({
    fromRoomId: me.roomId ?? null,
    hostelId: me.hostelId,
    note: input.note,
    requestedBy: principal.userId,
    residentId: me._id,
    toRoomId: room._id,
  });

  const name = `${me.firstName} ${me.lastName}`.trim();
  const staff = await resolveHostelStaffUserIds(me.hostelId);

  await Promise.all(
    staff.map((userId) =>
      createInAppNotification({
        actionUrl: "/hostel-admin/rooms",
        body: `${name} asks to move to Room ${room.number} (${room.roomType}, ${floorLabel(room.floor)}).${input.note ? ` “${input.note}”` : ""}`,
        category: "ROOM",
        data: { type: "ROOM_CHANGE_REQUEST" },
        hostelId: me.hostelId.toString(),
        title: "Room change request",
        userId,
      }).catch(() => null),
    ),
  );

  return getMyRoomOptions(principal);
}

export async function cancelRoomChange(principal: ApiPrincipal) {
  await connectToDatabase();

  const me = await ownResident(principal);

  await RoomChangeRequestModel.updateMany({ residentId: me._id, status: { $in: ["PENDING", "DECLINED"] } }, { $set: { status: "CANCELLED" } });

  return getMyRoomOptions(principal);
}

/** Staff's queue: who wants which bed. */
export async function listRoomChangeRequests(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const id = oid(hostelId);
  const requests = await RoomChangeRequestModel.find({ hostelId: id, status: "PENDING" })
    .sort({ createdAt: 1 })
    .lean<{ _id: Types.ObjectId; createdAt: Date; fromRoomId?: Types.ObjectId | null; note?: string; residentId: Types.ObjectId; toRoomId: Types.ObjectId }[]>();
  const [rooms, residents] = await Promise.all([loadRooms(id), loadLiveResidents(id)]);
  const views = new Map(viewRooms(rooms, residents).map((room) => [room.id, room]));
  const people = new Map(residents.map((resident) => [resident._id.toString(), resident]));
  const where = (roomId?: Types.ObjectId | null) => {
    const room = roomId ? views.get(roomId.toString()) : undefined;

    return room ? { floor: room.floor, free: room.free, number: room.number, roomType: room.roomType } : null;
  };

  return requests.flatMap((request) => {
    const resident = people.get(request.residentId.toString());

    return resident
      ? [
          {
            createdAt: request.createdAt,
            from: where(request.fromRoomId),
            id: request._id.toString(),
            note: request.note ?? null,
            resident: { id: resident._id.toString(), name: `${resident.firstName} ${resident.lastName}`.trim() },
            to: where(request.toRoomId),
          },
        ]
      : [];
  });
}

export async function answerRoomChange(
  hostelId: Types.ObjectId | string,
  requestId: string,
  input: z.infer<typeof roomChangeAnswerSchema>,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const id = oid(hostelId);
  const request = await RoomChangeRequestModel.findOne({ _id: oid(requestId), hostelId: id, status: "PENDING" })
    .lean<{ _id: Types.ObjectId; residentId: Types.ObjectId; toRoomId: Types.ObjectId } | null>();

  if (!request) throw new RoomError("That request was already answered.", "REQUEST_CLOSED", 409);

  const approve = input.action === "approve";
  const room = approve ? await moveResidentToRoom(id, request.residentId, request.toRoomId.toString(), principal) : null;

  await RoomChangeRequestModel.updateOne(
    { _id: request._id },
    {
      $set: {
        decidedAt: new Date(),
        decidedBy: principal.userId,
        declineReason: approve ? undefined : input.reason,
        status: approve ? "APPROVED" : "DECLINED",
      },
    },
  );

  const resident = await ResidentModel.findById(request.residentId).select("userId").lean<{ userId?: Types.ObjectId } | null>();

  if (resident?.userId) {
    await createInAppNotification({
      body: room
        ? `You are now in Room ${room.number}, ${floorLabel(room.floor)}.`
        : `Your room change was not approved.${input.reason ? ` ${input.reason}` : ""}`,
      category: "ROOM",
      data: { type: "ROOM_CHANGE_ANSWERED" },
      hostelId: id.toString(),
      title: room ? "Room change confirmed" : "Room change declined",
      userId: resident.userId.toString(),
    }).catch(() => null);
  }

  return listRoomChangeRequests(id);
}
