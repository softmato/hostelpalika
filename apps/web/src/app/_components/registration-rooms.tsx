"use client";

import { BedDouble, Info, Plus, Trash2 } from "lucide-react";
import { BEDS_BY_ROOM_TYPE, roomTypeOptions } from "./registration-fields";
import { RoomTypePicker } from "./room-type-picker";

type MealInclusion = "Included" | "Optional" | "Not Included";
export type RegistrationRoom = {
  id: string;
  roomType: string;
  rooms: string;
  bedsPerRoom: string;
  vacantBeds: string;
  monthlyRent: string;
  securityDeposit: string;
  mealInclusion: MealInclusion;
};

export function RegistrationRooms({
  rooms,
  globalDeposit,
  onDepositChange,
  updateRoom,
  onAdd,
  onRemove,
}: {
  rooms: RegistrationRoom[];
  globalDeposit: string;
  onDepositChange: (value: string) => void;
  updateRoom: (id: string, patch: Partial<RegistrationRoom>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const fields = [
    ["rooms", "Number of rooms", "0"],
    ["bedsPerRoom", "Beds per room", "0"],
    ["vacantBeds", "Vacant beds", "0"],
    ["monthlyRent", "Monthly rent / bed (NPR)", "0"],
    ["securityDeposit", "Deposit override (NPR)", globalDeposit || "Default"],
  ] as const;

  return (
    <div className="min-w-0 space-y-5">
      <div className="rounded-xl border border-border bg-muted/20 p-4">
        <label className="block max-w-sm text-sm font-medium">
          Security deposit per resident (NPR)
          <input
            className="input-field mt-2 block w-full"
            type="number"
            min={0}
            max={1000000}
            value={globalDeposit}
            onChange={(event) => onDepositChange(event.target.value)}
            placeholder="0"
          />
        </label>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Applies to all room types. Set a deposit override below only if it differs.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Room types & pricing</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Add one entry for each type of room.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={rooms.length >= roomTypeOptions.length}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-brand-teal/30 bg-brand-teal/5 px-3 text-sm font-semibold text-brand-teal transition hover:bg-brand-teal/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="size-4" /> Add room type
        </button>
      </div>

      {rooms.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <BedDouble className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">Add your first room type</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter room counts, vacancy and monthly pricing.
          </p>
        </div>
      )}

      {rooms.map((room, index) => (
        <div
          key={room.id}
          className="min-w-0 rounded-xl border border-border bg-background p-4 sm:p-5"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex size-8 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                <BedDouble className="size-4" />
              </span>
              Room type {index + 1}
            </div>
            <button
              type="button"
              aria-label={`Remove ${room.roomType}`}
              onClick={() => onRemove(room.id)}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-destructive/5 hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div className="min-w-0 sm:col-span-2 xl:col-span-3">
              <p className="mb-2 text-sm font-medium">
                Room type <span className="text-brand-teal">*</span>
              </p>
              <RoomTypePicker
                label={`Room type ${index + 1}`}
                value={room.roomType}
                selectedElsewhere={rooms
                  .filter((item) => item.id !== room.id)
                  .map((item) => item.roomType)}
                onChange={(roomType) => updateRoom(room.id, { roomType })}
              />
            </div>
            {fields.map(([key, label, placeholder]) => (
              <label key={key} className="block min-w-0 text-sm font-medium">
                {label}
                {["rooms", "bedsPerRoom", "vacantBeds"].includes(key) ? (
                  <span className="text-brand-teal"> *</span>
                ) : null}
                <input
                  className="input-field mt-2 block w-full min-w-0"
                  type="number"
                  min={key === "rooms" || key === "bedsPerRoom" ? 1 : 0}
                  max={
                    key === "vacantBeds"
                      ? Number(room.rooms) * Number(room.bedsPerRoom)
                      : undefined
                  }
                  required={["rooms", "bedsPerRoom", "vacantBeds"].includes(key)}
                  readOnly={
                    key === "bedsPerRoom" && Boolean(BEDS_BY_ROOM_TYPE[room.roomType])
                  }
                  aria-label={`${room.roomType} ${label.toLowerCase()}`}
                  placeholder={placeholder}
                  value={room[key]}
                  onChange={(event) => updateRoom(room.id, { [key]: event.target.value })}
                />
              </label>
            ))}
            <label className="block min-w-0 text-sm font-medium">
              Meals
              <select
                className="input-field mt-2 block w-full"
                aria-label={`${room.roomType} meals`}
                value={room.mealInclusion}
                onChange={(event) =>
                  updateRoom(room.id, {
                    mealInclusion: event.target.value as MealInclusion,
                  })
                }
              >
                <option>Included</option>
                <option>Optional</option>
                <option>Not Included</option>
              </select>
            </label>
          </div>
        </div>
      ))}
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" /> Prices are monthly per bed. You can
        update them later from your hostel dashboard.
      </p>
    </div>
  );
}
