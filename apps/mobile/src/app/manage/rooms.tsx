import { roomTypeLabel } from "@hostel/constants/room-types";
import { useMemo } from "react";
import { View } from "react-native";

import {
  BUILDING_SHOTS,
  PHOTO_LIMITS,
  PhotoStrip,
  type PhotoTarget,
  targetKey,
  useHostelPhotoActions,
} from "@/components/manage/hostel-photos";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { type ManagedHostel } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";

/**
 * Hostel & Room Photos — upload and maintain the listing's photographs, nothing
 * else. Room numbers live on `manage/floors`, rent on `manage/finance/room-rates`.
 *
 * Building shots (outside, inside) come first; below them one strip per room
 * type the hostel already has. Both kinds share one upload path
 * (`useHostelPhotoActions`).
 */
export default function ManageRoomsScreen() {
  const query = adminQuery.managedHostel();
  const hostel = useResource<ManagedHostel>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const configurations = useMemo(() => hostel.data?.roomConfigurations ?? [], [hostel.data]);
  const photos = useMemo(() => hostel.data?.photos ?? [], [hostel.data]);
  const hostelName = hostel.data?.name;

  const { refresh } = hostel;
  const { addPhotos, removePhoto, uploadingFor } = useHostelPhotoActions({ hostelName, refresh });

  const header = (
    <AppBar accent centerTitle showBack subtitle={hostelName} title="Hostel & Room Photos" />
  );

  if (hostel.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (hostel.error || !hostel.data) {
    return (
      <Screen header={header}>
        <ErrorState message={hostel.error ?? "No hostel"} onRetry={hostel.reload} />
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={hostel.refresh} refreshing={hostel.refreshing} scroll>
      <View className="gap-5 pt-1">
        <View>
          <SectionHeader subtitle="Shown before any room on the public listing" title="Hostel photos" />
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
                    name={`${shot.name} of ${hostelName ?? "the hostel"}`}
                    onAdd={(source) => void addPhotos(target, shots.length, source)}
                    onRemove={removePhoto}
                    photos={shots}
                  />
                </View>
              );
            })}
          </Card>
        </View>

        {configurations.length === 0 ? (
          <EmptyCard
            description="Room photos appear here once the hostel has room types."
            title="No room types yet"
          />
        ) : (
          configurations.map((config) => {
            const roomPhotos = photos.filter(
              (photo) => photo.kind === "ROOM" && photo.roomType === config.roomType,
            );
            const target: PhotoTarget = { kind: "ROOM", roomType: config.roomType };

            return (
              <View key={config.roomType}>
                <SectionHeader title={roomTypeLabel(config.roomType)} />
                <Card>
                  <PhotoStrip
                    busy={uploadingFor === targetKey(target)}
                    limit={PHOTO_LIMITS.ROOM}
                    name={roomTypeLabel(config.roomType)}
                    onAdd={(source) => void addPhotos(target, roomPhotos.length, source)}
                    onRemove={removePhoto}
                    photos={roomPhotos}
                  />
                </Card>
              </View>
            );
          })
        )}
      </View>
    </Screen>
  );
}
