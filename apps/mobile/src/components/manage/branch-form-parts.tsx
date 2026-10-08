import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, TextInput, useWindowDimensions, View } from "react-native";

import { RemoveButton, uploadUri } from "@/components/registration-form";
import { shortStayFloor } from "@/components/registration-sections";
import { Field, FieldHead, NumberStepper } from "@/components/step-flow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import type { SelectOption } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getRefundPolicy } from "@/lib/booking-api";
import { formatMoney } from "@/lib/format";
import {
  MEAL_INCLUSIONS,
  numberValue,
  ROOM_TYPE_OPTIONS,
  type RoomRow,
  type ShortStayForm,
} from "@/lib/hostel-registration";
import { BEDS_BY_ROOM_TYPE } from "@hostel/constants/room-types";

/**
 * The pieces of "Add a branch" (`app/manage/branch-new.tsx`) that only that
 * flow draws: room types as rows edited in a sheet, short stays, facility
 * chips, house rules and the photo grid.
 */

const ATTACHED = " — Attached Bathroom";

const MEAL_LABELS: Record<(typeof MEAL_INCLUSIONS)[number], string> = {
  Included: "Included",
  "Not Included": "Not included",
  Optional: "Optional",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The room-type list for the picker: grouped by bathroom, used ones dimmed. */
export function roomTypeOptions(rooms: readonly RoomRow[], editingId: string | null): SelectOption<string>[] {
  const used = new Set(
    rooms.filter((room) => room.id !== editingId).map((room) => room.roomType.trim().toLowerCase()),
  );

  // The shared list alternates plain / attached; the sheet wants each group together.
  const ordered = [...ROOM_TYPE_OPTIONS].sort((a, b) => Number(a.endsWith(ATTACHED)) - Number(b.endsWith(ATTACHED)));

  return ordered.map((type) => {
    const beds = BEDS_BY_ROOM_TYPE[type];
    const taken = used.has(type.toLowerCase());

    return {
      disabled: taken,
      group: type.endsWith(ATTACHED) ? "Attached bathroom" : "Shared bathroom",
      label: type.replace(ATTACHED, ""),
      leading: <BedMark />,
      meta: beds ? plural(beds, "bed") : "—",
      tag: taken ? "Added" : undefined,
      value: type,
    };
  });
}

/** The beds a known room type implies — what "Beds in each room" starts at. */
export function bedsFor(type: string): string {
  return BEDS_BY_ROOM_TYPE[type] ? String(BEDS_BY_ROOM_TYPE[type]) : "";
}

function BedMark() {
  const { colors } = useAppTheme();

  return <Ionicons color={colors.mutedForeground} name="bed-outline" size={20} />;
}

/** One saved room type: what it is, in one line, and a ⋯ for Edit / Remove. */
export function RoomTypeRow({ onMore, onPress, room }: { onMore: () => void; onPress: () => void; room: RoomRow }) {
  const { colors } = useAppTheme();
  const rooms = numberValue(room.rooms) ?? 0;
  const beds = numberValue(room.bedsPerRoom) ?? 0;
  const rent = numberValue(room.monthlyRent);
  const free = numberValue(room.vacantBeds) ?? 0;

  return (
    <Pressable
      accessibilityRole="button"
      className="flex-row items-center gap-3 border-b border-border py-3.5 active:opacity-70"
      onPress={onPress}
    >
      <BedMark />
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1} variant="label">
          {room.roomType}
        </Text>
        <Text numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }} variant="caption">
          {[
            `${plural(rooms, "room")} × ${plural(beds, "bed")}`,
            rent !== undefined ? `${formatMoney(rent)} / month` : null,
            `${free} free`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={`More for ${room.roomType}`}
        accessibilityRole="button"
        className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
        hitSlop={6}
        onPress={onMore}
      >
        <Ionicons color={colors.mutedForeground} name="ellipsis-horizontal" size={20} />
      </Pressable>
    </Pressable>
  );
}

/** Why a room type cannot be saved yet, or null. */
export function roomProblem(room: RoomRow, others: readonly RoomRow[]): { field: "beds" | "type" | "vacant"; text: string } | null {
  const rooms = numberValue(room.rooms) ?? 0;
  const beds = numberValue(room.bedsPerRoom) ?? 0;
  const name = room.roomType.trim().toLowerCase();

  if (!name) return { field: "type", text: "Pick a room type." };
  if (others.some((other) => other.id !== room.id && other.roomType.trim().toLowerCase() === name)) {
    return { field: "type", text: "Use each room type only once." };
  }
  if (rooms < 1 || beds < 1) return { field: "beds", text: "Enter positive room and bed counts." };
  if ((numberValue(room.vacantBeds) ?? 0) > rooms * beds) {
    return { field: "vacant", text: `Vacant beds cannot exceed capacity. Maximum is ${rooms * beds}.` };
  }

  return null;
}

