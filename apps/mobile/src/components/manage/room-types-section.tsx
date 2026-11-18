import { bedsForRoomType, ROOM_TYPE_OPTIONS, roomTypeLabel } from "@hostel/constants/room-types";
import { useCallback, useMemo, useState } from "react";
import { Alert, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { EmptyCard } from "@/components/ui/states";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { type ManagedHostel, type RoomConfiguration, updateManagedHostel } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Room types: how many rooms of each type exist, beds per room, vacant beds.
 * Rent is on Finance → Room rates and photos on Hostel & Room Photos.
 *
 * `PATCH /hostel-admin/profile` REPLACES `roomConfigurations` (and deletes ROOM
 * photos of any type no longer present), so every save sends the whole array.
 */
type Draft = { bedsPerRoom: string; rooms: string; roomType: string; vacantBeds: string };

const BLANK: Draft = { bedsPerRoom: "1", rooms: "1", roomType: "", vacantBeds: "" };

const toNumber = (value: string) => {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

export function RoomTypesSection({ onChanged }: { onChanged?: () => void }) {
  const { colors } = useAppTheme();
  const query = adminQuery.managedHostel();
  const hostel = useResource<ManagedHostel>(query.load, { cacheKey: query.key, topics: query.topics });
  const { setData } = hostel;

  /** `null` closed, `""` adding, otherwise the type being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [saving, setSaving] = useState(false);
  // Adding: every type the owner taps, saved together. Nothing is pre-picked.
  const [picked, setPicked] = useState<string[]>([]);
  // Types being saved: the sheet closes at once and these show as skeleton rows.
  const [pending, setPending] = useState<string[]>([]);

  const configurations = useMemo(() => hostel.data?.roomConfigurations ?? [], [hostel.data]);
  const photos = hostel.data?.photos;

  const save = useCallback(
    async (next: RoomConfiguration[], message: string) => {
      setSaving(true);
      try {
        const saved = await updateManagedHostel({ roomConfigurations: next });
        setData(() => saved);
        toastSuccess(message);
        onChanged?.();
        return true;
      } catch (error) {
        toastError("Could not save", readApiError(error, "The room types did not save."));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [onChanged, setData],
  );

  /** Adds every picked type (+ the typed one) at once; rooms are set per type after. */
  const addPicked = useCallback(async () => {
    const other = draft.roomType.trim();
    const names = [...picked, ...(other && !picked.some((item) => item.toLowerCase() === other.toLowerCase()) ? [other] : [])];
    if (!names.length) return toastError("Pick a room type", "Tap every type your hostel has.");

    const clash = names.find((name) => configurations.some((config) => config.roomType.toLowerCase() === name.toLowerCase()));
    if (clash) return toastError("Already listed", `Edit “${roomTypeLabel(clash)}” instead of adding it twice.`);

    const next = [
      ...configurations,
      ...names.map((roomType) => ({ bedsPerRoom: bedsForRoomType(roomType), mealInclusion: "Included", rooms: 0, roomType, vacantBeds: 0 }) as RoomConfiguration),
    ];

    setEditing(null);
    setPending(names);
    await save(next, names.length === 1 ? `Added ${roomTypeLabel(names[0])}.` : `Added ${names.length} room types.`);
    // Saved or not (save toasts the failure), the list is the truth again.
    setPending([]);
  }, [configurations, draft.roomType, picked, save]);

  const submit = useCallback(async () => {
    const roomType = draft.roomType.trim();
    if (!roomType) return toastError("Name the room type", "For example, “Three Sharing”.");

    const rooms = toNumber(draft.rooms);
    const bedsPerRoom = toNumber(draft.bedsPerRoom);
    const capacity = rooms * bedsPerRoom;
    const vacantBeds = draft.vacantBeds.trim() ? toNumber(draft.vacantBeds) : capacity;

    if (vacantBeds > capacity) {
      return toastError("More vacant than exist", `${roomTypeLabel(roomType)} has ${capacity} bed(s), so it cannot have ${vacantBeds} free.`);
    }

    const isNew = editing === "";
    if (isNew && configurations.some((config) => config.roomType === roomType)) {
      return toastError("Already listed", `Edit “${roomTypeLabel(roomType)}” instead of adding it twice.`);
    }

    // Editing spreads the existing row first, so its rent and meals are kept.
    const row = { bedsPerRoom, rooms, roomType, vacantBeds };
    const next = isNew
      ? [...configurations, { ...row, mealInclusion: "Included" } as RoomConfiguration]
      : configurations.map((config) => (config.roomType === editing ? { ...config, ...row } : config));

    if (await save(next, isNew ? `Added ${roomTypeLabel(roomType)}.` : `Updated ${roomTypeLabel(roomType)}.`)) {
      setEditing(null);
    }
  }, [configurations, draft, editing, save]);

  const remove = (roomType: string) => {
    const attached = photos?.filter((photo) => photo.kind === "ROOM" && photo.roomType === roomType).length ?? 0;

    Alert.alert(
      `Remove ${roomTypeLabel(roomType)}?`,
      attached > 0
        ? `Its ${attached} photo(s) go with it, and the public listing stops offering this room type.`
        : "The public listing stops offering this room type.",
      [
        { style: "cancel", text: "Keep it" },
        {
          onPress: () => {
            void save(configurations.filter((config) => config.roomType !== roomType), `Removed ${roomTypeLabel(roomType)}.`).then((ok) => {
              if (ok) setEditing(null);
            });
          },
          style: "destructive",
          text: "Remove",
        },
      ],
    );
  };

  if (!hostel.data) return null;

  return (
    <View>
      <SectionHeader
        action={
          <Button
            icon="add"
            label="Add"
            onPress={() => {
              setDraft(BLANK);
              setPicked([]);
              setEditing("");
            }}
            size="sm"
            variant="outline"
          />
        }
        title="Room types"
      />

      {configurations.length === 0 && pending.length === 0 ? (
        <EmptyCard description="Add one and the public listing can start showing vacancies." title="No room types yet" />
      ) : (
        <Card className="gap-0" padding="px-4 py-0">
          {configurations.map((config, index) => (
            <View key={config.roomType}>
              {index > 0 ? <RowDivider inset /> : null}
              <ListRow
                icon="bed"
                iconBgColor={config.vacantBeds > 0 ? colors.primary : colors.mutedForeground}
                onPress={() => {
                  setDraft({
                    bedsPerRoom: String(config.bedsPerRoom ?? 0),
                    rooms: String(config.rooms ?? 0),
                    roomType: config.roomType,
                    vacantBeds: String(config.vacantBeds ?? 0),
                  });
                  setEditing(config.roomType);
                }}
                subtitle={`${config.rooms ?? 0} room(s) · ${config.bedsPerRoom ?? 0} bed(s) each · ${config.vacantBeds ?? 0} free`}
                title={roomTypeLabel(config.roomType)}
              />
            </View>
          ))}
          {pending.map((name) => (
            <View key={`pending-${name}`}>
              {configurations.length > 0 || pending[0] !== name ? <RowDivider inset /> : null}
              <View className="flex-row items-center gap-3 py-3">
                <Skeleton height={40} radius={12} className="w-10" />
                <View className="flex-1 gap-1.5">
                  <Text variant="label">{roomTypeLabel(name)}</Text>
                  <Skeleton height={12} className="w-32" />
                </View>
              </View>
            </View>
          ))}
        </Card>
      )}

      <Sheet
        footer={
          <Button
            label={
              editing !== ""
                ? "Save changes"
                : picked.length + (draft.roomType.trim() ? 1 : 0) > 1
                  ? `Add ${picked.length + (draft.roomType.trim() ? 1 : 0)} room types`
                  : "Add room type"
            }
            loading={saving}
            onPress={() => void (editing === "" ? addPicked() : submit())}
          />
        }
        onClose={() => setEditing(null)}
        open={editing !== null}
        title={editing === "" ? "Add room types" : `Edit ${roomTypeLabel(editing ?? "")}`}
      >
        <View className="gap-3 pb-2">
          {editing === "" ? (
            <>
              <View className="flex-row flex-wrap gap-2">
                {ROOM_TYPE_OPTIONS.filter((type) => !configurations.some((config) => config.roomType === type)).map((type) => (
                  <Chip
                    key={type}
                    label={roomTypeLabel(type)}
                    onPress={() =>
                      setPicked((current) => (current.includes(type) ? current.filter((item) => item !== type) : [...current, type]))
                    }
                    tone={picked.includes(type) ? "brand" : "neutral"}
                  />
                ))}
              </View>
              <Input
                autoCapitalize="words"
                hint="Tap every type you have. Set rooms for each after adding."
                label="Other"
                onChangeText={(roomType) => setDraft((prev) => ({ ...prev, roomType }))}
                placeholder="6 Sharing"
                value={draft.roomType}
              />
            </>
          ) : null}

          {editing === "" ? null : (
          <>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Input keyboardType="number-pad" label="Rooms" onChangeText={(rooms) => setDraft((prev) => ({ ...prev, rooms }))} value={draft.rooms} />
            </View>
            <View className="flex-1">
              <Input
                keyboardType="number-pad"
                label="Beds per room"
                onChangeText={(bedsPerRoom) => setDraft((prev) => ({ ...prev, bedsPerRoom }))}
                value={draft.bedsPerRoom}
              />
            </View>
          </View>

          <Input
            hint={`Out of ${toNumber(draft.rooms) * toNumber(draft.bedsPerRoom)} bed(s). Leave blank on a new type to start fully vacant.`}
            keyboardType="number-pad"
            label="Vacant beds"
            onChangeText={(vacantBeds) => setDraft((prev) => ({ ...prev, vacantBeds }))}
            value={draft.vacantBeds}
          />
          </>
          )}

          {editing ? <Button label="Remove this room type" onPress={() => remove(editing)} variant="outline" /> : null}
        </View>
      </Sheet>
    </View>
  );
}
