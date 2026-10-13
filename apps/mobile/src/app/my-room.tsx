import { useCallback, useState } from "react";
import { View } from "react-native";

import { RoomPicker } from "@/components/manage/room-picker";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import {
  askRoomChange,
  cancelRoomChange,
  floorLabel,
  type MyRoom,
  roomLine,
  roomsQuery,
} from "@/lib/rooms-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * My room (docs/FIELD_FIXES_2026_10.md §3.8): where I am, and asking for a
 * free bed elsewhere in the hostel. Nothing moves until a warden confirms.
 */
export default function MyRoomScreen() {
  const query = roomsQuery.mine();
  const mine = useResource<MyRoom>(query.load, { cacheKey: query.key, topics: query.topics });
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await work();
        toastSuccess(done);
        setPicking(false);
        setTarget(null);
        setNote("");
        await mine.refresh();
      } catch (error) {
        toastError("That did not work", readApiError(error));
      } finally {
        setBusy(false);
      }
    },
    [mine],
  );

  const header = <AppBar accent centerTitle showBack title="My room" />;

  if (mine.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  if (mine.error || !mine.data) {
    return (
      <Screen header={header}>
        <ErrorState message={mine.error ?? "Could not load your room"} onRetry={mine.reload} />
      </Screen>
    );
  }

  const { current, freeRooms, request, tracking } = mine.data;
  const waiting = request?.status === "PENDING";

  return (
    <Screen header={header} onRefresh={mine.refresh} refreshing={mine.refreshing} scroll>
      <View className="gap-5 pt-1">
        <Card className="py-1">
          <FactRow label="Room" value={current?.number ? `Room ${current.number}` : "Not given yet"} />
          {current?.floor !== null && current?.floor !== undefined ? (
            <>
              <RowDivider />
              <FactRow label="Floor" value={floorLabel(current.floor)} />
            </>
          ) : null}
          <RowDivider />
          <FactRow label="Type" value={current?.roomType ?? "—"} />
        </Card>

        {!tracking ? (
          <EmptyCard description="Ask your warden if you want to change room." title="Your hostel keeps rooms by type" />
        ) : waiting ? (
          <View>
            <SectionHeader title="Waiting for the warden" />
            <Card className="gap-3">
              <Text>{`You asked for ${roomLine(request.to) ?? "a room"}${request.to ? ` (${request.to.roomType})` : ""}.`}</Text>
              <Button label="Cancel request" loading={busy} onPress={() => void run(cancelRoomChange, "Request cancelled")} variant="outline" />
            </Card>
          </View>
        ) : (
          <View>
            {request?.status === "DECLINED" ? (
              <Card className="mb-3 gap-1">
                <Text variant="label">Last request not approved</Text>
                {request.declineReason ? <Text variant="caption">{request.declineReason}</Text> : null}
              </Card>
            ) : null}

            {!picking ? (
              <Button
                disabled={freeRooms.length === 0}
                label={freeRooms.length === 0 ? "No free bed right now" : "Ask for another room"}
                onPress={() => setPicking(true)}
                variant="outline"
              />
            ) : (
              <View className="gap-4">
                <SectionHeader subtitle="Your rent follows the room's type" title="Pick a free bed" />
                <RoomPicker onChange={(room) => setTarget(room.id)} rooms={freeRooms} showType value={target} />
                <Input label="Why (optional)" onChangeText={setNote} placeholder="Closer to my friend, quieter floor" value={note} />
                <Button
                  disabled={!target}
                  label="Send to warden"
                  loading={busy}
                  onPress={() => target && void run(() => askRoomChange(target, note.trim() || undefined), "Sent to your warden")}
                />
              </View>
            )}
          </View>
        )}
      </View>
    </Screen>
  );
}
