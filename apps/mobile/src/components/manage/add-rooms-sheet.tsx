import { roomTypeLabel } from "@hostel/constants/room-types";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { floorLabel, roomNumbers } from "@/lib/rooms-api";

const FLOOR_CHOICES = [0, 1, 2, 3, 4, 5];

/**
 * One floor's rooms in one go — "101 to 105, Double, 2 beds"
 * (docs/FIELD_FIXES_2026_10.md §3). Opens on the floor it was opened from,
 * numbered like it. Used by Rooms and by the KYC step.
 */
export function AddRoomsSheet({
  busy,
  floor,
  onClose,
  onSave,
  roomTypes,
}: {
  busy: boolean;
  floor: number | null;
  onClose: () => void;
  onSave: (input: { beds: number; floor: number; numbers: string[]; roomType: string }) => void;
  roomTypes: string[];
}) {
  const [floorValue, setFloorValue] = useState("0");
  const [roomType, setRoomType] = useState<string | null>(null);
  const [first, setFirst] = useState("");
  const [count, setCount] = useState("1");
  const [beds, setBeds] = useState("2");
  const [seededFor, setSeededFor] = useState<number | null>(null);

  // A new opening starts on the floor it was opened from, numbered like it.
  if (floor !== null && seededFor !== floor) {
    setSeededFor(floor);
    setFloorValue(String(floor));
    setFirst(floor === 0 ? "1" : `${floor}01`);
  }

  if (floor === null && seededFor !== null) setSeededFor(null);

  const floorNumber = Number(floorValue);
  const numbers = roomNumbers(first, Number(count) || 1);
  const bedsEach = Number(beds) || 0;
  const valid = Number.isInteger(floorNumber) && Boolean(roomType) && numbers.length > 0 && bedsEach >= 1;

  return (
    <Sheet
      footer={
        <Button
          disabled={!valid}
          label={numbers.length > 1 ? `Add ${numbers.length} rooms` : "Add room"}
          loading={busy}
          onPress={() => valid && roomType && onSave({ beds: bedsEach, floor: floorNumber, numbers, roomType })}
        />
      }
      onClose={onClose}
      open={floor !== null}
      tall
      title="Add rooms"
    >
      <View className="gap-4 pb-2">
        <ChoiceChips
          label="Floor"
          onToggle={setFloorValue}
          options={[
            ...FLOOR_CHOICES.map((value) => ({ label: value === 0 ? "Ground" : floorLabel(value).replace(" floor", ""), value: String(value) })),
            ...(FLOOR_CHOICES.includes(floorNumber) ? [] : [{ label: floorLabel(floorNumber), value: floorValue }]),
          ]}
          value={floorValue}
        />
        <Input
          hint="Any other floor: type its number. Basement is -1."
          keyboardType="numbers-and-punctuation"
          label="Floor number"
          onChangeText={setFloorValue}
          value={floorValue}
        />
        <Select
          label="Room type"
          onChange={setRoomType}
          options={roomTypes.map((type) => ({ label: roomTypeLabel(type), value: type }))}
          placeholder={roomTypes.length ? "Pick a type" : "Add a room type first"}
          value={roomType}
        />
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Input label="First room no." onChangeText={setFirst} placeholder="101" value={first} />
          </View>
          <View className="flex-1">
            <Input keyboardType="number-pad" label="How many" onChangeText={setCount} value={count} />
          </View>
          <View className="flex-1">
            <Input keyboardType="number-pad" label="Beds each" onChangeText={setBeds} value={beds} />
          </View>
        </View>
        {numbers.length > 0 ? (
          <Text variant="caption">
            {numbers.length > 1 ? `Rooms ${numbers[0]} to ${numbers.at(-1)}` : `Room ${numbers[0]}`}
            {` · ${numbers.length * bedsEach} beds`}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}
