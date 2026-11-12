import { bedsForRoomType, roomTypeLabel } from "@hostel/constants/room-types";
import { router } from "expo-router";
import { memo, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
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
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Meter } from "@/components/ui/meter";
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
import { bedsClaimed, firstFloorMoves, floorLeavers } from "@/lib/floor-moves";
import { formatMoney } from "@/lib/format";
import {
  addRooms,
  byFloor,
  deleteRoom,
  deleteRooms,
  renameFloor,
  floorLabel,
  getRoomLayout,
  orderRooms,
  type Room,
  type RoomLayout,
  roomsQuery,
  setResidentRoom,
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
  const rooms = [...data.rooms.filter((room) => !draft.removes.includes(room.number)), ...added];

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
      <Segmented<Mode>
        onChange={(next) => next !== mode && void run(() => setRoomTracking(next === "floor"))}
        options={[
          { label: "Floor-wise", value: "floor" },
          { label: "Not floor-wise", value: "type" },
        ]}
        value={mode}
      />
      {types.length === 0 ? (
        <EmptyCard description="Add room types first." title="No room types" />
      ) : mode === "floor" ? (
        <FloorPlan
          busy={busy}
          floorNames={data.floorNames}
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
/** The owner's name for a floor, else the ordinal. */
const floorTitle = (floor: number, names?: Record<string, string>) => names?.[String(floor)] || floorLabel(floor);
const shortTitle = (floor: number, names?: Record<string, string>) => names?.[String(floor)] || shortFloor(floor);
const beds = (rooms: Room[]) => sum(rooms, (room) => room.beds);
const filled = (rooms: Room[]) => sum(rooms, (room) => room.beds - room.free);
const share = (rooms: Room[]) => (beds(rooms) ? Math.round((filled(rooms) / beds(rooms)) * 100) : 0);
/** A floor (or any rooms) somebody lives on: it cannot be removed without moving them. */
const lived = (rooms: Room[]) => rooms.some((room) => room.residents.length > 0);

type PillProps = {
  filledBeds: number;
  floor: number;
  hasPeople: boolean;
  on: boolean;
  onLongPress: (floor: number, hasPeople: boolean) => void;
  onPress: (floor: number, hasPeople: boolean) => void;
  picked: boolean;
  picking: boolean;
  rooms: number;
  sharePct: number;
  title: string;
  totalBeds: number;
};

/** Primitive props only, so a tap re-renders the two pills that changed, not all of them. */
const FloorPill = memo(function FloorPill({ filledBeds, floor, hasPeople, on, onLongPress, onPress, picked, picking, rooms, sharePct, title, totalBeds }: PillProps) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      accessibilityLabel={`${title}, ${plural(rooms, "room")}, ${hasPeople ? `${filledBeds} of ${totalBeds} beds filled` : "empty"}`}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      className={`w-24 gap-1.5 rounded-2xl border px-3 py-2.5 active:opacity-70 ${on ? "border-primary bg-brand-soft" : "border-border bg-card"} ${picking && hasPeople ? "opacity-40" : ""}`}
      onLongPress={() => onLongPress(floor, hasPeople)}
      onPress={() => onPress(floor, hasPeople)}
    >
      <View className="flex-row items-center justify-between">
        <Text className={`text-sm font-semibold ${on ? "text-primary" : "text-foreground"}`} numberOfLines={1} variant={null}>{title}</Text>
        {picking && !hasPeople ? (
          <Glyph color={picked ? colors.primary : colors.mutedForeground} name={picked ? "checkmark-circle" : "radio-button-off"} size={16} />
        ) : null}
      </View>
      <Text className="text-xs text-muted-foreground" numberOfLines={1} variant={null}>
        {hasPeople ? `${filledBeds}/${totalBeds} beds` : "Empty"}
      </Text>
      <Meter height={3} label={null} percent={sharePct} reading="share" />
    </Pressable>
  );
});

function FloorPlan({
  busy,
  floorNames,
  fresh,
  onAdd,
  onRemove,
  rooms,
  run,
  types,
}: {
  busy: boolean;
  floorNames?: Record<string, string>;
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
  /** Floors ticked for removal together; null when not picking. */
  const [floorPicks, setFloorPicks] = useState<number[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [openNumber, setOpenNumber] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"name" | "type" | "renumber" | "rooms" | null>(null);
  const [leavingFloor, setLeavingFloor] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [order, setOrder] = useState<{ floor: number; ids: string[] } | null>(null);
  const floorStrip = useRef<ScrollView>(null);
  const spots = useRef(new Map<string, { height: number; width: number; x: number; y: number }>());
  const taken = rooms.map((room) => room.number);
  // The pills follow the tap at once; the floor's rooms below catch up a frame later.
  const shownFloor = useDeferredValue(floorPick);
  const current = floors.find((entry) => entry.floor === shownFloor) ?? floors[0];
  const pickedFloor = floorPick ?? floors[0]?.floor;
  const open = rooms.find((room) => room.number === openNumber) ?? null;

  const addFloor = () => {
    if (busy) return;
    const above = floors.at(-1);
    const floor = above ? above.floor + 1 : 0;
    // A new floor copies the one above it; the first starts with one room.
    const plan = above ? [...above.rooms].sort(byNumber).map((room) => room.roomType) : [types[0]];
    void run(async () => {
      const numbers = nextRoomNumbers(floor, taken, plan.length);
      let last: RoomLayout | undefined;
      for (const roomType of [...new Set(plan)]) {
        last = await addRooms({ beds: bedsForRoomType(roomType), floor, numbers: numbers.filter((_, at) => plan[at] === roomType), roomType });
      }
      return last;
    }).then((ok) => {
      if (!ok) return;
      setFloorPick(floor);
      setTimeout(() => floorStrip.current?.scrollToEnd({ animated: true }), 120);
    });
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

  /**
   * Empty floors go together after one confirm and one PIN; a lived-in floor
   * goes alone, through the move sheet first (web parity).
   */
  const removeFloors = (picked: number[]) => {
    const list = rooms.filter((room) => picked.includes(room.floor) && !room.id.startsWith("new:"));
    const one = picked.length === 1;
    if (one && lived(list)) {
      setLeavingFloor(picked[0]);
      return;
    }
    openConfirm({
      confirmLabel: one ? "Remove floor" : "Remove floors",
      destructive: true,
      message: `${plural(list.length, "empty room")} ${list.length === 1 ? "goes" : "go"} with ${one ? "it" : "them"}.`,
      onConfirm: async () => {
        const ok = await run(() => deleteRooms(list.map((room) => room.id)));
        if (ok) {
          setFloorPick(null);
          setFloorPicks(null);
        }
      },
      pin: true,
      title: `Remove ${one ? floorTitle(picked[0], floorNames) : plural(picked.length, "floor")}?`,
    });
  };

  const pressFloor = useCallback((floor: number, hasPeople: boolean) => {
    if (!floorPicks) setFloorPick(floor);
    else if (hasPeople) toastInfo("Residents live here", "Remove this floor on its own to move them first.");
    else setFloorPicks(floorPicks.includes(floor) ? floorPicks.filter((item) => item !== floor) : [...floorPicks, floor]);
  }, [floorPicks]);
  const longPressFloor = useCallback((floor: number, hasPeople: boolean) => {
    if (!floorPicks && !hasPeople) setFloorPicks([floor]);
  }, [floorPicks]);

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

  return (
    <View className="gap-4">
      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text variant="label">{floorPicks ? `${plural(floorPicks.length, "floor")} selected` : "Floors"}</Text>
          {floorPicks || floors.some((entry) => !lived(entry.rooms)) ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setFloorPicks(floorPicks ? null : [])}>
              <Text className="text-sm font-semibold text-primary" variant={null}>{floorPicks ? "Cancel" : "Select"}</Text>
            </Pressable>
          ) : null}
        </View>
        <ScrollView
          contentContainerStyle={{ gap: 8, paddingRight: 8 }}
          horizontal
          ref={floorStrip}
          showsHorizontalScrollIndicator={false}
        >
          {floors.map((entry) => {
            const hasPeople = lived(entry.rooms);
            const picked = floorPicks?.includes(entry.floor) ?? false;
            return (
              <FloorPill
                filledBeds={filled(entry.rooms)}
                floor={entry.floor}
                hasPeople={hasPeople}
                key={entry.floor}
                on={floorPicks ? picked : entry.floor === pickedFloor}
                onLongPress={longPressFloor}
                onPress={pressFloor}
                picked={picked}
                picking={floorPicks !== null}
                rooms={entry.rooms.length}
                sharePct={share(entry.rooms)}
                title={shortTitle(entry.floor, floorNames)}
                totalBeds={beds(entry.rooms)}
              />
            );
          })}
          {floorPicks ? null : (
            <Pressable
              accessibilityLabel="Add floor"
              accessibilityRole="button"
              className="w-14 items-center justify-center rounded-2xl border border-dashed border-primary bg-brand-soft active:opacity-70"
              onPress={addFloor}
            >
              <Glyph color={colors.primary} name="add" size={20} />
            </Pressable>
          )}
        </ScrollView>
        {floorPicks ? (
          <Button
            disabled={busy || floorPicks.length === 0}
            icon="trash"
            label={floorPicks.length ? `Remove ${plural(floorPicks.length, "floor")}` : "Pick empty floors"}
            onPress={() => removeFloors(floorPicks)}
            variant="danger"
          />
        ) : null}
      </View>

      <Card className="gap-3">
        <View className="flex-row items-center gap-1">
          <View className="flex-1">
            <Text variant="label">{floorTitle(current.floor, floorNames)}</Text>
            <Text variant="caption">
              {plural(onFloor.length, "room")} · {lived(onFloor) ? `${filled(onFloor)} of ${plural(beds(onFloor), "bed")} filled` : `${plural(beds(onFloor), "bed")}, all empty`}
            </Text>
          </View>
          {selected.length ? null : (
            <>
              <IconButton label={`Rename ${floorTitle(current.floor, floorNames)}`} name="create" onPress={() => setSheet("name")} />
              <IconButton label={`Add or remove rooms on ${floorTitle(current.floor, floorNames)}`} name="add" onPress={() => setSheet("rooms")} />
              <IconButton label={`Remove ${floorTitle(current.floor, floorNames)}`} name="trash" onPress={() => !busy && removeFloors([current.floor])} />
            </>
          )}
        </View>
        <Meter height={6} label={null} percent={share(onFloor)} reading="share" />

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
                    if (await run(() => deleteRooms(chosen.map((room) => room.id)))) setSelected([]);
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
        ) : null}


        <GestureHandlerRootView style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 8 }}>
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

      {/* One row per type: − count +. The type is named here once, not on the card. */}
      <Sheet onClose={() => setSheet(null)} open={sheet === "rooms"} title={`Rooms on ${floorTitle(current.floor, floorNames)}`}>
        <View className="gap-1 pb-2">
          {types.map((roomType) => (
            <View className="min-h-14 flex-row items-center gap-2" key={roomType}>
              <View className="flex-1">
                <Text numberOfLines={1} variant="label">{roomTypeLabel(roomType).replace(" — Attached Bathroom", " + bath")}</Text>
                <Text variant="caption">{plural(bedsForRoomType(roomType), "bed")}</Text>
              </View>
              <IconButton label={`Remove an empty ${roomTypeLabel(roomType)}`} name="remove" onPress={() => onRemove(current.floor, roomType)} />
              <Text className="w-8 text-center text-lg font-bold text-foreground" variant={null}>
                {onFloor.filter((room) => room.roomType === roomType).length}
              </Text>
              <IconButton label={`Add a ${roomTypeLabel(roomType)}`} name="add" onPress={() => onAdd(current.floor, roomType)} />
            </View>
          ))}
        </View>
      </Sheet>

      {leavingFloor === null ? null : (
        <MoveOffSheet
          busy={busy}
          floor={leavingFloor}
          onClose={() => setLeavingFloor(null)}
          onConfirm={(moves) => openConfirm({
            confirmLabel: "Move and remove",
            destructive: true,
            message: `${plural(moves.length, "resident")} move, then the floor and its rooms are removed.`,
            onConfirm: async () => {
              const floor = leavingFloor;
              const ok = await run(async () => {
                // One at a time: each move reads the room's free beds as the one before left them.
                for (const move of moves) await setResidentRoom(move.residentId, move.roomId);
                return deleteRooms(rooms.filter((item) => item.floor === floor && !item.id.startsWith("new:")).map((item) => item.id));
              });
              if (ok) {
                setLeavingFloor(null);
                setFloorPick(null);
              }
            },
            pin: true,
            title: `Remove ${floorLabel(leavingFloor).toLowerCase()}?`,
          })}
          rooms={rooms.filter((room) => !room.id.startsWith("new:"))}
        />
      )}

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

      <FloorNameSheet
        busy={busy}
        floor={current.floor}
        name={floorNames?.[String(current.floor)] ?? ""}
        onApply={async (name) => {
          if (await run(() => renameFloor(current.floor, name))) setSheet(null);
        }}
        onClose={() => setSheet(null)}
        open={sheet === "name"}
      />

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