/** "Add room type" / "Edit room type": the one room type, field by field. */
export function RoomTypeEditor({
  draft,
  isNew,
  onChange,
  onClose,
  onPickType,
  onSave,
  open,
  others,
}: {
  draft: RoomRow | null;
  isNew: boolean;
  onChange: (next: Partial<RoomRow>) => void;
  onClose: () => void;
  onPickType: () => void;
  onSave: () => void;
  open: boolean;
  others: readonly RoomRow[];
}) {
  const { colors } = useAppTheme();
  const [tried, setTried] = useState(false);

  if (!draft) return <Sheet onClose={onClose} open={false}>{null}</Sheet>;

  const rooms = numberValue(draft.rooms) ?? 0;
  const beds = numberValue(draft.bedsPerRoom) ?? 0;
  const problem = roomProblem(draft, others);
  // Too many free beds is wrong the moment it is typed; the rest wait for Save.
  const shown = problem && (tried || problem.field === "vacant") ? problem : null;
  const close = () => {
    setTried(false);
    onClose();
  };

  return (
    <Sheet
      footer={
        <Button
          label="Save room type"
          onPress={() => {
            setTried(true);
            if (!problem) {
              setTried(false);
              onSave();
            }
          }}
        />
      }
      onClose={close}
      open={open}
      tall
      title={isNew ? "Add room type" : "Edit room type"}
    >
      <View className="gap-6 pb-2">
        <View className="gap-0.5">
          <FieldHead label="Room type" required />
          <Pressable
            accessibilityHint="Choose a different room type"
            accessibilityRole="button"
            className={`h-11 flex-row items-center gap-2 border-b active:opacity-70 ${shown?.field === "type" ? "border-destructive" : "border-border"}`}
            onPress={onPickType}
          >
            <Text className="flex-1" numberOfLines={1}>
              {draft.roomType || "Choose"}
            </Text>
            <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
          </Pressable>
          {shown?.field === "type" ? (
            <Text className="text-destructive" variant="caption">
              {shown.text}
            </Text>
          ) : null}
        </View>

        <View className="flex-row gap-6">
          <View className="gap-2">
            <FieldHead label="How many rooms" required />
            <NumberStepper error={shown?.field === "beds" && rooms < 1} label="How many rooms" max={500} min={1} onChange={(value) => onChange({ rooms: value })} value={draft.rooms} />
          </View>
          <View className="gap-2">
            <FieldHead label="Beds in each room" required />
            <NumberStepper error={shown?.field === "beds" && beds < 1} label="Beds in each room" max={50} min={1} onChange={(value) => onChange({ bedsPerRoom: value })} value={draft.bedsPerRoom} />
          </View>
        </View>
        <Text className={shown?.field === "beds" ? "-mt-3 text-destructive" : "-mt-3 text-primary"} style={{ fontVariant: ["tabular-nums"] }} variant="caption">
          {shown?.field === "beds"
            ? shown.text
            : `${plural(rooms, "room")} × ${plural(beds, "bed")} = ${plural(rooms * beds, "bed")}`}
        </Text>

        <Field
          inputMode="numeric"
          label="Rent per month"
          leading={<Text variant="muted">Rs</Text>}
          onChangeText={(value) => onChange({ monthlyRent: value.replace(/\D/g, "") })}
          placeholder="0"
          value={draft.monthlyRent}
        />

        <View className="gap-2">
          <FieldHead label="Beds free now" />
          <NumberStepper error={shown?.field === "vacant"} label="Beds free now" max={rooms * beds || undefined} onChange={(value) => onChange({ vacantBeds: value })} value={draft.vacantBeds} />
          {shown?.field === "vacant" ? (
            <Text className="text-destructive" variant="caption">
              {shown.text}
            </Text>
          ) : (
            <Text variant="caption">All beds start free. Lower it if some are taken.</Text>
          )}
        </View>

        <Field
          hint="Blank uses the hostel-wide deposit."
          inputMode="numeric"
          label="Security deposit"
          leading={<Text variant="muted">Rs</Text>}
          onChangeText={(value) => onChange({ securityDeposit: value.replace(/\D/g, "") })}
          placeholder="0"
          value={draft.securityDeposit ?? ""}
        />

        <View className="gap-2">
          <FieldHead label="Meals" />
          <ChoiceChips
            columns={3}
            onToggle={(value) => onChange({ mealInclusion: value })}
            options={MEAL_INCLUSIONS.map((meal) => ({ label: MEAL_LABELS[meal], value: meal }))}
            value={draft.mealInclusion}
          />
        </View>
      </View>
    </Sheet>
  );
}

