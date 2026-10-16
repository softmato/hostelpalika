import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AddRoomsSheet } from "@/components/manage/add-rooms-sheet";
import { RoomPicker } from "@/components/manage/room-picker";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { Input } from "@/components/ui/input";
import { FactRow, StatTile } from "@/components/ui/layout";
import { CardRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import {
  addRooms,
  answerRoomRequest,
  byFloor,
  deleteRoom,
  floorLabel,
  type Room,
  type RoomLayout,
  type RoomRequest,
  roomLine,
  roomsQuery,
  setResidentRoom,
  setRoomTracking,
  updateRoom,
} from "@/lib/rooms-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Floors and room numbers (docs/FIELD_FIXES_2026_10.md §3).
 *
 * The building as it stands: each floor, its rooms, who is in each and how
 * many beds are free. Requests to change room and residents with no room yet
 * sit on top because they want a decision. Room types and rent stay on
 * `manage/rooms` — this screen numbers the rooms those types describe.
 */

type Assign = { id: string; name: string; roomType: string } | null;

export default function FloorsScreen() {
  const owner = useAppSelector((state) => state.auth.account?.role) === ROLE.HOSTEL_ADMIN;
  const layoutQuery = roomsQuery.layout();
  const layout = useResource<RoomLayout>(layoutQuery.load, { cacheKey: layoutQuery.key, topics: layoutQuery.topics });
  const requestsQuery = roomsQuery.requests();
  const requests = useResource<{ requests: RoomRequest[] }>(requestsQuery.load, {
    cacheKey: requestsQuery.key,
    topics: requestsQuery.topics,
  });

  const [adding, setAdding] = useState<number | null>(null);
  const [open, setOpen] = useState<Room | null>(null);
  const [assign, setAssign] = useState<Assign>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void layout.refresh();
    void requests.refresh();
  }, [layout, requests]);

  const run = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await work();
        toastSuccess(done);
        refresh();
        return true;
      } catch (error) {
        toastError("That did not work", readApiError(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const data = layout.data;
  const floors = useMemo(() => byFloor(data?.rooms ?? []), [data]);
  const header = <AppBar accent centerTitle showBack title="Rooms" />;

  if (layout.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonTiles />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (layout.error || !data) {
    return (
      <Screen header={header}>
        <ErrorState message={layout.error ?? "Rooms did not load"} onRetry={layout.reload} />
      </Screen>
    );
  }

  const beds = data.rooms.reduce((sum, room) => sum + room.beds, 0);
  const free = data.rooms.reduce((sum, room) => sum + room.free, 0);
  const pending = requests.data?.requests ?? [];

  return (
    <Screen
      floating={
        data.tracking ? (
          <FloatingButton icon="add" label="Add rooms" onPress={() => setAdding(floors.at(-1)?.floor ?? 0)} />
        ) : undefined
      }
      header={header}
      onRefresh={refresh}
      refreshing={layout.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {owner ? (
          <CardRow
            icon="grid"
            right={
              <Toggle
                accessibilityLabel="Keep residents by floor and room"
                onChange={(enabled) => void run(() => setRoomTracking(enabled), enabled ? "Floor & room on" : "Room type only")}
                value={data.tracking}
              />
            }
            subtitle={data.tracking ? "Every resident has a floor and room" : "Room type only"}
            title="Floor & room"
          />
        ) : null}

        {!data.tracking ? (
          <EmptyCard
            description="Residents are kept by room type. Turn Floor & room on to number your rooms."
            title="Room type only"
          />
        ) : (
          <>
            <View className="flex-row gap-3">
              <StatTile icon="business" label="Rooms" tone="brand" value={String(data.rooms.length)} />
              <StatTile icon="bed" label="Beds" value={String(beds)} />
              <StatTile icon="checkmark-circle" label="Free" tone={free > 0 ? "success" : "neutral"} value={String(free)} />
            </View>

            {pending.length > 0 ? (
              <View>
                <SectionHeader title="Room change requests" />
                <Card className="gap-1 py-1">
                  {pending.map((request, index) => (
                    <View className="gap-2 py-2" key={request.id}>
                      {index > 0 ? <RowDivider /> : null}
                      <Text variant="label">{request.resident.name}</Text>
                      <Text variant="caption">
                        {`${roomLine(request.from) ?? "No room"}  →  ${roomLine(request.to) ?? "a room no longer here"}`}
                        {request.note ? `\n“${request.note}”` : ""}
                      </Text>
                      <View className="flex-row gap-2">
                        <View className="flex-1">
                          <Button
                            label="Decline"
                            loading={busy}
                            onPress={() => void run(() => answerRoomRequest(request.id, "decline"), "Declined")}
                            variant="outline"
                          />
                        </View>
                        <View className="flex-1">
                          <Button
                            disabled={!request.to || (request.to.free ?? 0) <= 0}
                            label="Confirm"
                            loading={busy}
                            onPress={() => void run(() => answerRoomRequest(request.id, "approve"), "Moved")}
                          />
                        </View>
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {data.rooms.length > 0 && data.unassigned.length > 0 ? (
              <View>
                <SectionHeader subtitle="Pick a room for each" title={`No room yet · ${data.unassigned.length}`} />
                <Card className="py-1">
                  {data.unassigned.map((person, index) => (
                    <View key={person.id}>
                      {index > 0 ? <RowDivider /> : null}
                      <CardRow
                        icon="person"
                        onPress={() => setAssign(person)}
                        subtitle={person.roomType}
                        title={person.name}
                        tone="warning"
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {floors.length === 0 ? (
              <EmptyCard
                action={<Button label="Add the first floor" onPress={() => setAdding(0)} />}
                description="Add each floor's rooms with their numbers, like 101 to 105, Double, 2 beds."
                title="No rooms yet"
              />
            ) : (
              floors.map((entry) => (
                <View key={entry.floor}>
                  <SectionHeader
                    action={
                      <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setAdding(entry.floor)}>
                        <Text className="text-sm font-semibold text-primary">Add</Text>
                      </Pressable>
                    }
                    subtitle={`${entry.rooms.length} rooms · ${entry.rooms.reduce((sum, room) => sum + room.free, 0)} beds free`}
                    title={floorLabel(entry.floor)}
                  />
                  <View className="flex-row flex-wrap" style={{ gap: 8 }}>
                    {entry.rooms.map((room) => (
                      <Pressable
                        accessibilityLabel={`Room ${room.number}, ${room.roomType}, ${room.free} free`}
                        accessibilityRole="button"
                        className="gap-0.5 rounded-2xl border border-border bg-card px-3 py-2.5 active:opacity-70"
                        key={room.id}
                        onPress={() => setOpen(room)}
                        style={{ flexBasis: "30%", flexGrow: 1, maxWidth: "32%" }}
                      >
                        <Text className="text-base font-bold text-foreground">{room.number}</Text>
                        <Text numberOfLines={1} variant="caption">
                          {room.roomType}
                        </Text>
                        <Text className={room.free > 0 ? "text-success" : "text-muted-foreground"} variant="caption">
                          {room.free > 0 ? `${room.free} free` : "Full"}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))
            )}
          </>
        )}

        <CardRow
          icon="pricetags"
          onPress={() => router.push("/manage/rooms")}
          subtitle="Types, rent, photos"
          title="Room types"
        />
      </View>

      <AddRoomsSheet
        busy={busy}
        floor={adding}
        onClose={() => setAdding(null)}
        onSave={async (input) => {
          if (await run(() => addRooms(input), `${input.numbers.length} rooms added`)) setAdding(null);
        }}
        roomTypes={data.roomTypes}
      />

      <RoomSheet
        busy={busy}
        onClose={() => setOpen(null)}
        onDelete={(room) =>
          openConfirm({
            confirmLabel: "Remove",
            destructive: true,
            message: "Only an empty room can be removed.",
            onConfirm: async () => {
              if (await run(() => deleteRoom(room.id), `Room ${room.number} removed`)) setOpen(null);
            },
            title: `Remove Room ${room.number}?`,
          })
        }
        onSave={async (room, changes) => {
          if (await run(() => updateRoom(room.id, changes), "Room saved")) setOpen(null);
        }}
        room={open}
      />

      <Sheet onClose={() => setAssign(null)} open={assign !== null} tall title={assign ? `Room for ${assign.name}` : "Room"}>
        {assign ? (
          <RoomPicker
            onChange={(room) =>
              void run(() => setResidentRoom(assign.id, room.id), `${assign.name} is in Room ${room.number}`).then(
                (ok) => ok && setAssign(null),
              )
            }
            roomType={assign.roomType}
            rooms={data.rooms}
            value={null}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

function RoomSheet({
  busy,
  onClose,
  onDelete,
  onSave,
  room,
}: {
  busy: boolean;
  onClose: () => void;
  onDelete: (room: Room) => void;
  onSave: (room: Room, changes: { beds?: number; number?: string }) => void;
  room: Room | null;
}) {
  const [number, setNumber] = useState("");
  const [beds, setBeds] = useState("");
  const [forId, setForId] = useState<string | null>(null);

  if (room && forId !== room.id) {
    setForId(room.id);
    setNumber(room.number);
    setBeds(String(room.beds));
  }

  return (
    <Sheet
      footer={
        room ? (
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Remove" onPress={() => onDelete(room)} variant="outline" />
            </View>
            <View className="flex-1">
              <Button
                label="Save"
                loading={busy}
                onPress={() =>
                  onSave(room, {
                    beds: Number(beds) !== room.beds ? Number(beds) : undefined,
                    number: number.trim() !== room.number ? number.trim() : undefined,
                  })
                }
              />
            </View>
          </View>
        ) : undefined
      }
      onClose={onClose}
      open={room !== null}
      title={room ? `Room ${room.number}` : "Room"}
    >
      {room ? (
        <View className="gap-4 pb-2">
          <View className="rounded-2xl border border-border bg-card px-3 py-1">
            <FactRow label="Floor" value={floorLabel(room.floor)} />
            <RowDivider />
            <FactRow label="Type" value={room.roomType} />
            <RowDivider />
            <FactRow label="Beds free" value={`${room.free} of ${room.beds}`} />
          </View>
          {room.residents.length > 0 ? (
            <View className="gap-1">
              <Text variant="label">Living here</Text>
              {room.residents.map((person) => (
                <Pressable key={person.id} onPress={() => router.push(`/manage/resident/${person.id}`)}>
                  <Text className="py-1 text-primary">{person.name}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Input label="Room no." onChangeText={setNumber} value={number} />
            </View>
            <View className="flex-1">
              <Input keyboardType="number-pad" label="Beds" onChangeText={setBeds} value={beds} />
            </View>
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}
