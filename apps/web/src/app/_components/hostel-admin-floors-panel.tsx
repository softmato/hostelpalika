"use client";

import { bedsForRoomType, roomTypeLabel } from "@hostel/shared/constants/room-types";
import { Building2, Loader2, Plus, Trash2 } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { formatMoney } from "@/app/_components/shared";
import { Glyph, type GlyphName } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useResidents } from "@/hooks/use-hostel-admin";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

import type { RoomConfiguration } from "./core-portal-shared";

/**
 * Rooms & floors — the design the owner signed off (2026-10-22), same as the
 * app's. Floor-wise: each floor's room count is a stepper, rooms are tiles,
 * and a type in the side rail paints them — click a tile to paint it,
 * shift- or ctrl-click to select several for bulk actions. Not floor-wise: a
 * room count per type. Every change saves at once.
 *
 * Same endpoints as the app's Rooms. Also embedded in Hostel KYC.
 */

type Room = {
  beds: number;
  floor: number;
  free: number;
  id: string;
  number: string;
  residents: { due?: number; id: string; name: string; photo?: string | null; since?: string | null }[];
  roomType: string;
};

type Layout = {
  pendingRequests: number;
  rooms: Room[];
  roomTypes: string[];
  tracking: boolean;
  unassigned: { id: string; name: string; roomType: string }[];
};

type Place = { floor: number; free?: number; number: string; roomType: string } | null;

type Request = { from: Place; id: string; note: string | null; resident: { id: string; name: string }; to: Place };

const BASE = "/api/v1/hostel-admin/rooms";

export function floorName(floor: number) {
  if (floor === 0) return "Ground floor";
  if (floor < 0) return floor === -1 ? "Basement" : `Basement ${-floor}`;
  const tens = floor % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[floor % 10] ?? "th";
  return `${floor}${suffix} floor`;
}

function place(value: Place) {
  return value ? `Room ${value.number} · ${floorName(value.floor)}` : "No room";
}

const byNumber = (a: Room, b: Room) => a.number.localeCompare(b.number, undefined, { numeric: true });

/** The next free room numbers on a floor: 001… on the ground, 101… on the 1st, B101… below. */
export function nextRoomNumbers(floor: number, taken: string[], count: number) {
  const used = new Set(taken);
  const numbers: string[] = [];

  for (let n = 1; numbers.length < count && n < 1000; n += 1) {
    const label = floor < 0 ? `B${-floor}${String(n).padStart(2, "0")}` : String(floor * 100 + n).padStart(3, "0");
    if (!used.has(label)) numbers.push(label);
  }

  return numbers;
}

/** "101" + 3 → 101, 102, 103, keeping any letters and the zero padding. */
function renumber(first: string, count: number) {
  const match = /^(.*?)(\d+)$/.exec(first.trim());
  if (!match) return Array.from({ length: count }, (_, at) => `${first.trim()}${at + 1}`);
  const [, prefix, digits] = match;
  return Array.from({ length: count }, (_, at) => `${prefix}${String(Number(digits) + at).padStart(digits.length, "0")}`);
}

const INPUT = "h-10 w-full rounded-xl border border-border bg-background px-3 text-[13.5px] outline-none focus:border-brand-teal";
/** Every control in the selection bar: one height, one radius. */
const BAR_CONTROL = "h-9 !rounded-[0.45rem]";
const LABEL ="grid gap-1 text-[11px] font-semibold text-muted-foreground";

const beds = (roomType: string) => {
  const count = bedsForRoomType(roomType);
  return `${count} ${count === 1 ? "bed" : "beds"}`;
};

/** A dark-green hand with a white rim, so the cursor shows on white tiles as well as on green. */
const hand = (grabbing: boolean) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24'><path d='${
      grabbing
        ? "M6 11V9a1.5 1.5 0 0 1 3 0V8a1.5 1.5 0 0 1 3 0v.5a1.5 1.5 0 0 1 3 0V10a1.5 1.5 0 0 1 3 0v4.5c0 3-2 5.5-5.5 5.5S7 18 6 15.5z"
        : "M8 13V5.5a1.5 1.5 0 0 1 3 0V11h.5V4a1.5 1.5 0 0 1 3 0v7h.5V5.5a1.5 1.5 0 0 1 3 0V14c0 3.5-2.5 6-6 6-2.5 0-4-1.2-5-3.2L4.5 13.5a1.5 1.5 0 0 1 2.4-1.7z"
    }' fill='#064e2b' stroke='white' stroke-width='1.6' stroke-linejoin='round'/></svg>`,
  )}") 14 14, ${grabbing ? "grabbing" : "grab"}`;

