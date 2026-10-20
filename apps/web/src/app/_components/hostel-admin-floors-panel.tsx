"use client";

import { Building2, Loader2, Plus, Trash2 } from "@/components/icons";
import { useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { Glyph } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

import type { RoomConfiguration } from "./core-portal-shared";

/**
 * Floors and numbered rooms (docs/FIELD_FIXES_2026_10.md §3), built floor by
 * floor: each floor is a card holding its rooms, and rooms are added right on
 * the floor they sit on — pick the type, say how many, and the numbers count
 * on from the last one there (101, 102…). Room types only say what a bed is;
 * their counts follow from the rooms placed here.
 *
 * Same endpoints as the app's Rooms. Also embedded in Hostel KYC.
 */

type Room = {
  beds: number;
  floor: number;
  free: number;
  id: string;
  number: string;
  residents: { id: string; name: string }[];
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

/** "101" + 5 → 101…105; letters kept: "G1" + 3 → G1, G2, G3. */
export function numbersFrom(first: string, count: number) {
  const match = /^(.*?)(\d+)$/.exec(first.trim());
  if (!match || count <= 1) return first.trim() ? [first.trim()] : [];
  const [, prefix, digits] = match;
  return Array.from({ length: Math.min(count, 100) }, (_, index) =>
    `${prefix}${String(Number(digits) + index).padStart(digits.length, "0")}`,
  );
}

/** The number after the highest one already on this floor, or the floor's first. */
export function nextNumber(floor: number, onFloor: string[]) {
  let best: { digits: string; prefix: string; value: number } | null = null;

  for (const number of onFloor) {
    const match = /^(.*?)(\d+)$/.exec(number.trim());
    if (match && (!best || Number(match[2]) > best.value)) best = { digits: match[2], prefix: match[1], value: Number(match[2]) };
  }

  if (best) return `${best.prefix}${String(best.value + 1).padStart(best.digits.length, "0")}`;
  if (floor > 0) return `${floor}01`;
  return floor === 0 ? "G1" : `B${-floor}1`;
}

const INPUT = "h-10 w-full rounded-xl border border-border bg-background px-3 text-[13.5px] outline-none focus:border-brand-teal";
const LABEL = "grid gap-1 text-[11px] font-semibold text-muted-foreground";

export function FloorsPanel() {
  const layout = usePortalResource<Layout>(BASE);
  const requests = usePortalResource<{ requests: Request[] }>(`${BASE}/requests`);
  const profile = usePortalResource<{ hostel: { roomConfigurations: RoomConfiguration[] } }>(hostelAdminEndpoints.profile);
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  /** Floors opened with "Add floor" that have no rooms yet. */
  const [draftFloors, setDraftFloors] = useState<number[]>([]);
  /** The floor whose add-rooms row is open. */
  const [addingOn, setAddingOn] = useState<number | null>(null);
  const [editing, setEditing] = useState<Room | null>(null);

  /** `true` when the work went through, so a form knows to close. */
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(done);
      // Room counts per type follow the rooms, so the room types refresh too.
      invalidate(hostelAdminEndpoints.profile);
      await Promise.all([layout.refreshAsync(), requests.refreshAsync()]);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const data = layout.data;

  if (!data) {
    return (
      <section className="rounded-2xl border border-border/70 bg-card p-4 text-[13.5px] text-muted-foreground">
        {layout.state === "error" ? "Rooms could not be loaded." : "Loading floors…"}
      </section>
    );
  }

  const configs = profile.data?.hostel.roomConfigurations ?? [];
  const bedsFor = (roomType: string) => configs.find((config) => config.roomType === roomType)?.bedsPerRoom ?? 2;
  const floors = [...new Set([...data.rooms.map((room) => room.floor), ...draftFloors])].sort((a, b) => a - b);
  const pending = requests.data?.requests ?? [];
  const freeBeds = data.rooms.reduce((sum, room) => sum + room.free, 0);
  const toggleTracking = () =>
    void run(
      () => browserApi(`${BASE}/tracking`, { body: JSON.stringify({ enabled: !data.tracking }), method: "PUT" }),
      data.tracking ? "Kept by room type only." : "Floors & room numbers are on.",
    );
  const addFloor = () => {
    const next = floors.length === 0 ? 0 : Math.max(...floors) + 1;
    setDraftFloors((current) => [...current, next]);
    setAddingOn(next);
  };

  if (!data.tracking) {
    return (
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-card p-4">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Building2 className="size-[18px]" />
        </span>
        <div className="mr-auto min-w-0">
          <h2 className="font-heading text-[15px] font-semibold text-foreground">Floors & room numbers are off</h2>
          <p className="text-[12.5px] text-muted-foreground">Residents are kept by room type only. Turn on to place each room on its floor.</p>
        </div>
        <Button disabled={busy} onClick={toggleTracking} size="sm" type="button">
          Turn on
        </Button>
        {message ? <p className="w-full text-[13px] text-muted-foreground">{message}</p> : null}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {confirmDialog}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-[15px] font-semibold text-foreground">Floors</h2>
          <p className="text-[12.5px] text-muted-foreground">
            {floors.length} {floors.length === 1 ? "floor" : "floors"} · {data.rooms.length} rooms · {freeBeds} beds free
          </p>
        </div>
        <Button disabled={busy || data.roomTypes.length === 0} onClick={addFloor} size="sm" type="button">
          <Plus className="size-3.5" />
          Add floor
        </Button>
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

      {data.rooms.length > 0 && data.unassigned.length > 0 ? (
        <div className="space-y-2 rounded-2xl border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs font-semibold text-warning">No room yet · {data.unassigned.length}</p>
          {data.unassigned.map((person) => (
            <div className="flex flex-wrap items-center gap-3 text-[13.5px]" key={person.id}>
              <span className="mr-auto font-medium text-foreground">
                {person.name} <span className="text-[12.5px] text-muted-foreground">· {person.roomType}</span>
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
                {data.rooms
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

      {data.roomTypes.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-[13.5px] text-muted-foreground">
          Add a room type above first — then place its rooms on each floor.
        </p>
      ) : floors.length === 0 ? (
        <button
          className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border px-4 py-8 text-center transition hover:border-brand-teal"
          onClick={addFloor}
          type="button"
        >
          <span className="flex size-11 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
            <Building2 className="size-5" />
          </span>
          <span className="text-sm font-semibold text-foreground">Start with the ground floor</span>
          <span className="text-xs text-muted-foreground">Add its rooms, then the next floor up.</span>
        </button>
      ) : null}

      {floors.map((value) => {
        const onFloor = data.rooms
          .filter((room) => room.floor === value)
          .sort((left, right) => left.number.localeCompare(right.number, undefined, { numeric: true }));

        return (
          <div className="rounded-2xl border border-border/70 bg-card p-3.5" key={value}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-heading text-[14px] font-semibold text-foreground">{floorName(value)}</h3>
              <span className="mr-auto text-[12px] text-muted-foreground">
                {onFloor.length} {onFloor.length === 1 ? "room" : "rooms"} · {onFloor.reduce((sum, room) => sum + room.free, 0)} beds free
              </span>
              {addingOn !== value ? (
                <Button disabled={busy} onClick={() => setAddingOn(value)} size="sm" type="button" variant="ghost">
                  <Plus className="size-3.5" />
                  Add rooms
                </Button>
              ) : null}
            </div>

            {onFloor.length > 0 ? (
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">
                {onFloor.map((room) => (
                  <button
                    className="rounded-xl border border-border/70 p-2 text-left transition hover:border-brand-teal hover:shadow-sm"
                    key={room.id}
                    onClick={() => setEditing(room)}
                    title={room.residents.map((person) => person.name).join(", ") || "Empty"}
                    type="button"
                  >
                    <p className="font-heading text-[15px] font-bold leading-tight text-foreground">{room.number}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{room.roomType}</p>
                    {/* One dot a bed: filled is taken, ringed is free. */}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Array.from({ length: Math.min(room.beds, 12) }, (_, index) => (
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            index < room.beds - room.free ? "bg-foreground" : "border border-brand-teal bg-brand-teal/15",
                          )}
                          key={index}
                        />
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            {addingOn === value ? (
              <AddRoomsRow
                bedsFor={bedsFor}
                busy={busy}
                floor={value}
                onAdd={(input) =>
                  run(
                    () => browserApi(BASE, { body: JSON.stringify({ ...input, floor: value }), method: "POST" }),
                    `${input.numbers.length} ${input.numbers.length === 1 ? "room" : "rooms"} added to the ${floorName(value).toLowerCase()}.`,
                  ).then((ok) => {
                    if (ok) {
                      setAddingOn(null);
                      setDraftFloors((current) => current.filter((floor) => floor !== value));
                    }
                  })
                }
                onCancel={() => {
                  setAddingOn(null);
                  setDraftFloors((current) => current.filter((floor) => floor !== value));
                }}
                onFloor={onFloor.map((room) => room.number)}
                roomTypes={data.roomTypes}
              />
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-3 rounded-2xl bg-muted/40 px-4 py-3 text-[12.5px] text-muted-foreground">
        <span>Floors & room numbers are on. Turn off to keep residents by room type only.</span>
        <button className="font-semibold text-foreground hover:underline" disabled={busy} onClick={toggleTracking} type="button">
          Turn off
        </button>
      </div>

      <Dialog onOpenChange={(open) => (open ? null : setEditing(null))} open={editing !== null}>
        <DialogContent className="sm:max-w-md">
          {editing ? (
            <form
              className="grid gap-4"
              key={editing.id}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);

                void run(
                  () =>
                    browserApi(`${BASE}/${editing.id}`, {
                      body: JSON.stringify({
                        beds: Number(form.get("beds")),
                        floor: Number(form.get("floor")),
                        number: String(form.get("number") ?? "").trim(),
                        roomType: String(form.get("roomType") ?? ""),
                      }),
                      method: "PATCH",
                    }),
                  `Room ${String(form.get("number"))} saved.`,
                ).then((ok) => ok && setEditing(null));
              }}
            >
              <DialogHeader>
                <DialogTitle>Room {editing.number}</DialogTitle>
                <DialogDescription>
                  {editing.residents.length > 0
                    ? `Lives here: ${editing.residents.map((person) => person.name).join(", ")}`
                    : `${floorName(editing.floor)} · empty`}
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <label className={LABEL}>
                  Room number
                  <input className={INPUT} defaultValue={editing.number} name="number" required />
                </label>
                <label className={LABEL}>
                  Floor (0 = ground)
                  <input className={INPUT} defaultValue={editing.floor} name="floor" required type="number" />
                </label>
                <label className={LABEL}>
                  Room type
                  <select className={INPUT} defaultValue={editing.roomType} name="roomType">
                    {data.roomTypes.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={LABEL}>
                  Beds
                  <input className={INPUT} defaultValue={editing.beds} max={40} min={1} name="beds" required type="number" />
                </label>
              </div>
              <DialogFooter className="sm:justify-between">
                <Button
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy || editing.residents.length > 0}
                  onClick={async () => {
                    const room = editing;
                    const ok = await confirm({
                      actionLabel: "Remove room",
                      description: "Only an empty room can be removed.",
                      pin: true,
                      title: `Remove Room ${room.number}?`,
                      tone: "destructive",
                    });

                    if (ok && (await run(() => browserApi(`${BASE}/${room.id}`, { method: "DELETE" }), `Room ${room.number} removed.`))) {
                      setEditing(null);
                    }
                  }}
                  title={editing.residents.length > 0 ? "Move its residents first" : undefined}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                  Remove
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

/** Type, how many, where the numbers start, beds each — on the floor itself. */
function AddRoomsRow({
  bedsFor,
  busy,
  floor,
  onAdd,
  onCancel,
  onFloor,
  roomTypes,
}: {
  bedsFor: (roomType: string) => number;
  busy: boolean;
  floor: number;
  onAdd: (input: { beds: number; numbers: string[]; roomType: string }) => Promise<void>;
  onCancel: () => void;
  onFloor: string[];
  roomTypes: string[];
}) {
  const [roomType, setRoomType] = useState(roomTypes[0] ?? "");
  const [count, setCount] = useState("4");
  const [first, setFirst] = useState(() => nextNumber(floor, onFloor));
  const [beds, setBeds] = useState(() => String(bedsFor(roomTypes[0] ?? "")));
  const numbers = numbersFrom(first, Number(count) || 1);
  const clash = numbers.filter((number) => onFloor.includes(number));

  return (
    <form
      className="mt-3 grid gap-3 rounded-xl bg-muted/40 p-3 sm:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        void onAdd({ beds: Number(beds) || 1, numbers, roomType });
      }}
    >
      <label className={LABEL}>
        Room type
        <select
          className={INPUT}
          onChange={(event) => {
            setRoomType(event.target.value);
            setBeds(String(bedsFor(event.target.value)));
          }}
          value={roomType}
        >
          {roomTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        How many
        <input autoFocus className={INPUT} max={100} min={1} onChange={(event) => setCount(event.target.value)} required type="number" value={count} />
      </label>
      <label className={LABEL}>
        First number
        <input className={INPUT} onChange={(event) => setFirst(event.target.value)} required value={first} />
      </label>
      <label className={LABEL}>
        Beds each
        <input className={INPUT} max={40} min={1} onChange={(event) => setBeds(event.target.value)} required type="number" value={beds} />
      </label>
      <div className="flex items-end gap-2">
        <Button disabled={busy} onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={busy || numbers.length === 0 || !roomType || clash.length > 0} type="submit">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          {numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : `Add ${numbers[0] ?? ""}`}
        </Button>
      </div>
      {clash.length > 0 ? (
        <p className="text-xs text-destructive sm:col-span-5">Room {clash.join(", ")} is already on this floor.</p>
      ) : null}
    </form>
  );
}
