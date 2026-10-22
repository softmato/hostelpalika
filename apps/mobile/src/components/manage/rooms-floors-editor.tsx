import { bedsForRoomType } from "@hostel/constants/room-types";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { NumberStepper } from "@/components/step-flow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/layout";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { type ManagedHostel, updateManagedHostel } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import {
  addRooms,
  byFloor,
  deleteRoom,
  floorLabel,
  type Room,
  type RoomLayout,
  roomsQuery,
  setRoomTracking,
  updateRoom,
} from "@/lib/rooms-api";
import { toastError } from "@/lib/toast";

type Mode = "floor" | "type";

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

/**
 * Rooms & floors (the design the owner signed off, 2026-10-22). Floor-wise:
 * each floor's room count is a stepper, its rooms are tiles, and a type chip
 * paints rooms — tap a tile to paint it, hold one to select several. Not
 * floor-wise: a room count per type. Every change saves at once, so KYC and
 * Settings share this unchanged.
 */
export function RoomsFloorsEditor({ onChanged }: { onChanged?: () => Promise<void> | void }) {
  const layoutQuery = roomsQuery.layout();
  const layout = useResource<RoomLayout>(layoutQuery.load, { cacheKey: layoutQuery.key, topics: layoutQuery.topics });
  const hostelQuery = adminQuery.managedHostel();
  const hostel = useResource<ManagedHostel>(hostelQuery.load, { cacheKey: hostelQuery.key, topics: hostelQuery.topics });
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (work: () => Promise<RoomLayout | void>) => {
      setBusy(true);
      try {
        const next = await work();
        if (next) layout.setData(() => next);
        await Promise.all([hostel.refresh(), onChanged?.()]);
        return true;
      } catch (error) {
        toastError("Not saved", readApiError(error));
        await layout.refresh();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [hostel, layout, onChanged],
  );

  if (layout.loading || hostel.loading) {
    return (
      <View className="gap-4">
        <SkeletonTiles />
        <SkeletonCard rows={3} />
      </View>
    );
  }

  if (layout.error || hostel.error || !layout.data || !hostel.data) {
    return <ErrorState message={layout.error ?? hostel.error ?? "Rooms did not load."} onRetry={() => { void layout.reload(); void hostel.reload(); }} />;
  }

  const data = layout.data;
  const types = hostel.data.roomConfigurations;
  const mode: Mode = data.tracking ? "floor" : "type";
  const totals = data.tracking
    ? { beds: data.rooms.reduce((sum, room) => sum + room.beds, 0), free: data.rooms.reduce((sum, room) => sum + room.free, 0), rooms: data.rooms.length }
    : {
        beds: types.reduce((sum, type) => sum + type.rooms * bedsForRoomType(type.roomType), 0),
        free: types.reduce((sum, type) => sum + type.vacantBeds, 0),
        rooms: types.reduce((sum, type) => sum + type.rooms, 0),
      };

  return (
    <View className="gap-4">
      <Segmented<Mode>
        onChange={(next) => next !== mode && void run(() => setRoomTracking(next === "floor"))}
        options={[
          { label: "Floor-wise", value: "floor" },
          { label: "Not floor-wise", value: "type" },
        ]}
        value={mode}
      />
      <View className="flex-row gap-3">
        <StatTile icon="business" label="Rooms" tone="brand" value={String(totals.rooms)} />
        <StatTile icon="bed" label="Beds" value={String(totals.beds)} />
        <StatTile icon="checkmark-circle" label="Free" tone={totals.free > 0 ? "success" : "neutral"} value={String(totals.free)} />
      </View>
      {types.length === 0 ? (
        <EmptyCard description="Add room types first." title="No room types" />
      ) : mode === "floor" ? (
        <FloorPlan busy={busy} data={data} run={run} types={types.map((type) => type.roomType)} />
      ) : (
        <TypeCounts busy={busy} run={run} types={types} />
      )}
    </View>
  );
}

type Run = (work: () => Promise<RoomLayout | void>) => Promise<boolean>;

function FloorPlan({ busy, data, run, types }: { busy: boolean; data: RoomLayout; run: Run; types: string[] }) {
  const { colors } = useAppTheme();
  const floors = byFloor(data.rooms);
  const [paint, setPaint] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<Room | null>(null);
  const [sheet, setSheet] = useState<"type" | "renumber" | null>(null);
  const taken = data.rooms.map((room) => room.number);
  const commonType = (rooms: Room[]) =>
    paint ?? [...rooms].sort((a, b) => rooms.filter((room) => room.roomType === b.roomType).length - rooms.filter((room) => room.roomType === a.roomType).length)[0]?.roomType ?? types[0];

  // A typed or stepped count settles for a moment, then the floor grows or shrinks once.
  const latest = useRef({ data, run, taken });
  useEffect(() => {
    latest.current = { data, run, taken };
  });
  useEffect(() => {
    const entries = Object.entries(targets);
    if (!entries.length) return;
    const timer = setTimeout(() => {
      setTargets({});
      for (const [key, value] of entries) {
        const floor = Number(key);
        const target = Number(value) || 0;
        const onFloor = latest.current.data.rooms.filter((room) => room.floor === floor).sort(byNumber);
        void latest.current.run(async () => {
          if (target > onFloor.length) {
            const roomType = commonType(onFloor);
            return addRooms({ beds: bedsForRoomType(roomType), floor, numbers: nextRoomNumbers(floor, latest.current.taken, target - onFloor.length), roomType });
          }
          let last: RoomLayout | undefined;
          for (const room of onFloor.slice(target).reverse()) last = await deleteRoom(room.id);
          return last;
        });
      }
    }, 600);
    return () => clearTimeout(timer);
    // commonType reads `paint`, which is current when the timer fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets]);

  const addFloor = () => {
    const above = floors.at(-1);
    const floor = above ? above.floor + 1 : 0;
    // A new floor copies the one above it; the first starts with one room.
    const plan = above ? [...above.rooms].sort(byNumber).map((room) => room.roomType) : [paint ?? types[0]];
    void run(async () => {
      const numbers = nextRoomNumbers(floor, taken, plan.length);
      let last: RoomLayout | undefined;
      for (const roomType of [...new Set(plan)]) {
        last = await addRooms({ beds: bedsForRoomType(roomType), floor, numbers: numbers.filter((_, at) => plan[at] === roomType), roomType });
      }
      return last;
    });
  };

  const retype = (rooms: Room[], roomType: string) =>
    run(async () => {
      let last: RoomLayout | undefined;
      for (const room of rooms.filter((item) => item.roomType !== roomType)) last = await updateRoom(room.id, { beds: bedsForRoomType(roomType), roomType });
      return last;
    });

  const pressTile = (room: Room) => {
    if (selected.length) setSelected((current) => (current.includes(room.id) ? current.filter((id) => id !== room.id) : [...current, room.id]));
    else if (paint) void retype([room], paint);
    else setOpen(room);
  };

  const chosen = data.rooms.filter((room) => selected.includes(room.id)).sort(byNumber);

  return (
    <View className="gap-4">
      {selected.length ? (
        <Card className="gap-3">
          <View className="flex-row items-center">
            <Text className="flex-1" variant="label">{selected.length} rooms selected</Text>
            <Pressable accessibilityLabel="Clear selection" accessibilityRole="button" hitSlop={8} onPress={() => setSelected([])}>
              <Glyph color={colors.mutedForeground} name="close" size={20} />
            </Pressable>
          </View>
          <View className="flex-row gap-2">
            {([
              ["pricetag", "Set type", () => setSheet("type")],
              ["swap-vertical", "Renumber", () => setSheet("renumber")],
              ["trash", "Remove", () => openConfirm({
                confirmLabel: "Remove",
                destructive: true,
                message: "Only empty rooms can be removed.",
                onConfirm: async () => {
                  if (await run(async () => {
                    let last: RoomLayout | undefined;
                    for (const room of chosen) last = await deleteRoom(room.id);
                    return last;
                  })) setSelected([]);
                },
                pin: true,
                title: `Remove ${chosen.length} rooms?`,
              })],
            ] as const).map(([icon, label, onPress]) => (
              <Pressable accessibilityRole="button" className="min-h-14 flex-1 items-center justify-center gap-1 rounded-xl border border-border active:opacity-70" disabled={busy} key={label} onPress={onPress}>
                <Glyph color={icon === "trash" ? colors.destructive : colors.foreground} name={icon} size={20} />
                <Text variant="caption">{label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {types.map((roomType) => {
            const on = paint === roomType;
            const beds = bedsForRoomType(roomType);
            return (
              <Pressable
                accessibilityLabel={`Paint rooms ${roomType}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                className={`min-h-12 justify-center rounded-xl border px-3 py-1.5 active:opacity-70 ${on ? "border-primary bg-primary" : "border-border bg-card"}`}
                key={roomType}
                onPress={() => setPaint(on ? null : roomType)}
              >
                <Text className={on ? "font-semibold text-primary-foreground" : "font-semibold text-foreground"} numberOfLines={1}>{roomType.replace(" — Attached Bathroom", " + bath")}</Text>
                <Text className={on ? "text-xs text-primary-foreground" : "text-xs text-muted-foreground"}>{beds} {beds === 1 ? "bed" : "beds"}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {floors.length === 0 ? (
        <EmptyCard action={<Button disabled={busy} icon="add" label="Add ground floor" onPress={addFloor} />} title="No floors added yet" />
      ) : (
        floors.map((entry) => {
          const shut = collapsed.includes(entry.floor);
          return (
            <Card className="gap-3" key={entry.floor}>
              <View className="flex-row items-center gap-2">
                <Pressable
                  accessibilityLabel={`${shut ? "Open" : "Close"} ${floorLabel(entry.floor)}`}
                  accessibilityRole="button"
                  className="flex-1 flex-row items-center gap-2"
                  onPress={() => setCollapsed((current) => (shut ? current.filter((floor) => floor !== entry.floor) : [...current, entry.floor]))}
                >
                  <Glyph color={colors.foreground} name={shut ? "chevron-forward" : "chevron-down"} size={18} />
                  <View>
                    <Text variant="label">{floorLabel(entry.floor)}</Text>
                    <Text variant="caption">{entry.rooms.length} rooms</Text>
                  </View>
                </Pressable>
                <NumberStepper
                  label={`Rooms on ${floorLabel(entry.floor)}`}
                  max={99}
                  onChange={(value) => setTargets((current) => ({ ...current, [entry.floor]: value }))}
                  value={targets[entry.floor] ?? String(entry.rooms.length)}
                />
              </View>
              {shut ? null : (
                <View className="flex-row flex-wrap justify-between gap-y-2">
                  {[...entry.rooms].sort(byNumber).map((room) => (
                    <RoomTile key={room.id} onLongPress={() => setSelected((current) => [...new Set([...current, room.id])])} onPress={() => pressTile(room)} room={room} selected={selected.includes(room.id)} />
                  ))}
                  {/* Keeps the last row's tiles their own width. */}
                  {Array.from({ length: (4 - (entry.rooms.length % 4)) % 4 }, (_, at) => <View className="w-[23%]" key={at} />)}
                </View>
              )}
            </Card>
          );
        })
      )}

      {floors.length ? <Button disabled={busy} icon="add" label="Add floor" onPress={addFloor} variant="outline" /> : null}

      <RoomSheet busy={busy} onClose={() => setOpen(null)} room={open} run={run} types={types} />

      <Sheet onClose={() => setSheet(null)} open={sheet === "type"} title="Set room type">
        <TypeChoice
          busy={busy}
          label={`Apply to ${chosen.length} rooms`}
          onApply={async (roomType) => {
            if (await retype(chosen, roomType)) {
              setSheet(null);
              setSelected([]);
            }
          }}
          types={types}
        />
      </Sheet>

      <RenumberSheet
        busy={busy}
        onClose={() => setSheet(null)}
        onApply={async (first) => {
          const numbers = renumber(first, chosen.length);
          const ok = await run(async () => {
            // ponytail: two passes so 101↔102 swaps never clash; a failure midway can leave a "~" number to fix by hand.
            for (const room of chosen) await updateRoom(room.id, { number: `~${room.number}` });
            let last: RoomLayout | undefined;
            for (const [at, room] of chosen.entries()) last = await updateRoom(room.id, { number: numbers[at] });
            return last;
          });
          if (ok) {
            setSheet(null);
            setSelected([]);
          }
        }}
        open={sheet === "renumber"}
        start={chosen[0]?.number ?? ""}
      />
    </View>
  );
}

/** "101" + 3 → 101, 102, 103, keeping any letters and the zero padding. */
function renumber(first: string, count: number) {
  const match = /^(.*?)(\d+)$/.exec(first.trim());
  if (!match) return Array.from({ length: count }, (_, at) => `${first.trim()}${at + 1}`);
  const [, prefix, digits] = match;
  return Array.from({ length: count }, (_, at) => `${prefix}${String(Number(digits) + at).padStart(digits.length, "0")}`);
}

function RoomTile({ onLongPress, onPress, room, selected }: { onLongPress: () => void; onPress: () => void; room: Room; selected: boolean }) {
  const { colors } = useAppTheme();
  const taken = room.beds - room.free;
  const full = room.free <= 0 && room.beds > 0 && taken > 0;

  return (
    <Pressable
      accessibilityLabel={`Room ${room.number}, ${room.roomType}, ${room.free} of ${room.beds} free`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`w-[23%] items-center gap-1 rounded-xl border-2 py-2.5 active:opacity-70 ${selected ? "border-primary bg-brand-soft" : full ? "border-destructive/40" : "border-border"}`}
      delayLongPress={300}
      onLongPress={onLongPress}
      onPress={onPress}
    >
      <Text className="font-bold text-foreground">{room.number}</Text>
      <View className="flex-row items-center gap-1">
        <Glyph color={selected ? colors.primary : colors.mutedForeground} name="bed" size={14} />
        <Text variant="caption">{room.beds}</Text>
      </View>
      {taken > 0 ? (
        <View className="h-1 w-3/4 overflow-hidden rounded-full bg-muted">
          <View className={`h-full rounded-full ${full ? "bg-destructive" : "bg-primary"}`} style={{ width: `${(taken / room.beds) * 100}%` }} />
        </View>
      ) : null}
      {selected ? (
        <View className="absolute -bottom-1.5 -right-1.5 rounded-full bg-background">
          <Glyph color={colors.primary} name="checkmark-circle" size={18} />
        </View>
      ) : null}
    </Pressable>
  );
}

function TypeChoice({ busy, label, onApply, types, value }: { busy: boolean; label: string; onApply: (roomType: string) => void; types: string[]; value?: string }) {
  const { colors } = useAppTheme();
  const [pick, setPick] = useState(value ?? types[0]);

  return (
    <View className="gap-2 pb-2">
      {types.map((roomType) => {
        const on = pick === roomType;
        const beds = bedsForRoomType(roomType);
        return (
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} className={`min-h-12 flex-row items-center gap-3 rounded-xl border px-3 ${on ? "border-primary bg-brand-soft" : "border-border"}`} key={roomType} onPress={() => setPick(roomType)}>
            <Glyph color={on ? colors.primary : colors.mutedForeground} name={on ? "radio-button-on" : "radio-button-off"} size={20} />
            <Text className="flex-1">{roomType} ({beds} {beds === 1 ? "bed" : "beds"})</Text>
          </Pressable>
        );
      })}
      <Button disabled={busy || !pick} label={label} loading={busy} onPress={() => pick && onApply(pick)} />
    </View>
  );
}

function RenumberSheet({ busy, onApply, onClose, open, start }: { busy: boolean; onApply: (first: string) => void; onClose: () => void; open: boolean; start: string }) {
  const [first, setFirst] = useState(start);
  const [seeded, setSeeded] = useState(false);

  if (open && !seeded) {
    setSeeded(true);
    setFirst(start);
  }
  if (!open && seeded) setSeeded(false);

  return (
    <Sheet footer={<Button disabled={busy || !first.trim()} label="Renumber" loading={busy} onPress={() => onApply(first)} />} onClose={onClose} open={open} title="Renumber">
      <Input hint="The rest follow in order" label="First number" onChangeText={setFirst} value={first} variant="line" />
    </Sheet>
  );
}

function RoomSheet({ busy, onClose, room, run, types }: { busy: boolean; onClose: () => void; room: Room | null; run: Run; types: string[] }) {
  const { colors } = useAppTheme();
  const [number, setNumber] = useState("");
  const [roomType, setRoomType] = useState("");
  const [forId, setForId] = useState<string | null>(null);

  if (room && forId !== room.id) {
    setForId(room.id);
    setNumber(room.number);
    setRoomType(room.roomType);
  }

  const taken = room ? room.beds - room.free : 0;
  const changed = room && (number.trim() !== room.number || roomType !== room.roomType);

  return (
    <Sheet
      footer={room ? (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              disabled={busy}
              icon="trash"
              label="Delete room"
              onPress={() => openConfirm({
                confirmLabel: "Delete",
                destructive: true,
                message: "Only an empty room can be removed.",
                onConfirm: async () => {
                  if (await run(() => deleteRoom(room.id))) onClose();
                },
                pin: true,
                title: `Delete Room ${room.number}?`,
              })}
              variant="outline"
            />
          </View>
          {changed ? (
            <View className="flex-1">
              <Button
                label="Save"
                loading={busy}
                onPress={async () => {
                  const ok = await run(() => updateRoom(room.id, {
                    ...(number.trim() !== room.number ? { number: number.trim() } : {}),
                    ...(roomType !== room.roomType ? { beds: bedsForRoomType(roomType), roomType } : {}),
                  }));
                  if (ok) onClose();
                }}
              />
            </View>
          ) : null}
        </View>
      ) : undefined}
      onClose={onClose}
      open={room !== null}
      title={room ? `Room ${room.number}` : "Room"}
    >
      {room ? (
        <View className="gap-4 pb-2">
          <Input label="Room no." onChangeText={setNumber} value={number} variant="line" />
          <View className="flex-row flex-wrap gap-2">
            {types.map((type) => (
              <Pressable accessibilityRole="radio" accessibilityState={{ checked: type === roomType }} className={`min-h-11 justify-center rounded-xl border px-3 ${type === roomType ? "border-primary bg-brand-soft" : "border-border"}`} key={type} onPress={() => setRoomType(type)}>
                <Text variant="label">{type}</Text>
              </Pressable>
            ))}
          </View>
          <View className="flex-row items-center gap-3">
            <Glyph color={colors.mutedForeground} name="bed" size={18} />
            <Text className="flex-1" variant="label">{bedsForRoomType(roomType)} beds</Text>
            <Text variant="caption">{taken} / {room.beds} taken</Text>
          </View>
          <View className="h-1.5 overflow-hidden rounded-full bg-muted">
            <View className="h-full rounded-full bg-primary" style={{ width: `${room.beds ? (taken / room.beds) * 100 : 0}%` }} />
          </View>
          {room.residents.length ? room.residents.map((person) => (
            <Pressable accessibilityRole="link" key={person.id} onPress={() => router.push(`/manage/resident/${person.id}`)}>
              <Text className="py-1 text-primary">{person.name}</Text>
            </Pressable>
          )) : <Text variant="caption">No residents yet</Text>}
        </View>
      ) : null}
    </Sheet>
  );
}

/** Not floor-wise: how many rooms of each type. A stepped count saves once it settles. */
function TypeCounts({ busy, run, types }: { busy: boolean; run: Run; types: ManagedHostel["roomConfigurations"] }) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const latest = useRef({ run, types });
  useEffect(() => {
    latest.current = { run, types };
  });

  useEffect(() => {
    if (!Object.keys(counts).length) return;
    const timer = setTimeout(() => {
      const typed = counts;
      setCounts({});
      void latest.current.run(async () => {
        await updateManagedHostel({
          roomConfigurations: latest.current.types.map((type) => {
            if (typed[type.roomType] === undefined) return type;
            const rooms = Number(typed[type.roomType]) || 0;
            const bedsPerRoom = bedsForRoomType(type.roomType);
            // Beds already taken stay taken; the rest are free.
            const taken = Math.max(0, type.rooms * type.bedsPerRoom - type.vacantBeds);
            return { ...type, bedsPerRoom, rooms, vacantBeds: Math.max(0, rooms * bedsPerRoom - taken) };
          }),
        });
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [counts]);

  return (
    <Card className="gap-4">
      {types.map((type) => {
        const beds = bedsForRoomType(type.roomType);
        const value = counts[type.roomType] ?? String(type.rooms);
        return (
          <View className="flex-row items-center gap-3" key={type.roomType}>
            <View className="flex-1">
              <Text variant="label">{type.roomType}</Text>
              <Text variant="caption">{beds} {beds === 1 ? "bed" : "beds"} each · {(Number(value) || 0) * beds} beds</Text>
            </View>
            <View pointerEvents={busy ? "none" : "auto"}>
              <NumberStepper label={`${type.roomType} rooms`} max={999} onChange={(next) => setCounts((current) => ({ ...current, [type.roomType]: next }))} value={value} />
            </View>
          </View>
        );
      })}
    </Card>
  );
}
