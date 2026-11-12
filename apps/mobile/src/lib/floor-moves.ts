import type { Room } from "@/lib/rooms-api";

export type FloorLeaver = { person: Room["residents"][number]; room: Room };

/** Everyone living on `floor`, with the room they leave. */
export function floorLeavers(rooms: Room[], floor: number): FloorLeaver[] {
  return rooms.filter((room) => room.floor === floor).flatMap((room) => room.residents.map((person) => ({ person, room })));
}

/**
 * First guess for emptying a floor, same as the web dialog: each resident goes to the
 * first room of their own type on another floor that still has a bed after the ones before.
 * Residents with no such bed stay unplaced.
 */
export function firstFloorMoves(rooms: Room[], floor: number): Record<string, string> {
  const targets = rooms.filter((room) => room.floor !== floor);
  const left = new Map(targets.map((room) => [room.id, room.free]));
  const picks: Record<string, string> = {};
  for (const { person, room } of floorLeavers(rooms, floor)) {
    const target = targets.find((item) => item.roomType === room.roomType && (left.get(item.id) ?? 0) > 0);
    if (!target) continue;
    picks[person.id] = target.id;
    left.set(target.id, (left.get(target.id) ?? 0) - 1);
  }
  return picks;
}

/** Beds in `roomId` other residents (not `except`) already picked. */
export function bedsClaimed(picks: Record<string, string>, roomId: string, except: string) {
  return Object.entries(picks).filter(([id, picked]) => picked === roomId && id !== except).length;
}
