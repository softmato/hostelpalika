"use client";

import { Building2, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

/**
 * Floors and numbered rooms on the web (docs/FIELD_FIXES_2026_10.md §3): the
 * switch, room change requests, residents with no room, each floor's rooms,
 * and adding a floor's rooms in one go. Same endpoints as the app's Rooms.
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

function floorName(floor: number) {
  if (floor === 0) return "Ground floor";
  if (floor < 0) return floor === -1 ? "Basement" : `Basement ${-floor}`;
  const tens = floor % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[floor % 10] ?? "th";
  return `${floor}${suffix} floor`;
}

function place(value: Place) {
  return value ? `Room ${value.number} · ${floorName(value.floor)}` : "No room";
}

/** "101" + 5 → 101…105; letters kept: "A1" + 3 → A1, A2, A3. */
function numbersFrom(first: string, count: number) {
  const match = /^(.*?)(\d+)$/.exec(first.trim());
  if (!match || count <= 1) return first.trim() ? [first.trim()] : [];
  const [, prefix, digits] = match;
  return Array.from({ length: Math.min(count, 100) }, (_, index) =>
    `${prefix}${String(Number(digits) + index).padStart(digits.length, "0")}`,
  );
}

const INPUT = "h-10 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary";

export function FloorsPanel() {
  const layout = usePortalResource<Layout>(BASE);
  const requests = usePortalResource<{ requests: Request[] }>(`${BASE}/requests`);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [floor, setFloor] = useState("1");
  const [roomType, setRoomType] = useState("");
  const [first, setFirst] = useState("101");
  const [count, setCount] = useState("1");
  const [beds, setBeds] = useState("2");

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(done);
      await Promise.all([layout.refreshAsync(), requests.refreshAsync()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const data = layout.data;

  if (!data) {
    return (
      <section className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
        {layout.state === "error" ? "Rooms could not be loaded." : "Loading floors…"}
      </section>
    );
  }

  const numbers = numbersFrom(first, Number(count) || 1);
  const floors = [...new Set(data.rooms.map((room) => room.floor))].sort((a, b) => a - b);
  const pending = requests.data?.requests ?? [];

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center gap-3">
        <Building2 className="size-5 text-primary" />
        <div className="mr-auto">
          <h2 className="font-semibold text-foreground">Floors & room numbers</h2>
          <p className="text-xs text-muted-foreground">
            {data.tracking ? "Every resident has a floor and a room." : "Off — residents are kept by room type only."}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            checked={data.tracking}
            disabled={busy}
            onChange={(event) =>
              void run(
                () => browserApi(`${BASE}/tracking`, { body: JSON.stringify({ enabled: event.target.checked }), method: "PUT" }),
                event.target.checked ? "Floor & room is on." : "Room type only.",
              )
            }
            type="checkbox"
          />
          Floor & room
        </label>
      </header>

      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}

      {data.tracking ? (
        <>
          {pending.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Room change requests</h3>
              {pending.map((request) => (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3 text-sm" key={request.id}>
                  <div className="mr-auto">
                    <p className="font-semibold">{request.resident.name}</p>
                    <p className="text-xs text-muted-foreground">
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
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">No room yet · {data.unassigned.length}</h3>
              {data.unassigned.map((person) => (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm" key={person.id}>
                  <span className="mr-auto font-medium">
                    {person.name} <span className="text-xs text-muted-foreground">· {person.roomType}</span>
                  </span>
                  <select
                    className={INPUT}
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

          {floors.map((value) => {
            const onFloor = data.rooms.filter((room) => room.floor === value);
            return (
              <div className="space-y-2" key={value}>
                <h3 className="text-sm font-semibold">
                  {floorName(value)}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {onFloor.length} rooms · {onFloor.reduce((sum, room) => sum + room.free, 0)} beds free
                  </span>
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {onFloor.map((room) => (
                    <div className="group relative rounded-xl border border-border p-2.5" key={room.id} title={room.residents.map((person) => person.name).join(", ")}>
                      <p className="font-bold">{room.number}</p>
                      <p className="truncate text-xs text-muted-foreground">{room.roomType}</p>
                      <p className={cn("text-xs", room.free > 0 ? "text-success" : "text-muted-foreground")}>
                        {room.free > 0 ? `${room.free} of ${room.beds} free` : "Full"}
                      </p>
                      {room.residents.length === 0 ? (
                        <button
                          aria-label={`Remove room ${room.number}`}
                          className="absolute right-1.5 top-1.5 hidden text-muted-foreground hover:text-destructive group-hover:block"
                          onClick={() => void run(() => browserApi(`${BASE}/${room.id}`, { method: "DELETE" }), `Room ${room.number} removed.`)}
                          type="button"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <form
            className="grid gap-3 rounded-xl border border-dashed border-border p-4 sm:grid-cols-[repeat(5,minmax(0,1fr))_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  browserApi(BASE, {
                    body: JSON.stringify({ beds: Number(beds), floor: Number(floor), numbers, roomType }),
                    method: "POST",
                  }),
                `${numbers.length} rooms added.`,
              );
            }}
          >
            <label className="grid gap-1 text-xs font-semibold">
              Floor (0 = ground)
              <input className={INPUT} onChange={(event) => setFloor(event.target.value)} required type="number" value={floor} />
            </label>
            <label className="grid gap-1 text-xs font-semibold">
              Room type
              <select className={INPUT} onChange={(event) => setRoomType(event.target.value)} required value={roomType}>
                <option value="">Pick</option>
                {data.roomTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-semibold">
              First room no.
              <input className={INPUT} onChange={(event) => setFirst(event.target.value)} required value={first} />
            </label>
            <label className="grid gap-1 text-xs font-semibold">
              How many
              <input className={INPUT} min={1} max={100} onChange={(event) => setCount(event.target.value)} required type="number" value={count} />
            </label>
            <label className="grid gap-1 text-xs font-semibold">
              Beds each
              <input className={INPUT} min={1} max={40} onChange={(event) => setBeds(event.target.value)} required type="number" value={beds} />
            </label>
            <Button disabled={busy || numbers.length === 0 || !roomType} type="submit">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {numbers.length > 1 ? `Add ${numbers[0]}–${numbers.at(-1)}` : "Add room"}
            </Button>
          </form>
        </>
      ) : null}
    </section>
  );
}
