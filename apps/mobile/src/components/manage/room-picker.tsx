import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { ChoiceChips } from "@/components/ui/choice-chips";
import { Text } from "@/components/ui/text";
import { byFloor, floorLabel } from "@/lib/rooms-api";

type PickableRoom = {
  beds: number;
  floor: number;
  free: number;
  id: string;
  number: string;
  roomType: string;
};

/**
 * Floor, then room — the one picker for intake, a warden's move and a
 * resident's request (docs/FIELD_FIXES_2026_10.md §3). A full room is shown,
 * greyed, so the floor reads as the building it is; it cannot be picked.
 * `roomType` narrows to rooms of that type.
 */
export function RoomPicker({
  onChange,
  roomType,
  rooms,
  showType = false,
  value,
}: {
  onChange: (room: PickableRoom) => void;
  roomType?: string | null;
  rooms: PickableRoom[];
  /** Print each room's type — when the rooms on offer are of mixed types. */
  showType?: boolean;
  value: string | null;
}) {
  const shown = useMemo(
    () => (roomType ? rooms.filter((room) => room.roomType === roomType) : rooms),
    [roomType, rooms],
  );
  const floors = useMemo(() => byFloor(shown), [shown]);
  const selectedFloor = shown.find((room) => room.id === value)?.floor;
  const [picked, setFloor] = useState<number | null>(null);
  // The floor tapped, else the picked room's, else the first with a free bed.
  const floor =
    picked !== null && floors.some((entry) => entry.floor === picked)
      ? picked
      : (selectedFloor ??
        floors.find((entry) => entry.rooms.some((room) => room.free > 0))?.floor ??
        floors[0]?.floor ??
        null);

  if (floors.length === 0) {
    return (
      <Text variant="caption">
        {roomType ? `No ${roomType} rooms are set up yet.` : "No rooms are set up yet."}
      </Text>
    );
  }

  const onFloor = floors.find((entry) => entry.floor === floor)?.rooms ?? [];

  return (
    <View className="gap-3">
      {floors.length > 1 ? (
        <ChoiceChips
          onToggle={(next) => setFloor(Number(next))}
          options={floors.map((entry) => ({ label: floorLabel(entry.floor), value: String(entry.floor) }))}
          value={floor === null ? null : String(floor)}
        />
      ) : null}

      <View className="flex-row flex-wrap" style={{ gap: 8 }}>
        {onFloor.map((room) => {
          const picked = room.id === value;
          const full = room.free <= 0 && !picked;

          return (
            <Pressable
              accessibilityLabel={`Room ${room.number}, ${room.free} of ${room.beds} beds free`}
              accessibilityRole="button"
              accessibilityState={{ disabled: full, selected: picked }}
              className={`items-center gap-0.5 rounded-2xl border px-2 py-2.5 active:opacity-70 ${
                picked ? "border-primary bg-primary/10" : "border-border bg-card"
              } ${full ? "opacity-40" : ""}`}
              disabled={full}
              key={room.id}
              onPress={() => onChange(room)}
              style={{ flexBasis: "30%", flexGrow: 1, maxWidth: "32%" }}
            >
              <Text className={`text-base font-bold ${picked ? "text-primary" : "text-foreground"}`}>
                {room.number}
              </Text>
              {showType ? (
                <Text numberOfLines={1} variant="caption">
                  {room.roomType}
                </Text>
              ) : null}
              <Text numberOfLines={1} variant="caption">
                {full ? "Full" : `${room.free} of ${room.beds} free`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
