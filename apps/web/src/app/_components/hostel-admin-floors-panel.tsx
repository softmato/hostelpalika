"use client";

import { Building2, Loader2, Plus, Trash2 } from "@/components/icons";
import { useState } from "react";

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

const INPUT = "h-10 rounded-xl border border-border bg-background px-3 text-[13.5px] outline-none focus:border-brand-teal";
const LABEL = "grid gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const SUBHEAD = "text-[11px] font-semibold uppercase tracking-[0.08em]";

export function FloorsPanel() {
  const layout = usePortalResource<Layout>(BASE);
  const requests = usePortalResource<{ requests: Request[] }>(`${BASE}/requests`);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [floor, setFloor] = useState("1");
  const [roomType, setRoomType] = useState("");
  const [first, setFirst] = useState("101");
  const [count, setCount] = useState("1");
  const [beds, setBeds] = useState("2");

  /** `true` when the work went through, so a dialog knows to close. */
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(done);
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

  const numbers = numbersFrom(first, Number(count) || 1);
  const floors = [...new Set(data.rooms.map((room) => room.floor))].sort((a, b) => a - b);
  const pending = requests.data?.requests ?? [];

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-4">
      <header className="flex flex-wrap items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-full bg-role-team-soft text-role-team">
          <Building2 className="size-[18px]" />
        </span>
        <div className="mr-auto min-w-0">
          <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">Floors & room numbers</h2>
          <p className="text-[12.5px] text-muted-foreground">
            {data.tracking ? `${floors.length} floors · ${data.rooms.length} rooms` : "Off — residents are kept by room type only."}
          </p>
        </div>
        {data.tracking ? (
          <Button disabled={busy} onClick={() => setAdding(true)} size="sm" type="button" variant="outline">
            <Plus className="size-3.5" />
            Add rooms
          </Button>
        ) : null}
        <button
          aria-checked={data.tracking}
          aria-label="Floor & room"
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60",
            data.tracking ? "bg-brand-teal" : "bg-muted-foreground/30",
          )}
          disabled={busy}
          onClick={() =>
            void run(
              () => browserApi(`${BASE}/tracking`, { body: JSON.stringify({ enabled: !data.tracking }), method: "PUT" }),
              data.tracking ? "Room type only." : "Floor & room is on.",
            )
          }
          role="switch"
          title="Floor & room"
          type="button"
        >
          <span
            className={cn(
              "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
              data.tracking ? "left-[18px]" : "left-0.5",
            )}
          />
        </button>
      </header>

      {message ? <p className="text-[13.5px] text-muted-foreground">{message}</p> : null}

      {data.tracking ? (
        <>
          {pending.length > 0 ? (
            <div className="space-y-2">
              <p className={cn(SUBHEAD, "text-muted-foreground")}>Room change requests · {pending.length}</p>
              {pending.map((request) => (
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/50 p-3 text-[13.5px]" key={request.id}>
                  <Glyph className="size-4 shrink-0 text-role-team" name="swap-horizontal" />
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
                    className="bg-brand-teal text-white hover:bg-brand-teal/90"
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
              <p className={cn(SUBHEAD, "text-amber-700 dark:text-amber-300")}>No room yet · {data.unassigned.length}</p>
              {data.unassigned.map((person) => (
                <div
                  className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 p-3 text-[13.5px] dark:bg-amber-950/30"
                  key={person.id}
                >
                  <span className="mr-auto font-medium text-foreground">
                    {person.name} <span className="text-[12.5px] text-muted-foreground">· {person.roomType}</span>
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

          {floors.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-6 text-center text-[13.5px] text-muted-foreground">
              No numbered rooms yet.
            </p>
          ) : null}

          {floors.map((value) => {
            const onFloor = data.rooms.filter((room) => room.floor === value);
            return (
              <div className="space-y-2" key={value}>
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[13.5px] font-semibold text-foreground">{floorName(value)}</h3>
                  <span className="text-[12px] text-muted-foreground">
                    {onFloor.length} rooms · {onFloor.reduce((sum, room) => sum + room.free, 0)} beds free
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {onFloor.map((room) => {
                    const share = room.beds > 0 ? Math.round(((room.beds - room.free) / room.beds) * 100) : 0;

                    return (
                      <div
                        className="group relative rounded-xl border border-border/70 p-2.5 transition duration-200 hover:-translate-y-0.5 hover:shadow-sm"
                        key={room.id}
                        title={room.residents.map((person) => person.name).join(", ")}
                      >
                        <p className="font-heading text-[15px] font-bold leading-tight text-foreground">{room.number}</p>
                        <p className="truncate text-[11.5px] text-muted-foreground">{room.roomType}</p>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn("h-full rounded-full", room.free > 0 ? "bg-brand-teal" : "bg-foreground")}
                            style={{ width: `${share}%` }}
                          />
                        </div>
                        <p className={cn("mt-1 text-[11.5px] font-medium", room.free > 0 ? "text-role-team" : "text-muted-foreground")}>
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
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      ) : null}

      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add rooms</DialogTitle>
            <DialogDescription>One floor at a time. Numbers count up from the first.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  browserApi(BASE, {
                    body: JSON.stringify({ beds: Number(beds), floor: Number(floor), numbers, roomType }),
                    method: "POST",
                  }),
                `${numbers.length} rooms added.`,
              ).then((ok) => {
                if (ok) setAdding(false);
              });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <label className={LABEL}>
                Floor (0 = ground)
                <input className={INPUT} onChange={(event) => setFloor(event.target.value)} required type="number" value={floor} />
              </label>
              <label className={LABEL}>
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
            </div>
            <div className="grid grid-cols-3 gap-3">
              <label className={LABEL}>
                First no.
                <input className={INPUT} onChange={(event) => setFirst(event.target.value)} required value={first} />
              </label>
              <label className={LABEL}>
                How many
                <input className={INPUT} max={100} min={1} onChange={(event) => setCount(event.target.value)} required type="number" value={count} />
              </label>
              <label className={LABEL}>
                Beds each
                <input className={INPUT} max={40} min={1} onChange={(event) => setBeds(event.target.value)} required type="number" value={beds} />
              </label>
            </div>
            <DialogFooter>
              <Button
                className="bg-brand-teal text-white hover:bg-brand-teal/90"
                disabled={busy || numbers.length === 0 || !roomType}
                type="submit"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {numbers.length > 1 ? `Add ${numbers[0]}–${numbers.at(-1)}` : "Add room"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
