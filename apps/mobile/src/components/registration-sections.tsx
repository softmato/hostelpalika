import { Ionicons } from "@expo/vector-icons";
import { Plus } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { Accordion, StepSection } from "@/components/step-flow";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getRefundPolicy } from "@/lib/booking-api";
import {
  type HostelForm,
  MEAL_INCLUSIONS,
  numberValue,
  ROOM_TYPE_OPTIONS,
  type RoomRow,
  type ShortStayForm,
} from "@/lib/hostel-registration";

/**
 * Step sections shared by the two property wizards in the app — "Register your
 * hostel" (`app/register-hostel/apply.tsx`) and "Add a branch"
 * (`app/manage/branch-new.tsx`) — so a room type or a short-stay rate is asked
 * the same way in both.
 */

export type Starter = { label: string; write: (name: string, who: string) => string };

/** Standard descriptions an owner can start from and then edit; three are offered at random. */
const DESCRIPTION_STARTERS: Starter[] = [
  {
    label: "Homely & quiet",
    write: (name, who) =>
      `${name} is a clean, quiet hostel for ${who} with a homely feel, regular meals and a calm place to study and rest.`,
  },
  {
    label: "Student friendly",
    write: (name, who) =>
      `${name} is made for ${who} who study — study tables, fast WiFi, set meal times and quiet hours so exams never clash with noise.`,
  },
  {
    label: "Safe & secure",
    write: (name, who) =>
      `${name} puts safety first for ${who}: CCTV, a staffed gate, fixed entry times and a warden on site around the clock.`,
  },
  {
    label: "Budget stay",
    write: (name, who) =>
      `${name} offers affordable, no-fuss rooms for ${who}, with the essentials covered and fair monthly rent.`,
  },
  {
    label: "Home-style food",
    write: (name, who) =>
      `${name} is known for its home-style food — fresh meals cooked daily for ${who}, in a friendly, family-like hostel.`,
  },
  {
    label: "Working professionals",
    write: (name, who) =>
      `${name} gives ${who} a comfortable base close to offices and transport, with WiFi, laundry and flexible meal times.`,
  },
  {
    label: "Close to colleges",
    write: (name, who) =>
      `${name} is a short walk from nearby colleges, giving ${who} a clean, well-run place to live without a long commute.`,
  },
  {
    label: "Modern & comfortable",
    write: (name, who) =>
      `${name} offers ${who} modern, well-kept rooms, reliable hot water and power backup, and common spaces to relax in.`,
  },
];

const STARTER_AUDIENCE: Record<HostelForm["hostelType"], string> = {
  BOYS: "boys",
  CO_LIVING: "students and working professionals",
  GIRLS: "girls",
};

/** A starter's text for this hostel. */
export function starterText(starter: Starter, name: string, hostelType: HostelForm["hostelType"]): string {
  return starter.write(name.trim() || "Our hostel", STARTER_AUDIENCE[hostelType]);
}

/** `count` starters in random order (Fisher–Yates, so no starter is favoured). */
export function pickStarters(count: number): Starter[] {
  const pool = [...DESCRIPTION_STARTERS];

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));

    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  return pool.slice(0, count);
}

/**
 * "Do you offer short stays?" — a daily rate per room type, each shown against
 * its floor (monthly ÷ 30 plus the platform's markup). The server checks again.
 */
export function ShortStaysSection({
  onChange,
  rooms,
  value,
}: {
  onChange: (next: ShortStayForm) => void;
  rooms: HostelForm["rooms"];
  value: ShortStayForm;
}) {
  const policy = useResource(getRefundPolicy, { cacheKey: "booking-policy" });
  const terms = policy.data?.shortStay;

  return (
    <Accordion caption="Optional" defaultOpen={value.enabled} title="Short stays">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1" variant="caption">
          {`Guests book a few nights${terms ? ` (up to ${terms.maxNights})` : ""} and pay us upfront. You get ${terms ? `${terms.hostelSharePercent}%` : "your share"} of the nights once they check in.`}
        </Text>
        <Toggle
          accessibilityLabel="Offers short stays"
          onChange={(enabled) => onChange({ ...value, enabled })}
          value={value.enabled}
        />
      </View>
      {value.enabled ? (
        <>
          <Input
            inputMode="numeric"
            label="Fewest nights"
            onChangeText={(minNights) => onChange({ ...value, minNights })}
            value={value.minNights}
            variant="line"
          />
          {rooms
            .filter((room) => room.roomType.trim())
            .map((room) => {
              const name = room.roomType.trim();
              const monthly = numberValue(room.monthlyRent) ?? 0;
              const floor =
                terms && monthly > 0 ? Math.max(1, Math.ceil((monthly * (100 + terms.minMarkupPercent)) / 3000)) : null;
              const rate = value.rates[name] ?? "";

              return (
                <Input
                  error={floor && rate && Number(rate) < floor ? `At least NPR ${floor} a night` : undefined}
                  hint={floor ? `At least NPR ${floor} a night` : "Enter its monthly rent first"}
                  inputMode="numeric"
                  key={room.id}
                  label={`${name} · a night`}
                  onChangeText={(next) => onChange({ ...value, rates: { ...value.rates, [name]: next } })}
                  value={rate}
                  variant="line"
                />
              );
            })}
        </>
      ) : null}
    </Accordion>
  );
}

