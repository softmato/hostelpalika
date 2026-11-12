import { useManagedHostel } from "@/components/kyc/use-managed-hostel";
import { roomTypeLabel } from "@hostel/constants/room-types";
import { useCallback } from "react";
import { View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph } from "@/components/ui/glyph";
import { BUILDING_SHOTS, PHOTO_LIMITS, PhotoStrip, targetKey, useHostelPhotoActions } from "@/components/manage/hostel-photos";
import { StepSection } from "@/components/step-flow";
import { Card } from "@/components/ui/card";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

export function PhotosStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const hostel = useManagedHostel();
  const { refresh } = hostel;
  const reread = useCallback(async () => {
    await Promise.all([refresh(), onSaved()]);
  }, [onSaved, refresh]);
  const { addPhotos, removePhoto, uploadingFor } = useHostelPhotoActions({
    hostelName: hostel.data?.name,
    refresh: reread,
  });

  useKycDraft({ dirty: false, busy: Boolean(uploadingFor), save: async () => true });

  if (hostel.loading) {
    return <SkeletonCard rows={3} />;
  }

  if (hostel.error || !hostel.data) {
    return <ErrorState message={hostel.error ?? "Could not load your photos."} onRetry={hostel.reload} />;
  }

  const photos = hostel.data.photos;
  const rooms = hostel.data.roomConfigurations;

  return (
    <View className="gap-4">
      {/* How full each kind is, at a glance — the add tiles below fill it. */}
      <Card className="gap-2.5">
        {[
          ...BUILDING_SHOTS.map((shot) => ({ count: photos.filter((photo) => photo.kind === shot.kind).length, limit: PHOTO_LIMITS[shot.kind], name: shot.name })),
          ...rooms.map((config) => ({ count: photos.filter((photo) => photo.kind === "ROOM" && photo.roomType === config.roomType).length, limit: PHOTO_LIMITS.ROOM, name: config.roomType })),
        ].map((group) => {
          const full = group.count >= group.limit;
          return <View className="flex-row items-center gap-3" key={group.name}>
            <Text className="w-24" numberOfLines={1} variant="label">{group.name}</Text>
            <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><View className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (group.count / group.limit) * 100)}%` }} /></View>
            {full ? <Glyph color={colors.primary} name="checkmark-circle" size={18} /> : <Text className="w-12 text-right" variant="caption">{group.count}/{group.limit}</Text>}
          </View>;
        })}
      </Card>

      {BUILDING_SHOTS.map((shot) => {
        const shots = photos.filter((photo) => photo.kind === shot.kind);

        return (
          <StepSection caption={shot.kind === "EXTERIOR" ? "Listing cover" : undefined} key={shot.kind} title={shot.name}>
            <PhotoStrip
              large
              disabled={Boolean(uploadingFor)}
              busy={uploadingFor === targetKey({ kind: shot.kind })}
              limit={PHOTO_LIMITS[shot.kind]}
              name={`${shot.name} of ${hostel.data?.name ?? "the hostel"}`}
              onAdd={(source) => void addPhotos({ kind: shot.kind }, shots.length, source)}
              onRemove={removePhoto}
              photos={shots}
            />
          </StepSection>
        );
      })}

      <StepSection title="Rooms">
        {rooms.length === 0 ? (
          <Text variant="caption">No room types on the listing yet.</Text>
        ) : (
          rooms.map((config) => {
            const shots = photos.filter(
              (photo) => photo.kind === "ROOM" && photo.roomType === config.roomType,
            );
            const target = { kind: "ROOM", roomType: config.roomType } as const;

            return (
              <View className="gap-2" key={config.roomType}>
                <Text variant="label">{roomTypeLabel(config.roomType)}</Text>
                <PhotoStrip
              large
              disabled={Boolean(uploadingFor)}
                  busy={uploadingFor === targetKey(target)}
                  limit={PHOTO_LIMITS.ROOM}
                  name={roomTypeLabel(config.roomType)}
                  onAdd={(source) => void addPhotos(target, shots.length, source)}
                  onRemove={removePhoto}
                  photos={shots}
                />
              </View>
            );
          })
        )}
      </StepSection>
    </View>
  );
}