const TIP_DELAY = 500;
const TIP_WIDTH = 256;

function Initial({ name, photo, size = "size-9" }: { name: string; photo?: string | null; size?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-teal/10 text-[12px] font-bold text-brand-teal", size)}>
      {photo && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- small resident avatar
        <img alt="" className="size-full object-cover" onError={() => setFailed(true)} referrerPolicy="no-referrer" src={photo} />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}

/** The beds of a room as marks: taken ones muted, free ones green. */
function BedMarks({ room }: { room: Room }) {
  const taken = room.beds - room.free;
  return (
    <span className="flex flex-wrap gap-1.5">
      {Array.from({ length: room.beds }, (_, at) => (
        <span className={cn("flex size-8 items-center justify-center rounded-lg", at < taken ? "bg-muted text-muted-foreground" : "bg-brand-teal/10 text-brand-teal")} key={at}>
          <Glyph className="size-4" name="bed" variant={at < taken ? "solid" : "line"} />
        </span>
      ))}
    </span>
  );
}

/** Minimal read-only peek at a room, shown beside its tile after the pointer rests on it. */
function RoomTip({ open, rect, room }: { open: boolean; rect: DOMRect; room: Room }) {
  const right = rect.right + 10 + TIP_WIDTH <= window.innerWidth;
  const left = right ? rect.right + 10 : Math.max(8, rect.left - 10 - TIP_WIDTH);
  const top = Math.min(Math.max(8, rect.top + rect.height / 2 - 80), window.innerHeight - 300);
  const free = room.free > 0 ? `${room.free} of ${room.beds} free` : "Full";
  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed z-50 grid gap-2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg transition duration-150",
        open ? "translate-x-0 opacity-100 ease-out" : cn("opacity-0 ease-in", right ? "-translate-x-1" : "translate-x-1"),
      )}
      style={{ left, top, width: TIP_WIDTH }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-heading text-[15px] font-bold leading-tight">Room {room.number}</p>
          <p className="truncate text-[12px] text-muted-foreground">{roomTypeLabel(room.roomType)}</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">{floorName(room.floor)}</span>
      </div>
      <div className="grid gap-1.5 border-t border-border pt-2.5">
        <BedMarks room={room} />
        <p className={cn("text-[12px] font-semibold", room.free > 0 ? "text-brand-teal" : "text-destructive")}>{free}</p>
      </div>
      {room.residents.length ? (
        <ul className="grid gap-1.5 border-t border-border pt-2.5">
          {room.residents.slice(0, 4).map((person) => (
            <li className="flex items-center gap-2 text-[12.5px] font-medium" key={person.id}>
              <Initial name={person.name} photo={person.photo} size="size-6" />
              <span className="min-w-0 flex-1 truncate">{person.name}</span>
              {person.due ? <span className="shrink-0 text-[11px] font-semibold text-warning">{formatMoney(person.due)}</span> : null}
            </li>
          ))}
          {room.residents.length > 4 ? <li className="text-[11.5px] text-muted-foreground">+{room.residents.length - 4} more</li> : null}
        </ul>
      ) : (
        <p className="border-t border-border pt-2.5 text-[12px] text-muted-foreground">Nobody lives here yet.</p>
      )}
    </div>,
    document.body,
  );
}

/** − n +, saving once the count settles. */
function Stepper({ disabled, label, onChange, value }: { disabled?: boolean; label: string; onChange: (next: number) => void; value: number }) {
  return (
    <div className="inline-flex h-9 items-center rounded-xl border border-border bg-card">
      <button aria-label={`Fewer ${label}`} className="flex h-full w-9 items-center justify-center disabled:opacity-30" disabled={disabled || value <= 0} onClick={() => onChange(value - 1)} type="button">
        <Glyph className="size-4" name="remove" />
      </button>
      <input
        aria-label={label}
        className="h-full w-10 border-x border-border bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
        disabled={disabled}
        inputMode="numeric"
        onChange={(event) => onChange(Math.min(999, Number(event.target.value.replace(/\D/g, "")) || 0))}
        value={value}
      />
      <button aria-label={`More ${label}`} className="flex h-full w-9 items-center justify-center disabled:opacity-30" disabled={disabled} onClick={() => onChange(value + 1)} type="button">
        <Glyph className="size-4" name="add" />
      </button>
    </div>
  );
}

