"use client";

import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { Loader2 } from "@/components/icons";
import { useState } from "react";

import { floorName } from "@/app/_components/hostel-admin-floors-panel";
import { Glyph } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type PickableRoom = { beds: number; floor: number; free: number; id: string; number: string; roomType: string };

/**
 * Moving a resident to another room: the rooms with a free bed as tiles, the
 * resident's own type first. Nothing changes until "Move" is pressed.
 */
export function ResidentRoomDialog({
  busy,
  onClose,
  onMove,
  resident,
  rooms,
}: {
  busy: boolean;
  onClose: () => void;
  onMove: (roomId: string) => void;
  resident: { name: string; roomId?: string | null; roomType: string };
  rooms: PickableRoom[];
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const current = rooms.find((room) => room.id === resident.roomId);
  const open = rooms
    .filter((room) => room.id !== resident.roomId && room.free > 0)
    .sort((a, b) => a.floor - b.floor || a.number.localeCompare(b.number, undefined, { numeric: true }));
  const types = [...new Set(open.map((room) => room.roomType))].sort((a, b) => Number(b === resident.roomType) - Number(a === resident.roomType));
  const target = rooms.find((room) => room.id === picked);
  const retype = target !== undefined && target.roomType !== resident.roomType;

  return (
    <Dialog onOpenChange={(next) => (next || busy ? null : onClose())} open>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{current ? "Change room" : "Give a room"} · {resident.name}</DialogTitle>
          <DialogDescription>Pick a room with a free bed. Nothing changes until you press Move.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-muted/20 px-3.5 py-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal">
            <Glyph className="size-5" name="bed" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-muted-foreground">Now</p>
            <p className="truncate text-[14px] font-semibold text-foreground">
              {current ? `Room ${current.number} · ${floorName(current.floor)}` : "No room yet"}
            </p>
            <p className="truncate text-[12px] text-muted-foreground">{roomTypeLabel(resident.roomType)}</p>
          </div>
        </div>

        <div className="grid max-h-[50vh] gap-4 overflow-y-auto pr-1">
          {types.length === 0 ? (
            <p className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] font-semibold text-destructive">No other room has a free bed right now.</p>
          ) : null}
          {types.map((type) => (
            <div className="grid gap-1.5" key={type}>
              <p className="text-[11px] font-semibold text-muted-foreground">
                {type === resident.roomType ? `Same type · ${roomTypeLabel(type)}` : `Other type · ${roomTypeLabel(type)}`}
              </p>
              <div className="grid grid-cols-2 gap-2 p-0.5 sm:grid-cols-3" role="radiogroup">
                {open
                  .filter((room) => room.roomType === type)
                  .map((room) => {
                    const on = picked === room.id;

                    return (
                      <button
                        aria-checked={on}
                        className={cn(
                          "relative grid gap-1 rounded-xl border-2 bg-card px-3 py-2 text-left transition hover:border-brand-teal",
                          on ? "border-brand-teal bg-brand-teal/10" : "border-border",
                        )}
                        key={room.id}
                        onClick={() => setPicked(room.id)}
                        role="radio"
                        type="button"
                      >
                        <span className="font-heading text-[15px] font-bold leading-tight text-foreground">Room {room.number}</span>
                        <span className="text-[11.5px] text-muted-foreground">{floorName(room.floor)}</span>
                        <span className="flex items-center gap-1">
                          {Array.from({ length: room.beds }, (_, at) => (
                            <Glyph
                              className={cn("size-3.5", at < room.beds - room.free ? "text-muted-foreground/50" : "text-brand-teal")}
                              key={at}
                              name="bed"
                              variant={at < room.beds - room.free ? "solid" : "line"}
                            />
                          ))}
                          <span className="ml-1 text-[11px] font-semibold text-brand-teal">{room.free} free</span>
                        </span>
                        {on ? <Glyph className="absolute right-2 top-2 size-4 text-brand-teal" name="checkmark-circle" variant="solid" /> : null}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>

        {retype ? (
          <p className="rounded-xl bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            This is a {roomTypeLabel(target.roomType)}. {resident.name}&rsquo;s rent follows the room type from the next bill.
          </p>
        ) : null}

        <DialogFooter>
          <Button disabled={busy} onClick={onClose} type="button" variant="outline">Cancel</Button>
          <Button disabled={busy || !picked} onClick={() => picked && onMove(picked)} type="button">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {target ? `Move to Room ${target.number}` : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