/** Short stays: a switch, and once on, the fewest nights and a nightly rate per room type. */
export function BranchShortStays({
  onChange,
  rooms,
  value,
}: {
  onChange: (next: ShortStayForm) => void;
  rooms: readonly RoomRow[];
  value: ShortStayForm;
}) {
  const policy = useResource(getRefundPolicy, { cacheKey: "booking-policy" });
  const terms = policy.data?.shortStay;
  const named = rooms.filter((room) => room.roomType.trim());

  return (
    <View className="gap-5 border-t border-border pt-4">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1" variant="subtitle">
          Short stays
        </Text>
        {value.enabled ? null : <Badge label="Optional" />}
        <Toggle accessibilityLabel="Offers short stays" onChange={(enabled) => onChange({ ...value, enabled })} value={value.enabled} />
      </View>

      {value.enabled ? (
        <>
          <Text className="-mt-3" variant="caption">
            {`Guests book a few nights${terms ? ` (up to ${terms.maxNights})` : ""} and pay us upfront. You get ${terms ? `${terms.hostelSharePercent}%` : "your share"} of the nights once they check in.`}
          </Text>
          <View className="flex-row items-center gap-3">
            <Text className="flex-1 text-sm text-muted-foreground" variant={null}>
              Fewest nights
            </Text>
            <NumberStepper label="Fewest nights" max={terms?.maxNights} min={1} onChange={(minNights) => onChange({ ...value, minNights })} value={value.minNights} />
          </View>
          {named.length ? (
            named.map((room) => {
              const name = room.roomType.trim();
              const floor = shortStayFloor(numberValue(room.monthlyRent) ?? 0, terms);
              const rate = value.rates[name] ?? "";

              return (
                <Field
                  editable={floor !== null}
                  error={floor && rate && Number(rate) < floor ? `At least ${formatMoney(floor)} a night` : undefined}
                  hint={floor ? undefined : "Enter its monthly rent first"}
                  inputMode="numeric"
                  key={room.id}
                  label={`${name} · a night`}
                  leading={<Text variant="muted">Rs</Text>}
                  onChangeText={(next) => onChange({ ...value, rates: { ...value.rates, [name]: next.replace(/\D/g, "") } })}
                  placeholder="0"
                  trailing={floor ? <Text variant="caption">{`Min. ${formatMoney(floor)}`}</Text> : undefined}
                  value={rate}
                />
              );
            })
          ) : (
            <Text variant="caption">Add a room type to set its nightly rate.</Text>
          )}
        </>
      ) : null}
    </View>
  );
}

const FACILITY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  AC: "snow-outline",
  "Attached bathroom": "water-outline",
  CCTV: "videocam-outline",
  "Common room": "people-outline",
  Gym: "barbell-outline",
  "Hot water": "flame-outline",
  Kitchen: "restaurant-outline",
  Laundry: "shirt-outline",
  Parking: "car-outline",
  "Power backup": "flash-outline",
  "Study table": "book-outline",
  WiFi: "wifi-outline",
};

