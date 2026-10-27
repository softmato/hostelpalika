import { REALTIME_TOPIC } from "@/constants/topics";
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import { defineQuery, type Query } from "@/lib/query-cache";

/**
 * Floors and numbered rooms (docs/FIELD_FIXES_2026_10.md §3): the hostel's
 * floor plan, who is in each room, room change requests, and the resident's
 * own "My room".
 */

export type Room = {
  beds: number;
  floor: number;
  free: number;
  id: string;
  number: string;
  residents: { id: string; name: string }[];
  roomType: string;
};

export type RoomLayout = {
  pendingRequests: number;
  rooms: Room[];
  roomTypes: string[];
  /** Same figures in both modes — the server derives them once. Absent before that deploy. */
  totals?: { beds: number; free: number; rooms: number };
  tracking: boolean;
  unassigned: { id: string; name: string; roomType: string }[];
};

export type RoomPlace = { floor: number; free?: number; number: string; roomType: string };

export type RoomRequest = {
  createdAt: string;
  from: RoomPlace | null;
  id: string;
  note: string | null;
  resident: { id: string; name: string };
  to: RoomPlace | null;
};

export type MyRoom = {
  current: { floor: number | null; number: string | null; roomType: string } | null;
  freeRooms: Omit<Room, "residents">[];
  request: {
    createdAt: string;
    declineReason: string | null;
    id: string;
    status: "PENDING" | "DECLINED";
    to: RoomPlace | null;
  } | null;
  tracking: boolean;
};

/** "Ground floor", "1st floor", "Basement" — the server's wording. */
export function floorLabel(floor: number) {
  if (floor === 0) return "Ground floor";
  if (floor < 0) return floor === -1 ? "Basement" : `Basement ${-floor}`;

  const tens = floor % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[floor % 10] ?? "th";

  return `${floor}${suffix} floor`;
}

/** "Room 204 · 2nd floor", or null when they have no room. */
export function roomLine(room: { floor?: number | null; number?: string | null } | null | undefined) {
  if (!room?.number) return null;

  return room.floor === null || room.floor === undefined
    ? `Room ${room.number}`
    : `Room ${room.number} · ${floorLabel(room.floor)}`;
}

/** Rooms grouped by floor, lowest first. */
export function byFloor<T extends { floor: number }>(rooms: T[]): { floor: number; rooms: T[] }[] {
  const floors = new Map<number, T[]>();

  for (const room of rooms) floors.set(room.floor, [...(floors.get(room.floor) ?? []), room]);

  return [...floors.entries()].sort(([a], [b]) => a - b).map(([floor, list]) => ({ floor, rooms: list }));
}

/**
 * "101" + 5 → 101…105. A number with letters keeps them: "A1" + 3 → A1, A2, A3.
 * Anything it cannot count from is returned alone.
 */
export function roomNumbers(first: string, count: number): string[] {
  const match = /^(.*?)(\d+)$/.exec(first.trim());

  if (!match || count <= 1) return first.trim() ? [first.trim()] : [];

  const [, prefix, digits] = match;
  const start = Number(digits);

  return Array.from({ length: Math.min(count, 100) }, (_, index) =>
    `${prefix}${String(start + index).padStart(digits.length, "0")}`,
  );
}

export async function getRoomLayout() {
  return unwrap(await api.get<ApiEnvelope<RoomLayout>>("/hostel-admin/rooms"));
}

export async function addRooms(input: { beds: number; floor: number; numbers: string[]; roomType: string }) {
  return unwrap(await api.post<ApiEnvelope<RoomLayout>>("/hostel-admin/rooms", input));
}

export async function updateRoom(
  id: string,
  input: { beds?: number; floor?: number; number?: string; roomType?: string },
) {
  return unwrap(await api.patch<ApiEnvelope<RoomLayout>>(`/hostel-admin/rooms/${id}`, input));
}

export async function deleteRoom(id: string) {
  return unwrap(await api.delete<ApiEnvelope<RoomLayout>>(`/hostel-admin/rooms/${id}`));
}

export async function setRoomTracking(enabled: boolean) {
  return unwrap(await api.put<ApiEnvelope<RoomLayout>>("/hostel-admin/rooms/tracking", { enabled }));
}

export async function listRoomRequests() {
  return unwrap(await api.get<ApiEnvelope<{ requests: RoomRequest[] }>>("/hostel-admin/rooms/requests"));
}

export async function answerRoomRequest(id: string, action: "approve" | "decline", reason?: string) {
  return unwrap(
    await api.post<ApiEnvelope<{ requests: RoomRequest[] }>>(`/hostel-admin/rooms/requests/${id}`, {
      action,
      reason,
    }),
  );
}

/** Staff put a resident in a room directly. */
export async function setResidentRoom(residentId: string, roomId: string) {
  return unwrap(
    await api.put<ApiEnvelope<{ room: RoomPlace & { id: string } }>>(`/hostel-admin/residents/${residentId}/room`, {
      roomId,
    }),
  );
}

export async function getMyRoom() {
  return unwrap(await api.get<ApiEnvelope<MyRoom>>("/resident/room"));
}

export async function askRoomChange(toRoomId: string, note?: string) {
  return unwrap(await api.post<ApiEnvelope<MyRoom>>("/resident/room", { note, toRoomId }));
}

export async function cancelRoomChange() {
  return unwrap(await api.delete<ApiEnvelope<MyRoom>>("/resident/room"));
}

export const roomsQuery = {
  layout: (): Query<RoomLayout> => defineQuery("admin:rooms", [REALTIME_TOPIC.ROOMS, REALTIME_TOPIC.RESIDENTS], getRoomLayout),
  mine: (): Query<MyRoom> => defineQuery("resident:room", [REALTIME_TOPIC.ROOMS], getMyRoom),
  requests: (): Query<{ requests: RoomRequest[] }> =>
    defineQuery("admin:room-requests", [REALTIME_TOPIC.ROOMS], listRoomRequests),
} as const;
