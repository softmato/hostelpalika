import { bedsForRoomType, roomTypeLabel } from "@hostel/constants/room-types";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { NumberStepper } from "@/components/step-flow";
import { ActionTiles } from "@/components/ui/action-grid";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/layout";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { type ManagedHostel, updateManagedHostel } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import {
  addRooms,
  byFloor,
  deleteRoom,
  floorLabel,
  getRoomLayout,
  orderRooms,
  type Room,
  type RoomLayout,
  roomsQuery,
  setRoomTracking,
  updateRoom,
} from "@/lib/rooms-api";
import { toastError, toastInfo } from "@/lib/toast";

type Mode = "floor" | "type";

/** Rooms added or removed this pass, shown before the server answers (field review B4). */
type Draft = { adds: Room[]; removes: string[] };

const NO_DRAFT: Draft = { adds: [], removes: [] };

const byNumber = (a: Room, b: Room) => a.number.localeCompare(b.number, undefined, { numeric: true });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const sum = (rooms: Room[], pick: (room: Room) => number) => rooms.reduce((total, room) => total + pick(room), 0);
const fade = { in: FadeIn.duration(220).reduceMotion(ReduceMotion.System), out: FadeOut.duration(180).reduceMotion(ReduceMotion.System) };

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
 * Rooms & floors (field review 2026-10-27, B2–B5). Floor-wise: floors are
 * tiles, the picked floor's rooms are tiles, and a type chip arms + and − for
 * that type on that floor. A + or − shows at once and saves in order behind
 * it; the layout the server answers replaces the draft when the last one lands.
 * Not floor-wise: a room count per type. KYC and Settings share this unchanged.
 */
export function RoomsFloorsEditor({ onChanged }: { onChanged?: () => Promise<void> | void }) {
  const layoutQuery = roomsQuery.layout();
  const layout = useResource<RoomLayout>(layoutQuery.load, { cacheKey: layoutQuery.key, topics: layoutQuery.topics });
  const hostelQuery = adminQuery.managedHostel();
  const hostel = useResource<ManagedHostel>(hostelQuery.load, { cacheKey: hostelQuery.key, topics: hostelQuery.topics });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(NO_DRAFT);
  const [fresh, setFresh] = useState<string[]>([]);

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

  // One save at a time, each from the layout the one before it returned.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const waiting = useRef(0);
  const failed = useRef(false);
  const answered = useRef<RoomLayout | null>(null);
  const claimed = useRef<string[]>([]);
  const latest = useRef({ data: layout.data, layout, onChanged });
  useEffect(() => {
    latest.current = { data: layout.data, layout, onChanged };
  });

  const enqueue = useCallback((work: (current: RoomLayout) => Promise<RoomLayout | void>) => {
    waiting.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        const base = answered.current ?? latest.current.data;
        const next = base ? await work(base) : undefined;
        if (next) answered.current = next;
      } catch (error) {
        failed.current = true;
        toastError("Not saved", readApiError(error));
      } finally {
        waiting.current -= 1;
        if (waiting.current === 0) {
          const next = answered.current;
          answered.current = null;
          claimed.current = [];
          if (failed.current || !next) {
            failed.current = false;
            await latest.current.layout.refresh();
          } else {
            latest.current.layout.setData(() => next);
          }
          setDraft(NO_DRAFT);
          void latest.current.onChanged?.();
        }
      }
    });
  }, []);

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
  const onServer = new Set(data.rooms.map((room) => room.number));
  const added = draft.adds.filter((room) => !onServer.has(room.number) && !draft.removes.includes(room.number));
  const gone = data.rooms.filter((room) => draft.removes.includes(room.number));
  const rooms = [...data.rooms.filter((room) => !draft.removes.includes(room.number)), ...added];
  const base = data.totals ?? { beds: sum(data.rooms, (room) => room.beds), free: sum(data.rooms, (room) => room.free), rooms: data.rooms.length };
  const totals = {
    beds: base.beds + sum(added, (room) => room.beds) - sum(gone, (room) => room.beds),
    free: base.free + sum(added, (room) => room.beds) - sum(gone, (room) => room.free),
    rooms: base.rooms + added.length - gone.length,
  };

  const addOne = (floor: number, roomType: string) => {
    const [number] = nextRoomNumbers(floor, [...rooms.map((room) => room.number), ...draft.removes, ...claimed.current], 1);
    if (!number) return;
    claimed.current = [...claimed.current, number];
    const beds = bedsForRoomType(roomType);
    setDraft((current) => ({ ...current, adds: [...current.adds, { beds, floor, free: beds, id: `new:${number}`, number, residents: [], roomType }] }));
    setFresh((current) => [...current, number]);
    enqueue(() => addRooms({ beds, floor, numbers: [number], roomType }));
  };

  const removeOne = (floor: number, roomType: string) => {
    const last = rooms
      .filter((room) => room.floor === floor && room.roomType === roomType && room.residents.length === 0)
      .sort(byNumber)
      .at(-1);
    if (!last) {
      toastInfo("Nothing to remove", `No empty ${roomTypeLabel(roomType)} on the ${floorLabel(floor).toLowerCase()}.`);
      return;
    }
    setDraft((current) => ({ adds: current.adds.filter((room) => room.number !== last.number), removes: [...current.removes, last.number] }));
    enqueue(async (current) => {
      // A room added a moment ago has its real id only in the layout that answered it.
      const room = current.rooms.find((item) => item.number === last.number);
      return room ? deleteRoom(room.id) : undefined;
    });
  };

  return (
    <View className="gap-4">
      <Button icon="pricetags" label="Room types" onPress={() => router.push("/manage/rooms")} variant="outline" />
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
        <FloorPlan
          busy={busy}
          fresh={fresh}
          onAdd={addOne}
          onRemove={removeOne}
          rooms={rooms}
          run={run}
          types={types.map((type) => type.roomType)}
        />
      ) : (
        <TypeCounts busy={busy} run={run} types={types} />
      )}
    </View>
  );
}