/** Emptying a lived-in floor: every resident gets a free bed of their room type on another floor first. */
function MoveOffSheet({
  busy,
  floor,
  onClose,
  onConfirm,
  rooms,
}: {
  busy: boolean;
  floor: number;
  onClose: () => void;
  onConfirm: (moves: { residentId: string; roomId: string }[]) => void;
  rooms: Room[];
}) {
  const { colors } = useAppTheme();
  const leaving = floorLeavers(rooms, floor);
  const targets = rooms.filter((room) => room.floor !== floor).sort((a, b) => a.floor - b.floor || byNumber(a, b));
  const [picks, setPicks] = useState(() => firstFloorMoves(rooms, floor));
  const placed = leaving.filter(({ person }) => picks[person.id]).length;

  return (
    <Sheet
      footer={
        <Button
          disabled={busy || placed < leaving.length}
          label={placed < leaving.length ? `${placed} of ${leaving.length} placed` : "Move and remove floor"}
          loading={busy}
          onPress={() => onConfirm(leaving.map(({ person }) => ({ residentId: person.id, roomId: picks[person.id] })))}
          variant="danger"
        />
      }
      onClose={onClose}
      open
      tall
      title="Move residents first"
    >
      <View className="gap-5 pb-2">
        {leaving.map(({ person, room }) => {
          const options = targets.filter((item) => item.roomType === room.roomType && item.free - bedsClaimed(picks, item.id, person.id) > 0);
          return (
            <View className="gap-2" key={person.id}>
              <View className="flex-row items-center gap-3">
                <PersonAvatar image={person.photo} name={person.name} size="md" />
                <View className="flex-1">
                  <Text className="font-semibold text-foreground" numberOfLines={1}>{person.name}</Text>
                  <Text numberOfLines={1} variant="caption">Room {room.number} · {roomTypeLabel(room.roomType)}</Text>
                </View>
                {picks[person.id] ? <Glyph color={colors.primary} name="checkmark-circle" size={20} variant="solid" /> : null}
              </View>
              {options.length ? (
                <View className="flex-row flex-wrap gap-2">
                  {options.map((item) => {
                    const on = picks[person.id] === item.id;
                    return (
                      <Pressable
                        accessibilityLabel={`Room ${item.number}, ${floorLabel(item.floor)}`}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        className={`min-h-12 justify-center rounded-xl border px-3 py-1.5 active:opacity-70 ${on ? "border-primary bg-brand-soft" : "border-border"}`}
                        key={item.id}
                        onPress={() => setPicks((current) => ({ ...current, [person.id]: item.id }))}
                      >
                        <Text className="font-semibold text-foreground">Room {item.number}</Text>
                        <Text variant="caption">{shortFloor(item.floor)} · {item.free - bedsClaimed(picks, item.id, person.id)} free</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Text className="text-destructive" variant="caption">No free {roomTypeLabel(room.roomType)} bed on another floor.</Text>
              )}
            </View>
          );
        })}
      </View>
    </Sheet>
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

/** A room: its number over a dot per bed, filled for each bed taken. One added this pass has a dashed brand edge. */
function RoomTile({ fresh, onPress, room, selected }: { fresh: boolean; onPress: () => void; room: Room; selected: boolean }) {
  const { colors } = useAppTheme();
  const taken = room.beds - room.free;

  return (
    <Pressable
      accessibilityLabel={`Room ${room.number}, ${roomTypeLabel(room.roomType)}, ${room.free} of ${room.beds} free${fresh ? ", just added" : ""}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`h-16 w-full items-center justify-center gap-1.5 rounded-xl border active:opacity-70 ${
        selected ? "border-primary bg-brand-soft" : fresh ? "border-dashed border-primary bg-brand-soft" : taken > 0 ? "border-border bg-muted" : "border-border"
      }`}
      onPress={onPress}
    >
      <Text className="text-base font-bold text-foreground" variant={null}>{room.number}</Text>
      {room.beds > 6 ? (
        <Text className="text-xs text-muted-foreground" variant={null}>{taken}/{room.beds}</Text>
      ) : (
        <View className="flex-row gap-1">
          {Array.from({ length: room.beds }, (_, at) => (
            <View key={at} style={{ backgroundColor: at < taken ? colors.primary : "transparent", borderColor: at < taken ? colors.primary : colors.mutedForeground, borderRadius: 6, borderWidth: 1.5, height: 12, width: 12 }} />
          ))}
        </View>
      )}
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

function FloorNameSheet({ busy, floor, name, onApply, onClose, open }: { busy: boolean; floor: number; name: string; onApply: (name: string) => void; onClose: () => void; open: boolean }) {
  const [value, setValue] = useState(name);
  const [seeded, setSeeded] = useState(false);

  if (open && !seeded) {
    setSeeded(true);
    setValue(name);
  }
  if (!open && seeded) setSeeded(false);

  return (
    <Sheet footer={<Button disabled={busy} label="Save" loading={busy} onPress={() => onApply(value.trim())} />} onClose={onClose} open={open} title="Floor name">
      <Input autoCapitalize="words" hint={`Leave empty to show "${shortFloor(floor)}"`} label="Name" maxLength={30} onChangeText={setValue} placeholder="Girls block" value={value} variant="line" />
    </Sheet>
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