/** A count that waits for the clicks to stop, then `apply`s once. */
function useSettled<K extends string | number>(apply: (key: K, value: number) => void) {
  const [targets, setTargets] = useState<Partial<Record<K, number>>>({});
  const latest = useRef(apply);
  useEffect(() => {
    latest.current = apply;
  });
  useEffect(() => {
    const entries = Object.entries(targets) as [K, number][];
    if (!entries.length) return;
    const timer = setTimeout(() => {
      setTargets({});
      for (const [key, value] of entries) latest.current(key, value);
    }, 600);
    return () => clearTimeout(timer);
  }, [targets]);

  return [targets, (key: K, value: number) => setTargets((current) => ({ ...current, [key]: value }))] as const;
}

export function FloorsPanel() {
  const layout = usePortalResource<Layout>(BASE);
  const requests = usePortalResource<{ requests: Request[] }>(`${BASE}/requests`);
  const profile = usePortalResource<{ hostel: { roomConfigurations: RoomConfiguration[] } }>(hostelAdminEndpoints.profile);
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [paint, setPaint] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [editing, setEditing] = useState<Room | null>(null);
  const [bulkType, setBulkType] = useState("");
  const [bulkFirst, setBulkFirst] = useState("");
  const [tip, setTip] = useState<{ open: boolean; rect: DOMRect; roomId: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [pendingOrder, setPendingOrder] = useState<{ floor: number; ids: string[] } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Only the timers run while the pointer travels across tiles; state changes once it rests.
  const peek = (roomId: string, target: HTMLElement) => {
    clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => {
      const rect = target.getBoundingClientRect();
      setTip({ open: false, rect, roomId });
      requestAnimationFrame(() => requestAnimationFrame(() => setTip((current) => (current ? { ...current, open: true } : current))));
    }, TIP_DELAY);
  };
  const unpeek = () => {
    clearTimeout(tipTimer.current);
    setTip((current) => (current?.open ? { ...current, open: false } : null));
    tipTimer.current = setTimeout(() => setTip(null), 160);
  };
  useEffect(() => () => clearTimeout(tipTimer.current), []);

  // Faces come from the Residents tab's cached roster (same account picture it draws), not a new lookup per room.
  const roster = useResidents();
  const faces = useMemo(() => {
    const map = new Map<string, string>();
    for (const resident of roster.data?.residents ?? []) if (resident.account?.image) map.set(resident.id, resident.account.image);
    return map;
  }, [roster.data]);
  const roomRows = layout.data?.rooms;
  const rooms = useMemo(
    () => (roomRows ?? []).map((room) => ({ ...room, residents: room.residents.map((person) => ({ ...person, photo: faces.get(person.id) ?? person.photo })) })),
    [roomRows, faces],
  );

  /** `true` when the work went through, so a form knows to close. */
  const run = async (work: () => Promise<unknown>, done = "") => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(done);
      // Room counts per type follow the rooms, so the room types refresh too.
      invalidate(hostelAdminEndpoints.profile);
      await Promise.all([layout.refreshAsync(), requests.refreshAsync(), profile.refreshAsync()]);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
      await layout.refreshAsync();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const data = layout.data;
  const configs = profile.data?.hostel.roomConfigurations ?? [];
  const taken = rooms.map((room) => room.number);
  const types = data?.roomTypes ?? [];
  const typeFor = (onFloor: Room[]) =>
    paint ?? [...onFloor].sort((a, b) => onFloor.filter((room) => room.roomType === b.roomType).length - onFloor.filter((room) => room.roomType === a.roomType).length)[0]?.roomType ?? types[0];

  const [floorTargets, setFloorTarget] = useSettled<number>((key, target) => {
    // Object keys come back as strings; "0" never equals floor 0, which made every add look like a whole new floor.
    const floor = Number(key);
    const onFloor = rooms.filter((room) => room.floor === floor).sort(byNumber);
    void run(async () => {
      if (target > onFloor.length) {
        const roomType = typeFor(onFloor);
        await browserApi(BASE, {
          body: JSON.stringify({ beds: bedsForRoomType(roomType), floor, numbers: nextRoomNumbers(floor, taken, target - onFloor.length), roomType }),
          method: "POST",
        });
        return;
      }
      await Promise.all(onFloor.slice(target).map((room) => browserApi(`${BASE}/${room.id}`, { method: "DELETE" })));
    });
  });

  const [typeTargets, setTypeTarget] = useSettled<string>((roomType, count) => {
    void run(() =>
      browserApi(hostelAdminEndpoints.profile, {
        body: JSON.stringify({
          roomConfigurations: configs.map((config) => {
            if (config.roomType !== roomType) return config;
            const bedsPerRoom = bedsForRoomType(config.roomType);
            // Beds already taken stay taken; the rest are free.
            const used = Math.max(0, config.rooms * config.bedsPerRoom - config.vacantBeds);
            return { ...config, bedsPerRoom, rooms: count, vacantBeds: Math.max(0, count * bedsPerRoom - used) };
          }),
        }),
        method: "PATCH",
      }),
    );
  });

  if (!data) {
    return (
      <section className="rounded-2xl border border-border/70 bg-card p-4 text-[13.5px] text-muted-foreground">
        {layout.state === "error" ? "Rooms could not be loaded." : "Loading floors…"}
      </section>
    );
  }

  const floors = [...new Set(rooms.map((room) => room.floor))].sort((a, b) => a - b);
  const pending = requests.data?.requests ?? [];
  const totals = data.tracking
    ? { beds: rooms.reduce((sum, room) => sum + room.beds, 0), free: rooms.reduce((sum, room) => sum + room.free, 0), rooms: rooms.length }
    : {
        beds: configs.reduce((sum, config) => sum + config.rooms * bedsForRoomType(config.roomType), 0),
        free: configs.reduce((sum, config) => sum + config.vacantBeds, 0),
        rooms: configs.reduce((sum, config) => sum + config.rooms, 0),
      };
  const chosen = rooms.filter((room) => selected.includes(room.id)).sort(byNumber);

  const setMode = (floorWise: boolean) =>
    floorWise !== data.tracking && void run(() => browserApi(`${BASE}/tracking`, { body: JSON.stringify({ enabled: floorWise }), method: "PUT" }));

  const addFloor = () => {
    const above = floors.at(-1);
    const floor = above === undefined ? 0 : above + 1;
    // A new floor copies the one above it; the first starts with one room.
    const plan = above === undefined ? [paint ?? types[0]] : rooms.filter((room) => room.floor === above).sort(byNumber).map((room) => room.roomType);
    const numbers = nextRoomNumbers(floor, taken, plan.length);
    void run(async () => {
      for (const roomType of [...new Set(plan)]) {
        await browserApi(BASE, {
          body: JSON.stringify({ beds: bedsForRoomType(roomType), floor, numbers: numbers.filter((_, at) => plan[at] === roomType), roomType }),
          method: "POST",
        });
      }
    }, `${floorName(floor)} added.`);
  };

  const retype = (list: Room[], roomType: string) =>
    run(async () => {
      for (const room of list.filter((item) => item.roomType !== roomType)) {
        await browserApi(`${BASE}/${room.id}`, { body: JSON.stringify({ beds: bedsForRoomType(roomType), roomType }), method: "PATCH" });
      }
    });

  const clickTile = (room: Room, event: React.MouseEvent) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || selected.length) {
      setSelected((current) => (current.includes(room.id) ? current.filter((id) => id !== room.id) : [...current, room.id]));
    } else if (paint) {
      void retype([room], paint);
    } else {
      setEditing(room);
    }
  };

  /** Moves the dragged room to where `target` sits and saves the floor's order. */
  const dropOn = (target: Room, onFloor: Room[]) => {
    const from = onFloor.find((room) => room.id === dragId);
    setDragId(null);
    setOverId(null);
    if (!from || from.id === target.id || from.floor !== target.floor) return;
    const ids = onFloor.map((room) => room.id).filter((id) => id !== from.id);
    ids.splice(onFloor.findIndex((room) => room.id === target.id), 0, from.id);
    setPendingOrder({ floor: target.floor, ids });
    void run(() => browserApi(`${BASE}/order`, { body: JSON.stringify({ floor: target.floor, ids }), method: "PUT" })).then(() => setPendingOrder(null));
  };

  const removeChosen = async () => {
    const ok = await confirm({ actionLabel: "Remove", description: "Only empty rooms can be removed.", title: `Remove ${chosen.length} ${chosen.length === 1 ? "room" : "rooms"}?`, tone: "destructive" });
    if (!ok) return;
    setRemoving(true);
    const done = await run(() => Promise.all(chosen.map((room) => browserApi(`${BASE}/${room.id}`, { method: "DELETE" }))), `${chosen.length} removed.`);
    setRemoving(false);
    if (done) setSelected([]);
  };

  const renumberChosen = () => {
    const numbers = renumber(bulkFirst || chosen[0]?.number || "", chosen.length);
    void run(async () => {
      // ponytail: two passes so 101↔102 swaps never clash; a failure midway can leave a "~" number to fix by hand.
      for (const room of chosen) await browserApi(`${BASE}/${room.id}`, { body: JSON.stringify({ number: `~${room.number}` }), method: "PATCH" });
      for (const [at, room] of chosen.entries()) await browserApi(`${BASE}/${room.id}`, { body: JSON.stringify({ number: numbers[at] }), method: "PATCH" });
    }, "Renumbered.").then((ok) => ok && setSelected([]));
  };

  return (
    <section className="space-y-4">
      {confirmDialog}

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-border bg-muted p-1">
          {([true, false] as const).map((floorWise) => (
            <button
              className={cn(
                "rounded-full px-4 py-1.5 text-[13px] font-semibold transition",
                data.tracking === floorWise ? "bg-brand-teal text-white" : "text-muted-foreground hover:text-foreground",
              )}
              disabled={busy}
              key={String(floorWise)}
              onClick={() => setMode(floorWise)}
              type="button"
            >
              {floorWise ? "Floor-wise" : "Not floor-wise"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-5">
          {([["business", "Rooms", totals.rooms], ["bed", "Beds", totals.beds], ["checkmark-circle", "Free", totals.free]] as [GlyphName, string, number][]).map(([icon, label, value]) => (
            <div className="flex items-center gap-2" key={label}>
              <Glyph className="size-4 text-brand-teal" name={icon} />
              <div className="leading-tight">
                <p className="text-[15px] font-bold tabular-nums text-foreground">{value}</p>
                <p className="text-[11px] text-muted-foreground">{label}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {message ? <p className="text-[13px] text-muted-foreground">{message}</p> : null}

      {pending.length > 0 ? (
        <div className="space-y-2 rounded-2xl border border-border/70 bg-card p-3">
          <p className="text-xs font-semibold text-muted-foreground">Room change requests · {pending.length}</p>
          {pending.map((request) => (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/50 p-3 text-[13.5px]" key={request.id}>
              <Glyph className="size-4 shrink-0 text-brand-teal" name="swap-horizontal" />
              <div className="mr-auto min-w-0">
                <p className="font-semibold text-foreground">{request.resident.name}</p>
                <p className="truncate text-[12.5px] text-muted-foreground">
                  {place(request.from)} → {place(request.to)}
                  {request.note ? ` · “${request.note}”` : ""}
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => browserApi(`${BASE}/requests/${request.id}`, { body: JSON.stringify({ action: "decline" }), method: "POST" }),
                    "Declined.",
                  )
                }
                size="sm"
                variant="outline"
              >
                Decline
              </Button>
              <Button
                disabled={busy || !request.to || (request.to.free ?? 0) <= 0}
                onClick={() =>
                  void run(
                    () => browserApi(`${BASE}/requests/${request.id}`, { body: JSON.stringify({ action: "approve" }), method: "POST" }),
                    `${request.resident.name} moved.`,
                  )
                }
                size="sm"
              >
                Confirm
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {data.tracking && rooms.length > 0 && data.unassigned.length > 0 ? (
        <div className="space-y-2 rounded-2xl border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs font-semibold text-warning">No room yet · {data.unassigned.length}</p>
          {data.unassigned.map((person) => (
            <div className="flex flex-wrap items-center gap-3 text-[13.5px]" key={person.id}>
              <span className="mr-auto font-medium text-foreground">
                {person.name} <span className="text-[12.5px] text-muted-foreground">· {roomTypeLabel(person.roomType)}</span>
              </span>
              <select
                className={cn(INPUT, "w-auto")}
                defaultValue=""
                disabled={busy}
                onChange={(event) =>
                  event.target.value &&
                  void run(
                    () =>
                      browserApi(`/api/v1/hostel-admin/residents/${person.id}/room`, {
                        body: JSON.stringify({ roomId: event.target.value }),
                        method: "PUT",
                      }),
                    `${person.name} has a room.`,
                  )
                }
              >
                <option value="">Pick a room</option>
                {rooms
                  .filter((room) => room.roomType === person.roomType && room.free > 0)
                  .map((room) => (
                    <option key={room.id} value={room.id}>
                      {`Room ${room.number} · ${floorName(room.floor)} (${room.free} free)`}
                    </option>
                  ))}
              </select>
            </div>
          ))}
        </div>
      ) : null}

      {types.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-[13.5px] text-muted-foreground">Add a room type first.</p>
      ) : !data.tracking ? (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
          <table className="w-full text-[13.5px]">
            <thead className="bg-muted/40 text-left text-[11px] font-semibold text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Room type</th>
                <th className="px-4 py-2.5">Rooms</th>
                <th className="px-4 py-2.5 text-right">Beds per room</th>
                <th className="px-4 py-2.5 text-right">Total beds</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((config) => {
                const count = typeTargets[config.roomType] ?? config.rooms;
                return (
                  <tr className="border-t border-border/70" key={config.roomType}>
                    <td className="px-4 py-2.5 font-semibold text-foreground">{roomTypeLabel(config.roomType)}</td>
                    <td className="px-4 py-2.5">
                      <Stepper disabled={busy} label={`${config.roomType} rooms`} onChange={(next) => setTypeTarget(config.roomType, next)} value={count} />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{bedsForRoomType(config.roomType)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{count * bedsForRoomType(config.roomType)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
          <aside className="space-y-2 lg:sticky lg:top-4 lg:self-start">
            <p className="text-xs font-semibold text-muted-foreground">Room types</p>
            <div className="flex flex-wrap gap-2 lg:flex-col">
              {types.map((roomType) => {
                const on = paint === roomType;
                return (
                  <button
                    aria-pressed={on}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition",
                      on ? "border-brand-teal bg-brand-teal text-white" : "border-border bg-card hover:border-brand-teal",
                    )}
                    key={roomType}
                    onClick={() => setPaint(on ? null : roomType)}
                    title={on ? "Click rooms to set this type" : "Pick, then click rooms to paint them"}
                    type="button"
                  >
                    <Glyph className="size-4 shrink-0" name="bed" />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{roomTypeLabel(roomType)}</span>
                      <span className={cn("block text-[11px]", on ? "text-white/80" : "text-muted-foreground")}>{beds(roomType)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="space-y-3">
            {chosen.length ? (
              <div className="sticky top-2 z-20 grid gap-3 rounded-2xl border border-brand-teal/40 bg-card/95 p-3 shadow-md backdrop-blur lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
                <div className="flex items-center gap-2">
                  <Button aria-label="Clear selection" className="size-8 rounded-full" disabled={removing} onClick={() => setSelected([])} size="icon" type="button" variant="ghost">
                    <Glyph className="size-4" name="close" />
                  </Button>
                  <p className="text-sm font-semibold text-foreground">
                    {chosen.length} {chosen.length === 1 ? "room" : "rooms"} selected
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex items-center gap-2">
                    <select aria-label="Set type" className={cn(INPUT, BAR_CONTROL, "min-w-0 flex-1")} onChange={(event) => setBulkType(event.target.value)} value={bulkType || types[0]}>
                      {types.map((type) => (
                        <option key={type} value={type}>{`${roomTypeLabel(type)} (${beds(type)})`}</option>
                      ))}
                    </select>
                    <Button className={BAR_CONTROL} disabled={busy} onClick={() => void retype(chosen, bulkType || types[0]).then((ok) => ok && setSelected([]))} size="sm" type="button">Set type</Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input aria-label="Renumber from" className={cn(INPUT, BAR_CONTROL, "min-w-0 flex-1")} onChange={(event) => setBulkFirst(event.target.value)} placeholder={`Start at ${chosen[0]?.number ?? ""}`} value={bulkFirst} />
                    <Button className={BAR_CONTROL} disabled={busy} onClick={renumberChosen} size="sm" type="button" variant="outline">Renumber</Button>
                  </div>
                </div>
                <Button className={cn(BAR_CONTROL, "text-destructive")} disabled={busy} onClick={() => void removeChosen()} size="sm" type="button" variant="outline">
                  {removing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {removing ? "Removing…" : "Remove"}
                </Button>
              </div>
            ) : null}

            {floors.length === 0 ? (
              <button
                className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border px-4 py-10 text-center transition hover:border-brand-teal"
                disabled={busy}
                onClick={addFloor}
                type="button"
              >
                <span className="flex size-11 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
                  <Building2 className="size-5" />
                </span>
                <span className="text-sm font-semibold text-foreground">No floors added yet</span>
                <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand-teal">
                  <Plus className="size-3.5" />
                  Add ground floor
                </span>
              </button>
            ) : null}

            {floors.map((floor) => {
              // The API sends each floor in the owner's dragged order; a drop shows at once, before the save returns.
              const saved = rooms.filter((room) => room.floor === floor);
              const onFloor = pendingOrder?.floor === floor ? [...saved].sort((a, b) => pendingOrder.ids.indexOf(a.id) - pendingOrder.ids.indexOf(b.id)) : saved;
              const shut = collapsed.includes(floor);
              return (
                <div className="rounded-2xl border border-border/70 bg-card p-3.5" key={floor}>
                  <div className="flex items-center gap-2">
                    <button
                      aria-expanded={!shut}
                      className="mr-auto flex items-center gap-2 text-left"
                      onClick={() => setCollapsed((current) => (shut ? current.filter((value) => value !== floor) : [...current, floor]))}
                      type="button"
                    >
                      <Glyph className={cn("size-4 transition-transform duration-300 ease-out", shut && "-rotate-90")} name="chevron-down" />
                      <span>
                        <span className="block font-heading text-[14px] font-semibold text-foreground">{floorName(floor)}</span>
                        <span className="block text-[12px] text-muted-foreground">{onFloor.length} rooms</span>
                      </span>
                    </button>
                    <Stepper disabled={busy} label={`rooms on ${floorName(floor)}`} onChange={(next) => setFloorTarget(floor, next)} value={floorTargets[floor] ?? onFloor.length} />
                  </div>
                  {/* 0fr → 1fr animates the height without measuring it; `inert` keeps hidden tiles out of the tab order. */}
                  <div
                    className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]", shut ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}
                    inert={shut}
                  >
                    <div className="-m-1 min-h-0 overflow-hidden p-1">
                    <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6 xl:grid-cols-8">
                      {onFloor.map((room) => {
                        const on = selected.includes(room.id);
                        const used = room.beds - room.free;
                        const full = room.free <= 0 && used > 0;
                        return (
                          <button
                            aria-pressed={on}
                            className={cn(
                              "relative flex flex-col items-center gap-1 rounded-xl border-2 py-2.5 transition hover:border-brand-teal",
                              on ? "border-brand-teal bg-brand-teal/10" : full ? "border-destructive/40" : "border-border",
                              dragId === room.id && "opacity-40",
                              overId === room.id && dragId !== room.id && "scale-[1.04] border-brand-teal ring-2 ring-brand-teal/30",
                            )}
                            draggable
                            key={room.id}
                            style={{ cursor: hand(dragId !== null) }}
                            onDragEnd={() => {
                              setDragId(null);
                              setOverId(null);
                            }}
                            onDragOver={(event) => {
                              const from = rooms.find((item) => item.id === dragId);
                              if (!from || from.floor !== room.floor) return;
                              event.preventDefault();
                              if (overId !== room.id) setOverId(room.id);
                            }}
                            onDragStart={(event) => {
                              unpeek();
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", room.id);
                              setDragId(room.id);
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              dropOn(room, onFloor);
                            }}
                            onBlur={unpeek}
                            onClick={(event) => {
                              unpeek();
                              clickTile(room, event);
                            }}
                            onFocus={(event) => !editing && peek(room.id, event.currentTarget)}
                            onPointerEnter={(event) => event.pointerType === "mouse" && !editing && peek(room.id, event.currentTarget)}
                            onPointerLeave={unpeek}
                            type="button"
                          >
                            <span className="font-heading text-[15px] font-bold leading-tight text-foreground">{room.number}</span>
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Glyph className={cn("size-3.5", on && "text-brand-teal")} name="bed" />
                              {room.beds}
                            </span>
                            {used > 0 ? (
                              <span className="h-1 w-3/4 overflow-hidden rounded-full bg-muted">
                                <span className={cn("block h-full rounded-full", full ? "bg-destructive" : "bg-brand-teal")} style={{ width: `${(used / room.beds) * 100}%` }} />
                              </span>
                            ) : null}
                            {on ? <Glyph className="absolute -bottom-1.5 -right-1.5 size-4 rounded-full bg-background text-brand-teal" name="checkmark-circle" variant="solid" /> : null}
                          </button>
                        );
                      })}
                    </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {floors.length ? (
              <button
                className="flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-border py-3 text-[13px] font-semibold text-brand-teal transition hover:border-brand-teal"
                disabled={busy}
                onClick={addFloor}
                type="button"
              >
                <Plus className="size-4" />
                Add floor
              </button>
            ) : null}
          </div>
        </div>
      )}

      {tip && rooms.find((room) => room.id === tip.roomId) ? <RoomTip open={tip.open} rect={tip.rect} room={rooms.find((room) => room.id === tip.roomId) as Room} /> : null}

      <Dialog onOpenChange={(open) => (open ? null : setEditing(null))} open={editing !== null}>
        <DialogContent className="sm:max-w-md">
          {editing ? (
            <form
              className="grid gap-4"
              key={editing.id}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const number = String(form.get("number") ?? "").trim();
                const roomType = String(form.get("roomType") ?? editing.roomType);

                void run(
                  () =>
                    browserApi(`${BASE}/${editing.id}`, {
                      body: JSON.stringify({
                        ...(number !== editing.number ? { number } : {}),
                        ...(roomType !== editing.roomType ? { beds: bedsForRoomType(roomType), roomType } : {}),
                      }),
                      method: "PATCH",
                    }),
                  `Room ${number} saved.`,
                ).then((ok) => ok && setEditing(null));
              }}
            >
              <DialogHeader>
                <DialogTitle>Room {editing.number}</DialogTitle>
                <DialogDescription>
                  {floorName(editing.floor)} · {editing.beds - editing.free} / {editing.beds} taken
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <label className={LABEL}>
                  Room number
                  <input className={INPUT} defaultValue={editing.number} name="number" required />
                </label>
                <label className={LABEL}>
                  Type
                  <select className={INPUT} defaultValue={editing.roomType} name="roomType">
                    {types.map((type) => (
                      <option key={type} value={type}>{`${roomTypeLabel(type)} (${beds(type)})`}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-2">
                <BedMarks room={editing} />
                <p className="text-[12px] text-muted-foreground">
                  {editing.free > 0 ? `${editing.free} of ${editing.beds} ${editing.beds === 1 ? "bed" : "beds"} free` : "Full"} · {roomTypeLabel(editing.roomType)} · {floorName(editing.floor)}
                </p>
              </div>
              <div className="grid gap-1">
                <p className="text-[11px] font-semibold text-muted-foreground">Living here</p>
                {editing.residents.length ? (
                  editing.residents.map((person) => (
                    <div className="flex items-center gap-3 rounded-xl py-1.5" key={person.id}>
                      <Initial name={person.name} photo={person.photo} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-semibold text-foreground">{person.name}</p>
                        {person.since ? <p className="text-[11.5px] text-muted-foreground">Since {new Date(person.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</p> : null}
                      </div>
                      {person.due === undefined ? null : person.due > 0 ? (
                        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">{formatMoney(person.due)} due</span>
                      ) : (
                        <span className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-[11px] font-semibold text-brand-teal">Paid up</span>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-[13px] text-muted-foreground">Nobody lives here yet.</p>
                )}
              </div>
              <DialogFooter className="sm:justify-between">
                <Button
                  className="text-destructive"
                  disabled={busy || editing.residents.length > 0}
                  onClick={async () => {
                    const room = editing;
                    const ok = await confirm({
                      actionLabel: "Delete room",
                      description: "Only an empty room can be removed.",
                      title: `Delete Room ${room.number}?`,
                      tone: "destructive",
                    });

                    if (ok && (await run(() => browserApi(`${BASE}/${room.id}`, { method: "DELETE" }), `Room ${room.number} removed.`))) {
                      setEditing(null);
                    }
                  }}
                  title={editing.residents.length > 0 ? "Move its residents first" : undefined}
                  type="button"
                  variant="outline"
                >
                  <Trash2 className="size-4" />
                  Delete room
                </Button>
                <Button disabled={busy} type="submit">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