type Run = (work: () => Promise<RoomLayout | void>) => Promise<boolean>;

/** "Ground", "1st", "Basement" — a floor tile's first line. */
const shortFloor = (floor: number) => floorLabel(floor).replace(/ floor$/, "");

function FloorPlan({
  busy,
  fresh,
  onAdd,
  onRemove,
  rooms,
  run,
  types,
}: {
  busy: boolean;
  fresh: string[];
  onAdd: (floor: number, roomType: string) => void;
  onRemove: (floor: number, roomType: string) => void;
  rooms: Room[];
  run: Run;
  types: string[];
}) {
  const { colors } = useAppTheme();
  const floors = byFloor(rooms);
  const [floorPick, setFloorPick] = useState<number | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [openNumber, setOpenNumber] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"type" | "renumber" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [order, setOrder] = useState<{ floor: number; ids: string[] } | null>(null);
  const spots = useRef(new Map<string, { height: number; width: number; x: number; y: number }>());
  const taken = rooms.map((room) => room.number);
  const current = floors.find((entry) => entry.floor === floorPick) ?? floors[0];
  const open = rooms.find((room) => room.number === openNumber) ?? null;

  const addFloor = () => {
    if (busy) return;
    const above = floors.at(-1);
    const floor = above ? above.floor + 1 : 0;
    // A new floor copies the one above it; the first starts with one room.
    const plan = above ? [...above.rooms].sort(byNumber).map((room) => room.roomType) : [chip ?? types[0]];
    void run(async () => {
      const numbers = nextRoomNumbers(floor, taken, plan.length);
      let last: RoomLayout | undefined;
      for (const roomType of [...new Set(plan)]) {
        last = await addRooms({ beds: bedsForRoomType(roomType), floor, numbers: numbers.filter((_, at) => plan[at] === roomType), roomType });
      }
      return last;
    }).then((ok) => ok && setFloorPick(floor));
  };

  const retype = (list: Room[], roomType: string) =>
    run(async () => {
      let last: RoomLayout | undefined;
      for (const room of list.filter((item) => item.roomType !== roomType)) last = await updateRoom(room.id, { beds: bedsForRoomType(roomType), roomType });
      return last;
    });

  const pressTile = (room: Room) => {
    if (selected.length) setSelected((list) => (list.includes(room.id) ? list.filter((id) => id !== room.id) : [...list, room.id]));
    else setOpenNumber(room.number);
  };

  // A long press that never moves still selects, as it always did.
  const pressSelect = (id: string) => setSelected((list) => [...new Set([...list, id])]);

  const chosen = rooms.filter((room) => selected.includes(room.id)).sort(byNumber);

  if (!current) {
    return <EmptyCard action={<Button disabled={busy} icon="add" label="Add ground floor" onPress={addFloor} />} title="No floors added yet" />;
  }

  // The server sends each floor in the owner's dragged order; a drop shows at once, before the save returns.
  const onFloor = order?.floor === current.floor ? [...current.rooms].sort((a, b) => order.ids.indexOf(a.id) - order.ids.indexOf(b.id)) : current.rooms;
  const hitTile = (id: string, dx: number, dy: number) => {
    const from = spots.current.get(id);
    if (!from) return null;
    const cx = from.x + from.width / 2 + dx;
    const cy = from.y + from.height / 2 + dy;
    return onFloor.find((room) => {
      const spot = spots.current.get(room.id);
      return room.id !== id && spot && cx >= spot.x && cx <= spot.x + spot.width && cy >= spot.y && cy <= spot.y + spot.height;
    })?.id ?? null;
  };
  const dropOn = (id: string, dx: number, dy: number, moved: boolean) => {
    setOverId(null);
    setDragId(null);
    if (!moved) {
      pressSelect(id);
      return;
    }
    const target = hitTile(id, dx, dy);
    if (!target) return;
    const ids = onFloor.map((room) => room.id).filter((roomId) => roomId !== id);
    ids.splice(onFloor.findIndex((room) => room.id === target), 0, id);
    const real = ids.filter((roomId) => !roomId.startsWith("new:"));
    setOrder({ floor: current.floor, ids });
    void run(() => orderRooms(current.floor, real)).then(() => setOrder(null));
  };
  const ofChip = chip ? onFloor.filter((room) => room.roomType === chip).length : 0;

  return (
    <View className="gap-4">
      <ActionTiles
        tiles={[
          ...floors.map((entry) => ({
            glyph: colors.primary,
            icon: "floor" as const,
            key: `floor:${entry.floor}`,
            label: `${shortFloor(entry.floor)}\n${plural(entry.rooms.length, "room")}`,
            onPress: () => setFloorPick(entry.floor),
            selected: entry.floor === current.floor,
            tone: "brand" as const,
          })),
          { glyph: colors.primary, icon: "add" as const, key: "floor:add", label: "Add floor", onPress: addFloor, tone: "brand" as const },
        ]}
      />

      <Card className="gap-3">
        <View>
          <Text variant="label">{floorLabel(current.floor)}</Text>
          <Text variant="caption">
            {plural(onFloor.length, "room")} · {plural(sum(onFloor, (room) => room.beds), "bed")} · {sum(onFloor, (room) => room.free)} free
          </Text>
        </View>

        {selected.length ? (
          <View className="gap-3">
            <View className="flex-row items-center">
              <Text className="flex-1" variant="label">{plural(selected.length, "room")} selected</Text>
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
                  title: `Remove ${plural(chosen.length, "room")}?`,
                })],
              ] as const).map(([icon, label, onPress]) => (
                <Pressable accessibilityRole="button" className="min-h-14 flex-1 items-center justify-center gap-1 rounded-xl border border-border active:opacity-70" disabled={busy} key={label} onPress={onPress}>
                  <Glyph color={icon === "trash" ? colors.destructive : colors.foreground} name={icon} size={20} />
                  <Text variant="caption">{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <View className="flex-row flex-wrap gap-2">
            {types.map((roomType) => {
              const on = chip === roomType;
              const beds = bedsForRoomType(roomType);
              return (
                <Pressable
                  accessibilityLabel={`${on ? "Stop adding" : "Add or remove"} ${roomTypeLabel(roomType)}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  className={`min-h-12 justify-center rounded-xl border px-3 py-1.5 active:opacity-70 ${on ? "border-primary bg-primary" : "border-border bg-card"}`}
                  key={roomType}
                  // Tapping the picked chip again puts it down; another chip switches.
                  onPress={() => setChip(on ? null : roomType)}
                >
                  <Text className={on ? "font-semibold text-primary-foreground" : "font-semibold text-foreground"} numberOfLines={1}>
                    {roomTypeLabel(roomType).replace(" — Attached Bathroom", " + bath")}
                  </Text>
                  <Text className={on ? "text-xs text-primary-foreground" : "text-xs text-muted-foreground"}>{plural(beds, "bed")}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {chip && !selected.length ? (
          <Animated.View className="flex-row items-center gap-3 rounded-2xl bg-brand-soft px-3 py-2" entering={fade.in} exiting={fade.out}>
            <IconButton label={`Remove an empty ${roomTypeLabel(chip)}`} name="remove" onPress={() => onRemove(current.floor, chip)} />
            <View className="flex-1 items-center">
              <Text className="text-lg font-bold text-foreground">{ofChip}</Text>
              <Text numberOfLines={1} variant="caption">{roomTypeLabel(chip)}</Text>
            </View>
            <IconButton label={`Add a ${roomTypeLabel(chip)}`} name="add" onPress={() => onAdd(current.floor, chip)} />
          </Animated.View>
        ) : null}

        <GestureHandlerRootView className="flex-row flex-wrap justify-between gap-y-2">
          {onFloor.map((room) => {
            const isNew = fresh.includes(room.number);
            return (
              <Animated.View
                className="w-[23%]"
                entering={isNew ? fade.in : undefined}
                exiting={fade.out}
                key={room.number}
                onLayout={(event) => spots.current.set(room.id, event.nativeEvent.layout)}
                style={{ zIndex: dragId === room.id ? 10 : 0 }}
              >
                <DragTile
                  enabled={!busy && !room.id.startsWith("new:")}
                  id={room.id}
                  onDrag={(id, dx, dy) => {
                    const next = hitTile(id, dx, dy);
                    setOverId((was) => (was === next ? was : next));
                  }}
                  onDrop={dropOn}
                  onLift={setDragId}
                  over={overId === room.id}
                >
                  <RoomTile
                    fresh={isNew}
                    onPress={() => !room.id.startsWith("new:") && pressTile(room)}
                    room={room}
                    selected={selected.includes(room.id)}
                  />
                </DragTile>
              </Animated.View>
            );
          })}
          {/* Keeps the last row's tiles their own width. */}
          {Array.from({ length: (4 - (onFloor.length % 4)) % 4 }, (_, at) => <View className="w-[23%]" key={`gap:${at}`} />)}
        </GestureHandlerRootView>
      </Card>

      <RoomSheet busy={busy} onClose={() => setOpenNumber(null)} room={open} run={run} types={types} />

      <Sheet onClose={() => setSheet(null)} open={sheet === "type"} title="Set room type">
        <TypeChoice
          busy={busy}
          label={`Apply to ${plural(chosen.length, "room")}`}
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

/**
 * Hold a tile and it lifts out of the grid; drag it over another room and let go
 * to put it there. Letting go without moving selects it. The order is saved per floor.
 */
function DragTile({
  children,
  enabled,
  id,
  onDrag,
  onDrop,
  onLift,
  over,
}: {
  children: React.ReactNode;
  enabled: boolean;
  id: string;
  onDrag: (id: string, dx: number, dy: number) => void;
  onDrop: (id: string, dx: number, dy: number, moved: boolean) => void;
  onLift: (id: string) => void;
  over: boolean;
}) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const lift = useSharedValue(0);

  const pan = Gesture.Pan()
    .enabled(enabled)
    .activateAfterLongPress(300)
    .onStart(() => {
      lift.value = withTiming(1, { duration: 120 });
      runOnJS(onLift)(id);
    })
    .onUpdate((event) => {
      x.value = event.translationX;
      y.value = event.translationY;
      runOnJS(onDrag)(id, event.translationX, event.translationY);
    })
    .onEnd((event) => {
      runOnJS(onDrop)(id, event.translationX, event.translationY, Math.abs(event.translationX) > 10 || Math.abs(event.translationY) > 10);
    })
    .onFinalize(() => {
      x.value = withSpring(0, { damping: 18, stiffness: 220 });
      y.value = withSpring(0, { damping: 18, stiffness: 220 });
      lift.value = withTiming(0, { duration: 160 });
    });

  const style = useAnimatedStyle(() => ({
    elevation: lift.value * 8,
    shadowColor: "#000",
    shadowOffset: { height: 6, width: 0 },
    shadowOpacity: lift.value * 0.25,
    shadowRadius: 10,
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: 1 + lift.value * 0.08 }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[style, over ? { opacity: 0.55 } : null]}>{children}</Animated.View>
    </GestureDetector>
  );
}

/** A room; one added this pass has a dashed brand edge until the screen is left. */
function RoomTile({ fresh, onPress, room, selected }: { fresh: boolean; onPress: () => void; room: Room; selected: boolean }) {
  const { colors } = useAppTheme();
  const taken = room.beds - room.free;
  const full = room.free <= 0 && room.beds > 0 && taken > 0;

  return (
    <Pressable
      accessibilityLabel={`Room ${room.number}, ${roomTypeLabel(room.roomType)}, ${room.free} of ${room.beds} free${fresh ? ", just added" : ""}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`w-full items-center gap-1 rounded-xl border-2 py-2.5 active:opacity-70 ${
        selected ? "border-primary bg-brand-soft" : fresh ? "border-dashed border-primary bg-brand-soft" : full ? "border-destructive/40" : "border-border"
      }`}
      onPress={onPress}
    >
      <Text className="font-bold text-foreground">{room.number}</Text>
      <View className="flex-row items-center gap-1">
        <Glyph color={selected || fresh ? colors.primary : colors.mutedForeground} name="bed" size={14} />
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
        return (
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} className={`min-h-12 flex-row items-center gap-3 rounded-xl border px-3 ${on ? "border-primary bg-brand-soft" : "border-border"}`} key={roomType} onPress={() => setPick(roomType)}>
            <Glyph color={on ? colors.primary : colors.mutedForeground} name={on ? "radio-button-on" : "radio-button-off"} size={20} />
            <Text className="flex-1">{roomTypeLabel(roomType)} ({plural(bedsForRoomType(roomType), "bed")})</Text>
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

/**
 * One room (B5): its beds, who sleeps in them, and its number and type. An
 * occupied room takes only a type with a bed for everyone in it — the server
 * holds the same line (B6).
 */
function RoomSheet({ busy, onClose, room, run, types }: { busy: boolean; onClose: () => void; room: Room | null; run: Run; types: string[] }) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const [number, setNumber] = useState("");
  const [roomType, setRoomType] = useState("");
  const [forId, setForId] = useState<string | null>(null);

  if (room && forId !== room.id) {
    setForId(room.id);
    setNumber(room.number);
    setRoomType(room.roomType);
  }

  const living = room?.residents.length ?? 0;
  const changed = room && (number.trim() !== room.number || roomType !== room.roomType);

  return (
    <Sheet
      footer={room ? (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              disabled={busy || living > 0}
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
        <View className="gap-5 pb-2">
          <View className="gap-2">
            {/* A mark per bed: taken ones filled, free ones in the brand colour. */}
            <View className="flex-row flex-wrap gap-2">
              {Array.from({ length: room.beds }, (_, at) => (
                <View className={`h-11 w-11 items-center justify-center rounded-xl ${at < living ? "bg-muted" : "bg-brand-soft"}`} key={at}>
                  <Glyph color={at < living ? colors.mutedForeground : colors.primary} name="bed" size={20} variant={at < living ? "solid" : "line"} />
                </View>
              ))}
            </View>
            <Text variant="caption">
              {room.free > 0 ? `${room.free} of ${plural(room.beds, "bed")} free` : "Full"} · {roomTypeLabel(room.roomType)} · {floorLabel(room.floor)}
            </Text>
          </View>

          <View className="gap-1">
            <Text variant="label">Living here</Text>
            {room.residents.length ? room.residents.map((person) => (
              <Pressable
                accessibilityRole="link"
                className="min-h-14 flex-row items-center gap-3 active:opacity-70"
                key={person.id}
                onPress={() => {
                  onClose();
                  router.push(`/manage/resident/${person.id}`);
                }}
              >
                <PersonAvatar image={person.photo} name={person.name} size="md" />
                <View className="flex-1">
                  <Text className="font-semibold text-foreground" numberOfLines={1}>{person.name}</Text>
                  {person.since ? <Text variant="caption">Since {dates.date(person.since)}</Text> : null}
                </View>
                {person.due === undefined ? null : person.due > 0 ? (
                  <Badge label={`${formatMoney(person.due)} due`} tone="warning" />
                ) : (
                  <Badge label="Paid up" tone="success" />
                )}
                <Glyph color={colors.mutedForeground} name="chevron-forward" size={16} />
              </Pressable>
            )) : <Text variant="caption">Nobody lives here yet.</Text>}
          </View>

          <Input label="Room no." onChangeText={setNumber} value={number} variant="line" />
          <View className="gap-2">
            <Text variant="label">Room type</Text>
            <View className="flex-row flex-wrap gap-2">
              {types.map((type) => {
                const fits = bedsForRoomType(type) >= living;
                const on = type === roomType;
                return (
                  <Pressable
                    accessibilityLabel={fits ? roomTypeLabel(type) : `${roomTypeLabel(type)}, too few beds for ${living}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on, disabled: !fits }}
                    className={`min-h-11 justify-center rounded-xl border px-3 ${on ? "border-primary bg-brand-soft" : "border-border"} ${fits ? "" : "opacity-40"}`}
                    disabled={!fits}
                    key={type}
                    onPress={() => setRoomType(type)}
                  >
                    <Text variant="label">{roomTypeLabel(type)}</Text>
                  </Pressable>
                );
              })}
            </View>
            {living > 0 && roomType !== room.roomType ? <Text variant="caption">Rent follows the new type from the next bill.</Text> : null}
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

/** Not floor-wise (B7): how many rooms of each type, nothing more. A stepped count saves once it settles. */
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
        // The totals above the list come from the layout, so it is reread here.
        return getRoomLayout();
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
              <Text variant="label">{roomTypeLabel(type.roomType)}</Text>
              <Text variant="caption">{plural(beds, "bed")} each · {plural((Number(value) || 0) * beds, "bed")}</Text>
            </View>
            <View pointerEvents={busy ? "none" : "auto"}>
              <NumberStepper label={`${roomTypeLabel(type.roomType)} rooms`} max={999} onChange={(next) => setCounts((current) => ({ ...current, [type.roomType]: next }))} value={value} />
            </View>
          </View>
        );
      })}
    </Card>
  );
}
