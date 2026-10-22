import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { RoomsFloorsEditor } from "@/components/manage/rooms-floors-editor";
import { RoomPicker } from "@/components/manage/room-picker";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { CardRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import {
  answerRoomRequest,
  type RoomLayout,
  type RoomRequest,
  roomLine,
  roomsQuery,
  setResidentRoom,
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
  const layoutQuery = roomsQuery.layout();
  const layout = useResource<RoomLayout>(layoutQuery.load, { cacheKey: layoutQuery.key, topics: layoutQuery.topics });
  const requestsQuery = roomsQuery.requests();
  const requests = useResource<{ requests: RoomRequest[] }>(requestsQuery.load, {
    cacheKey: requestsQuery.key,
    topics: requestsQuery.topics,
  });

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

  const pending = requests.data?.requests ?? [];

  return (
    <Screen header={header} onRefresh={refresh} refreshing={layout.refreshing} scroll>
      <View className="gap-5 pt-1">
        <RoomsFloorsEditor onChanged={() => void requests.refresh()} />

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

        <CardRow
          icon="pricetags"
          onPress={() => router.push("/manage/rooms")}
          subtitle="Types, rent, photos"
          title="Room types"
        />
      </View>

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