/** One pill with a glyph — on is filled green. */
export function IconChip({
  icon,
  label,
  on,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      className={`min-h-10 flex-row items-center gap-1.5 rounded-full border px-3.5 active:opacity-70 ${on ? "border-primary bg-primary" : "border-border"}`}
      onPress={onPress}
    >
      <Ionicons color={on ? colors.primaryForeground : colors.foreground} name={icon} size={16} />
      <Text className={`text-sm ${on ? "font-semibold text-primary-foreground" : "text-foreground"}`} variant={null}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The facility pills, plus "Add your own" turning into a field in place. */
export function FacilityChips({
  onChange,
  options,
  value,
}: {
  onChange: (next: string[]) => void;
  options: readonly string[];
  value: readonly string[];
}) {
  const { colors } = useAppTheme();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const all = [...options, ...value.filter((item) => !options.includes(item))];
  const add = () => {
    const typed = name.trim().slice(0, 80);
    const match = all.find((item) => item.toLowerCase() === typed.toLowerCase()) ?? typed;

    if (typed && !value.includes(match)) onChange([...value, match]);
    setName("");
    setAdding(false);
  };

  return (
    <View className="flex-row flex-wrap gap-2">
      {all.map((facility) => (
        <IconChip
          icon={FACILITY_ICONS[facility] ?? "checkmark-circle-outline"}
          key={facility}
          label={facility}
          on={value.includes(facility)}
          onPress={() => onChange(value.includes(facility) ? value.filter((item) => item !== facility) : [...value, facility])}
        />
      ))}
      {adding ? (
        <View className="min-h-10 min-w-48 flex-row items-center gap-2 rounded-full border border-primary px-3.5">
          <TextInput
            accessibilityLabel="Facility name"
            autoFocus
            className="flex-1 text-sm text-foreground"
            maxLength={80}
            onBlur={add}
            onChangeText={setName}
            onSubmitEditing={add}
            placeholder="Facility"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="done"
            value={name}
          />
        </View>
      ) : value.length < 40 ? (
        <IconChip icon="add" label="Add your own" on={false} onPress={() => setAdding(true)} />
      ) : null}
    </View>
  );
}

/** House rules as rows: type one, delete one, add another. */
export function RulesList({ onChange, rules }: { onChange: (next: string[]) => void; rules: string[] }) {
  const { colors } = useAppTheme();
  const [focusLast, setFocusLast] = useState(false);

  return (
    <View>
      {rules.map((rule, at) => (
        <View className="min-h-12 flex-row items-center gap-3 border-b border-border" key={at}>
          <Text className="w-5 text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }} variant={null}>
            {at + 1}.
          </Text>
          <TextInput
            accessibilityLabel={`Rule ${at + 1}`}
            autoFocus={focusLast && at === rules.length - 1}
            className="flex-1 py-3 text-base text-foreground"
            maxLength={80}
            onChangeText={(text) => onChange(rules.map((item, index) => (index === at ? text : item)))}
            placeholder={at === 0 ? "Quiet hours after 10 pm" : "Another rule"}
            placeholderTextColor={colors.mutedForeground}
            value={rule}
          />
          <Pressable
            accessibilityLabel={`Remove rule ${at + 1}`}
            accessibilityRole="button"
            className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
            onPress={() => onChange(rules.filter((_, index) => index !== at))}
          >
            <Ionicons color={colors.mutedForeground} name="trash-outline" size={18} />
          </Pressable>
        </View>
      ))}
      {rules.length < 40 ? (
        <Pressable
          accessibilityRole="button"
          className="min-h-12 flex-row items-center gap-3 active:opacity-70"
          onPress={() => {
            setFocusLast(true);
            onChange([...rules, ""]);
          }}
        >
          <Ionicons color={colors.primary} name="add" size={20} />
          <Text className="font-semibold text-primary" variant={null}>
            Add a rule
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export type Uploading = { fraction: number; id: string; uri: string };

/** Photos as a three-across grid: uploaded, then uploading, then Camera and Gallery. */
export function PhotoGrid({
  cover = false,
  max = 10,
  onAdd,
  onRemove,
  photos,
  uploading,
}: {
  /** Tag the first photo "Cover" — the exterior set's first is the branch's face. */
  cover?: boolean;
  max?: number;
  onAdd: (source: "camera" | "library") => void;
  onRemove: (url: string) => void;
  photos: readonly { fileName: string; url: string }[];
  uploading: readonly Uploading[];
}) {
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  // The screen's 20pt gutters, two 8pt gaps.
  const size = Math.floor((width - 40 - 16) / 3);
  const tile = { borderRadius: 14, height: size, width: size };

  return (
    <View className="flex-row flex-wrap gap-2">
      {photos.map((photo, at) => (
        <View key={photo.url} style={[tile, { overflow: "hidden" }]}>
          <Image accessibilityLabel={photo.fileName} contentFit="cover" source={{ uri: uploadUri(photo.url) }} style={[tile, { backgroundColor: colors.muted }]} transition={120} />
          {cover && at === 0 ? (
            <View className="absolute bottom-2 left-2 rounded-full bg-primary px-2 py-0.5">
              <Text className="text-xs font-semibold text-primary-foreground" variant={null}>
                Cover
              </Text>
            </View>
          ) : null}
          <RemoveButton label={photo.fileName} onPress={() => onRemove(photo.url)} />
        </View>
      ))}
      {uploading.map((item) => (
        <View accessibilityLabel={`Uploading, ${Math.round(item.fraction * 100)}%`} key={item.id} style={[tile, { overflow: "hidden" }]}>
          <Image contentFit="cover" source={{ uri: item.uri }} style={[tile, { opacity: 0.45 }]} />
          <View className="absolute inset-0 items-center justify-center">
            <Text className="font-semibold text-foreground" style={{ fontVariant: ["tabular-nums"] }} variant={null}>
              {Math.round(item.fraction * 100)}%
            </Text>
          </View>
          <View className="absolute bottom-0 left-0 right-0 h-1 bg-muted">
            <View className="h-1 bg-primary" style={{ width: `${Math.round(item.fraction * 100)}%` }} />
          </View>
        </View>
      ))}
      {photos.length + uploading.length < max
        ? (["camera", "library"] as const).map((source) => (
            <Pressable
              accessibilityLabel={source === "camera" ? "Take a photo" : "Choose from gallery"}
              accessibilityRole="button"
              className="items-center justify-center gap-1.5 bg-muted active:opacity-70"
              key={source}
              onPress={() => onAdd(source)}
              style={tile}
            >
              <Ionicons color={colors.foreground} name={source === "camera" ? "camera-outline" : "images-outline"} size={22} />
              <Text variant="caption">{source === "camera" ? "Camera" : "Gallery"}</Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}
