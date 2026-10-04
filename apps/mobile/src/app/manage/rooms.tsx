import { Ionicons } from "@expo/vector-icons";
import { ROOM_TYPE_OPTIONS } from "@hostel/shared/constants/room-types";
import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import {
  BUILDING_SHOTS,
  PHOTO_LIMITS,
  PhotoStrip,
  type PhotoTarget,
  targetKey,
  useHostelPhotoActions,
} from "@/components/manage/hostel-photos";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { Input } from "@/components/ui/input";
import { Chip, StatTile } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import {
  type ManagedHostel,
  type RoomConfiguration,
  updateManagedHostel,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Rooms — the first of the eight screens that used to be a browser link.
 *
 * ## Rooms are counts, not records
 *
 * There is no `Room` document to open. A hostel's inventory is
 * `roomConfigurations`: one row per room *type* carrying how many rooms of it
 * exist, how many beds each holds, how many of those beds are free, the rent and
 * whether meals are in it. That is the same list the owner filled in at
 * registration, the same list admitting a resident decrements, and the same list
 * the public listing prices itself from — which is why editing it here is worth
 * a screen rather than a browser tab.
 *
 * ## The whole array goes on every save
 *
 * `PATCH /hostel-admin/profile` **replaces** `roomConfigurations`, recomputes
 * `capacitySummary` from what it is given, and deletes any ROOM photo whose type
 * is no longer present. Sending only the row being edited would therefore wipe
 * every other room type and its photographs. Each mutation below rebuilds the
 * full array and sends that; none of them sends a delta.
 *
 * ## Vacancy is edited, not derived
 *
 * `rooms × bedsPerRoom` is the capacity; `vacantBeds` is a separate figure the
 * hostel maintains, because a bed can be out of service, promised, or occupied
 * by someone who was never registered in the app. The form only refuses the one
 * impossible case — more vacant beds than the type has — and otherwise trusts
 * the person standing in the building.
 *
 * ## Building photos live here too
 *
 * The outside and inside shots used to sit at the bottom of Settings, under a
 * single 20-photo count that ignored the server's 3-photo cap on outside shots.
 * They are the listing's photographs just as the room ones are, so all three
 * kinds share one strip and one upload path on this screen.
 */

/** The five the web offers, as a starting point rather than a closed list. */
const SUGGESTED_TYPES = ROOM_TYPE_OPTIONS;

const MEAL_OPTIONS = [
  {
    description: "Rent covers the food.",
    label: "Included",
    value: "Included",
  },
  {
    description: "Food is billed separately.",
    label: "Not Included",
    value: "Not Included",
  },
  {
    description: "The resident chooses.",
    label: "Optional",
    value: "Optional",
  },
] as const;

type Draft = {
  bedsPerRoom: string;
  mealInclusion: string;
  monthlyRent: string;
  rooms: string;
  roomType: string;
  vacantBeds: string;
};

function draftFrom(config: RoomConfiguration): Draft {
  return {
    bedsPerRoom: String(config.bedsPerRoom ?? 0),
    mealInclusion: config.mealInclusion || "Included",
    monthlyRent: config.monthlyRent ? String(config.monthlyRent) : "",
    rooms: String(config.rooms ?? 0),
    roomType: config.roomType,
    vacantBeds: String(config.vacantBeds ?? 0),
  };
}

const BLANK_DRAFT: Draft = {
  bedsPerRoom: "1",
  mealInclusion: "Included",
  monthlyRent: "",
  rooms: "1",
  roomType: "",
  vacantBeds: "",
};

function toNumber(value: string) {
  const parsed = Number(value.trim());

  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export default function ManageRoomsScreen() {
  const { colors } = useAppTheme();
  // Warmed on touch-down of the Rooms tile on Home — see `prefetchAdminRoute`.
  const query = adminQuery.managedHostel();
  const hostel = useResource<ManagedHostel>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /** `null` = closed, `""` = adding a new type, otherwise the type being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [saving, setSaving] = useState(false);

  const configurations = useMemo(
    () => hostel.data?.roomConfigurations ?? [],
    [hostel.data],
  );
  const photos = useMemo(() => hostel.data?.photos ?? [], [hostel.data]);
  const hostelName = hostel.data?.name;

  const { refresh, setData } = hostel;
  const { addPhotos, removePhoto, uploadingFor } = useHostelPhotoActions({ hostelName, refresh });

  const save = useCallback(
    async (next: RoomConfiguration[], message: string) => {
      setSaving(true);

      try {
        /*
          `updateManagedHostel` answers with the hostel it just wrote, and this
          resource *is* that hostel — so the saved room types are on screen with
          no second round trip behind a refresh spinner. The photo handlers
          below still re-read, because their endpoints answer with nothing.
        */
        const saved = await updateManagedHostel({ roomConfigurations: next });

        setData(() => saved);
        toastSuccess(message);

        return true;
      } catch (error) {
        toastError(
          "Could not save",
          readApiError(error, "The room types did not save."),
        );

        return false;
      } finally {
        setSaving(false);
      }
    },
    [setData],
  );

  const submit = useCallback(async () => {
    const roomType = draft.roomType.trim();

    if (roomType.length < 1) {
      toastError("Name the room type", "For example, “Three Sharing”.");
      return;
    }

    const rooms = toNumber(draft.rooms);
    const bedsPerRoom = toNumber(draft.bedsPerRoom);
    const capacity = rooms * bedsPerRoom;
    const vacantBeds = draft.vacantBeds.trim()
      ? toNumber(draft.vacantBeds)
      : capacity;

    if (vacantBeds > capacity) {
      toastError(
        "More vacant than exist",
        `${roomType} has ${capacity} bed(s) in total, so it cannot have ${vacantBeds} free.`,
      );
      return;
    }

    const isNew = editing === "";

    if (
      isNew &&
      configurations.some((config) => config.roomType === roomType)
    ) {
      toastError(
        "Already listed",
        `Edit “${roomType}” instead of adding it twice.`,
      );
      return;
    }

    const row: RoomConfiguration = {
      bedsPerRoom,
      mealInclusion: draft.mealInclusion,
      monthlyRent: draft.monthlyRent.trim()
        ? toNumber(draft.monthlyRent)
        : undefined,
      rooms,
      roomType,
      vacantBeds,
    };

    const next = isNew
      ? [...configurations, row]
      : configurations.map((config) =>
          config.roomType === editing ? { ...config, ...row } : config,
        );

    const ok = await save(
      next,
      isNew ? `Added ${roomType}.` : `Updated ${roomType}.`,
    );

    if (ok) {
      setEditing(null);
    }
  }, [configurations, draft, editing, save]);

  const remove = useCallback(
    (roomType: string) => {
      const attached = photos.filter(
        (photo) => photo.kind === "ROOM" && photo.roomType === roomType,
      ).length;

      Alert.alert(
        `Remove ${roomType}?`,
        attached > 0
          ? `Its ${attached} photo(s) go with it, and the public listing stops offering this room type.`
          : "The public listing stops offering this room type.",
        [
          { style: "cancel", text: "Keep it" },
          {
            onPress: () => {
              void save(
                configurations.filter((config) => config.roomType !== roomType),
                `Removed ${roomType}.`,
              );
            },
            style: "destructive",
            text: "Remove",
          },
        ],
      );
    },
    [configurations, photos, save],
  );

  if (hostel.loading) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Rooms" />}>
        <View className="gap-4 pt-1">
          <SkeletonTiles />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (hostel.error || !hostel.data) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Rooms" />}>
        <ErrorState
          message={hostel.error ?? "No hostel"}
          onRetry={hostel.reload}
        />
      </Screen>
    );
  }

  const summary = hostel.data.capacitySummary;
  const totalBeds = summary.totalBeds ?? 0;
  const vacant = summary.vacantBeds ?? 0;

  return (
    <Screen
      floating={
        <FloatingButton
          icon="add"
          label="Add a room type"
          onPress={() => {
            setDraft(BLANK_DRAFT);
            setEditing("");
          }}
        />
      }
      header={
        <AppBar
          accent
          centerTitle
          showBack
          subtitle={hostel.data.name}
          title="Rooms"
        />
      }
      onRefresh={hostel.refresh}
      refreshing={hostel.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <View>
          <SectionHeader
            subtitle="Shown before any room on the public listing"
            title="Building photos"
          />
          <Card className="gap-4">
            {BUILDING_SHOTS.map((shot) => {
              const shots = photos.filter((photo) => photo.kind === shot.kind);
              const target: PhotoTarget = { kind: shot.kind };

              return (
                <View className="gap-2" key={shot.kind}>
                  <View className="flex-row items-baseline justify-between">
                    <Text variant="label">{shot.name}</Text>
                    <Text variant="caption">{shot.note}</Text>
                  </View>
                  <PhotoStrip
                    busy={uploadingFor === targetKey(target)}
                    limit={PHOTO_LIMITS[shot.kind]}
                    name={`${shot.name} of ${hostel.data?.name ?? "the hostel"}`}
                    onAdd={(source) => void addPhotos(target, shots.length, source)}
                    onRemove={removePhoto}
                    photos={shots}
                  />
                </View>
              );
            })}
          </Card>
        </View>

        {/*
          The three figures the server derives from the list below, shown above
          it rather than under it: they are what the edits are *for*, and an
          owner who has just changed a bed count wants to see the total move.
        */}
        <View className="flex-row gap-3">
          <StatTile
            icon="business-outline"
            label="Room types"
            tone="brand"
            value={String(configurations.length)}
          />
          <StatTile icon="bed-outline" label="Beds" value={String(totalBeds)} />
          <StatTile
            icon="checkmark-circle-outline"
            label="Vacant"
            tone={vacant > 0 ? "success" : "neutral"}
            value={String(vacant)}
          />
        </View>

        {configurations.length === 0 ? (
          <EmptyCard
            description="Add one and the public listing can start showing prices and vacancies."
            title="No room types yet"
          />
        ) : (
          configurations.map((config) => {
            const roomPhotos = photos.filter(
              (photo) =>
                photo.kind === "ROOM" && photo.roomType === config.roomType,
            );
            const capacity = (config.rooms ?? 0) * (config.bedsPerRoom ?? 0);
            const target: PhotoTarget = { kind: "ROOM", roomType: config.roomType };

            return (
              <View key={config.roomType}>
                <SectionHeader
                  action={
                    <Badge
                      label={`${config.vacantBeds ?? 0} free`}
                      tone={config.vacantBeds > 0 ? "success" : "neutral"}
                    />
                  }
                  subtitle={`${config.rooms ?? 0} room(s) · ${config.bedsPerRoom ?? 0} bed(s) each · ${capacity} bed(s)`}
                  title={config.roomType}
                />

                <Card className="gap-3">
                  <View className="flex-row flex-wrap gap-2">
                    <Chip
                      icon="cash-outline"
                      label={
                        config.monthlyRent
                          ? `${formatMoney(config.monthlyRent)} / month`
                          : "No rent set"
                      }
                      tone={config.monthlyRent ? "brand" : "neutral"}
                    />
                    <Chip
                      icon="restaurant-outline"
                      label={`Meals ${config.mealInclusion.toLowerCase()}`}
                    />
                  </View>

                  <PhotoStrip
                    busy={uploadingFor === targetKey(target)}
                    limit={PHOTO_LIMITS.ROOM}
                    name={config.roomType}
                    onAdd={(source) => void addPhotos(target, roomPhotos.length, source)}
                    onRemove={removePhoto}
                    photos={roomPhotos}
                  />

                  <View className="flex-row gap-2">
                    <Button
                      className="flex-1"
                      label="Edit"
                      onPress={() => {
                        setDraft(draftFrom(config));
                        setEditing(config.roomType);
                      }}
                      size="sm"
                      variant="outline"
                    />
                    <Pressable
                      accessibilityLabel={`Remove ${config.roomType}`}
                      accessibilityRole="button"
                      className="h-9 items-center justify-center rounded-lg border border-border px-3"
                      onPress={() => remove(config.roomType)}
                    >
                      <Ionicons
                        color={colors.destructive}
                        name="trash-outline"
                        size={16}
                      />
                    </Pressable>
                  </View>
                </Card>
              </View>
            );
          })
        )}

        <Text className="px-1" variant="caption">
          Beds and vacancies here are what the public listing shows and what the
          dashboard counts. Admitting a resident lowers the free count on their
          room type automatically.
        </Text>
      </View>

      <Sheet
        footer={
          <Button
            label={editing === "" ? "Add room type" : "Save changes"}
            loading={saving}
            onPress={() => void submit()}
          />
        }
        onClose={() => setEditing(null)}
        open={editing !== null}
        title={editing === "" ? "New room type" : `Edit ${editing}`}
      >
        <View className="gap-3 pb-2">
          {editing === "" ? (
            <>
              <Input
                autoCapitalize="words"
                label="Room type"
                onChangeText={(roomType) =>
                  setDraft((prev) => ({ ...prev, roomType }))
                }
                placeholder="Three Sharing"
                value={draft.roomType}
              />
              <View className="flex-row flex-wrap gap-2">
                {SUGGESTED_TYPES.filter(
                  (type) =>
                    !configurations.some((config) => config.roomType === type),
                ).map((type) => (
                  <Chip
                    key={type}
                    label={type}
                    onPress={() =>
                      setDraft((prev) => ({ ...prev, roomType: type }))
                    }
                    tone={draft.roomType === type ? "brand" : "neutral"}
                  />
                ))}
              </View>
            </>
          ) : null}

          <View className="flex-row gap-3">
            <View className="flex-1">
              <Input
                keyboardType="number-pad"
                label="Rooms"
                onChangeText={(rooms) =>
                  setDraft((prev) => ({ ...prev, rooms }))
                }
                value={draft.rooms}
              />
            </View>
            <View className="flex-1">
              <Input
                keyboardType="number-pad"
                label="Beds per room"
                onChangeText={(bedsPerRoom) =>
                  setDraft((prev) => ({ ...prev, bedsPerRoom }))
                }
                value={draft.bedsPerRoom}
              />
            </View>
          </View>

          <Input
            hint={`Out of ${toNumber(draft.rooms) * toNumber(draft.bedsPerRoom)} bed(s). Leave blank on a new type to start fully vacant.`}
            keyboardType="number-pad"
            label="Vacant beds"
            onChangeText={(vacantBeds) =>
              setDraft((prev) => ({ ...prev, vacantBeds }))
            }
            value={draft.vacantBeds}
          />

          <Input
            hint="Shown on the public listing. Leave blank if this type is priced on request."
            keyboardType="number-pad"
            label="Monthly rent (NPR)"
            onChangeText={(monthlyRent) =>
              setDraft((prev) => ({ ...prev, monthlyRent }))
            }
            value={draft.monthlyRent}
          />

          <Select
            label="Meals"
            onChange={(mealInclusion) =>
              setDraft((prev) => ({ ...prev, mealInclusion }))
            }
            options={MEAL_OPTIONS}
            value={draft.mealInclusion}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