/** "Add your own" under the facility chips: opens a field, and the typed name joins the chips already on. */
export function CustomFacility({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const add = () => {
    const value = name.trim();

    if (value) {
      onAdd(value);
    }

    setName("");
    setOpen(false);
  };

  if (!open) {
    return (
      <Button
        className="self-start"
        icon={Plus}
        label="Add your own"
        onPress={() => setOpen(true)}
        size="sm"
        variant="ghost"
      />
    );
  }

  return (
    <Input
      autoFocus
      label="Facility"
      onChangeText={setName}
      onSubmitEditing={add}
      returnKeyType="done"
      trailing={
        <Pressable hitSlop={10} onPress={add}>
          <Text className="text-primary" variant="label">
            {name.trim() ? "Add" : "Cancel"}
          </Text>
        </Pressable>
      }
      value={name}
      variant="line"
    />
  );
}

/** A list's options, plus any value saved before the list had it — so it stays visible and removable. */
export function withCurrent(
  options: readonly string[],
  ...current: string[]
): { label: string; value: string }[] {
  return [...new Set([...options, ...current.filter(Boolean)])].map(
    (value) => ({ label: value, value }),
  );
}

/**
 * One room type.
 *
 * `vacantBeds` is asked for because "beds free" is the most looked-at number on
 * a hostel card, and a hostel that registers with it unset publishes as full.
 * It starts blank rather than at the bed count — guessing an occupancy on an
 * owner's behalf is inventing data about their business.
 */
export function RoomSection({
  canRemove,
  onChange,
  onRemove,
  position,
  room,
  showDeposit = false,
}: {
  canRemove: boolean;
  onChange: (next: Partial<RoomRow>) => void;
  onRemove: () => void;
  position: number;
  room: RoomRow;
  /** Branches ask a per-room deposit, as the web branch form does. */
  showDeposit?: boolean;
}) {
  const { colors } = useAppTheme();

  return (
    <StepSection
      action={
        canRemove ? (
          <Pressable
            accessibilityLabel={`Remove room type ${position}`}
            accessibilityRole="button"
            hitSlop={10}
            onPress={onRemove}
          >
            <Ionicons
              color={colors.destructive}
              name="trash-outline"
              size={18}
            />
          </Pressable>
        ) : undefined
      }
      title={`Room type ${position}`}
    >
      <ChoiceChips
        onToggle={(value) => onChange({ roomType: value })}
        options={withCurrent(ROOM_TYPE_OPTIONS, room.roomType)}
        value={room.roomType}
      />

      <View className="flex-row gap-4">
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="How many"
            onChangeText={(value) => onChange({ rooms: value })}
            value={room.rooms}
            variant="line"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="Beds each"
            onChangeText={(value) => onChange({ bedsPerRoom: value })}
            value={room.bedsPerRoom}
            variant="line"
          />
        </View>
      </View>

      <View className="flex-row gap-4">
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="Rent / month"
            onChangeText={(value) => onChange({ monthlyRent: value })}
            placeholder="NPR"
            value={room.monthlyRent}
            variant="line"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Input
            inputMode="numeric"
            label="Beds free now"
            onChangeText={(value) => onChange({ vacantBeds: value })}
            value={room.vacantBeds}
            variant="line"
          />
        </View>
      </View>

      {showDeposit ? (
        <Input
          hint="Optional. Blank uses the hostel-wide deposit."
          inputMode="numeric"
          label="Security deposit"
          onChangeText={(value) => onChange({ securityDeposit: value })}
          placeholder="NPR"
          value={room.securityDeposit ?? ""}
          variant="line"
        />
      ) : null}

      <ChoiceChips
        columns={3}
        label="Meals"
        onToggle={(value) => onChange({ mealInclusion: value })}
        options={MEAL_INCLUSIONS.map((meal) => ({ label: meal, value: meal }))}
        value={room.mealInclusion}
      />
    </StepSection>
  );
}

