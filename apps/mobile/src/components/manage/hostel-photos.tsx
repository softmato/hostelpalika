import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { addHostelPhoto, deleteHostelPhoto, type ManagedHostel } from "@/lib/admin-manage-api";
import { openAssetViewer } from "@/lib/asset-viewer";
import { openConfirm } from "@/lib/confirm";
import { absoluteMediaUrl } from "@/lib/media";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

/**
 * The listing's photographs — outside, inside, and one set per room type. Rooms
 * and Hostel KYC both edit them, through this one strip and one upload path.
 */

/** Mirrors `PHOTO_LIMITS` in `hostel-profile.service` — ROOM is counted per type. */
export const PHOTO_LIMITS = { EXTERIOR: 3, INTERIOR: 20, ROOM: 10 } as const;

export type PhotoTarget =
  | { kind: "EXTERIOR" | "INTERIOR"; roomType?: undefined }
  | { kind: "ROOM"; roomType: string };

export const BUILDING_SHOTS = [
  { kind: "EXTERIOR", name: "Outside", note: "Leads the public listing" },
  { kind: "INTERIOR", name: "Inside", note: "Common room, kitchen, study, washrooms" },
] as const;

function targetName(target: PhotoTarget) {
  return target.kind === "ROOM"
    ? target.roomType
    : target.kind === "EXTERIOR"
      ? "Outside"
      : "Inside";
}

/** Where a new photo comes from: taken now, or picked from the gallery. */
export type PhotoSource = "camera" | "library";

/** Keyed apart so a room type called "Inside" cannot spin the building strip. */
export function targetKey(target: PhotoTarget) {
  return target.kind === "ROOM" ? `ROOM:${target.roomType}` : target.kind;
}

/** `refresh` re-reads whatever shows the photos — their endpoints answer with nothing. */
export function useHostelPhotoActions({
  hostelName,
  refresh,
}: {
  hostelName?: string;
  refresh: () => Promise<unknown> | void;
}) {
  const [uploadingFor, setUploadingFor] = useState("");

  /**
   * Pick, upload `PUBLIC`, attach.
   *
   * `PUBLIC` is not a shortcut: these are the photographs a stranger comparing
   * hostels scrolls through, and a `PRIVATE` asset is readable only through the
   * authorising route — so a private upload here would produce a gallery that
   * only its uploader can see.
   */
  const addPhotos = useCallback(
    async (target: PhotoTarget, used: number, source: PhotoSource = "library") => {
      const name = targetName(target);
      const limit = PHOTO_LIMITS[target.kind];
      const free = limit - used;

      if (free <= 0) {
        toastError("Full", `${name} already holds ${limit} photos.`);
        return;
      }

      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        toastError(
          "Permission needed",
          source === "camera"
            ? "Allow the camera to take listing photos."
            : "Allow photo access to add listing photos.",
        );
        return;
      }

      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 })
          : await ImagePicker.launchImageLibraryAsync({
              allowsMultipleSelection: true,
              mediaTypes: ["images"],
              quality: 0.8,
              selectionLimit: free,
            });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      setUploadingFor(targetKey(target));

      let added = 0;

      try {
        // One at a time rather than `Promise.all`: the upload toaster reports
        // each file by name, and a failed third photo should not take the two
        // that already landed with it.
        for (const asset of result.assets) {
          const assetId = await uploadAsset(asset, {
            accessLevel: "PUBLIC",
            label: `${name} photo`,
          });

          await addHostelPhoto({
            alt: target.roomType ?? hostelName,
            fileAssetId: assetId,
            kind: target.kind,
            roomType: target.roomType,
          });
          added += 1;
        }

        toastSuccess(`Added ${added} photo(s)`, name);
      } catch (error) {
        toastError(
          added > 0 ? `Only ${added} went up` : "Upload failed",
          readApiError(error, "Those photos did not upload."),
        );
      } finally {
        setUploadingFor("");
        await refresh();
      }
    },
    [hostelName, refresh],
  );

  /**
   * The cross on a thumbnail only *asks*. The app's custom alert does the
   * deleting, and holds its own spinner while the request is out.
   *
   * It used to delete on the press itself, and a photograph is the one thing
   * here with no undo — the file is gone from the bucket and the owner has to
   * find the original in their gallery again. A single tap, on a 20-point
   * target sitting on the corner of a picture people also tap to enlarge, is far
   * too cheap for that.
   */
  const removePhoto = useCallback(
    (photoId: string) => {
      openConfirm({
        cancelLabel: "Keep it",
        confirmLabel: "Remove",
        destructive: true,
        message:
          "It disappears from the public listing, and the file cannot be brought back.",
        onConfirm: async () => {
          try {
            await deleteHostelPhoto(photoId);
            toastSuccess("Photo removed");
            await refresh();
          } catch (error) {
            toastError("Could not remove", readApiError(error));
          }
        },
        title: "Remove this photo?",
      });
    },
    [refresh],
  );

  return { addPhotos, removePhoto, uploadingFor };
}

/**
 * One kind's photos, add tile first.
 *
 * The strip leads with the add tile instead of ending with it. On a horizontal
 * list the tail scrolls out of sight, so an "add" placed there is one the owner
 * has to swipe to find — and it has to be here rather than in a button under the
 * card, because "Photos" next to "Edit" reads as somewhere to go and look, not
 * somewhere to put a photograph.
 */
export function PhotoStrip({
  busy,
  disabled = false,
  large = false,
  limit,
  name,
  onAdd,
  onRemove,
  photos,
}: {
  busy: boolean;
  disabled?: boolean;
  large?: boolean;
  limit: number;
  name: string;
  onAdd: (source: PhotoSource) => void;
  onRemove: (photoId: string) => void;
  photos: ManagedHostel["photos"];
}) {
  const { colors } = useAppTheme();
  const full = photos.length >= limit;
  const height = large ? 120 : 88;

  return (
    <ScrollView
      contentContainerClassName="gap-2"
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {/* Two ways in, side by side in the tile: a camera for the owner standing
          in the room, the gallery for photos already taken. */}
      <View
        className="overflow-hidden rounded-xl border border-dashed border-border"
        style={{ height, width: large ? 148 : 120 }}
      >
        {busy || full ? (
          <View className="flex-1 items-center justify-center gap-1">
            <Ionicons color={colors.mutedForeground} name={busy ? "hourglass-outline" : "checkmark-circle-outline"} size={20} />
            <Text variant="label">{busy ? "Adding…" : "Full"}</Text>
            <Text variant="caption">{photos.length}/{limit}</Text>
          </View>
        ) : (
          (["camera", "library"] as const).map((source) => (
            <Pressable
              accessibilityLabel={source === "camera" ? `Take a photo of ${name}` : `Upload photos of ${name}`}
              accessibilityRole="button"
              className={`flex-1 flex-row items-center justify-center gap-1.5 active:bg-muted ${source === "library" ? "border-t border-dashed border-border" : ""}`}
              disabled={disabled}
              key={source}
              onPress={() => onAdd(source)}
            >
              <Ionicons color={colors.primary} name={source === "camera" ? "camera-outline" : "images-outline"} size={18} />
              <Text className="text-primary" variant="label">{source === "camera" ? "Camera" : "Upload"}</Text>
            </Pressable>
          ))
        )}
      </View>

      {photos.map((photo, index) => {
        const uri = absoluteMediaUrl(photo.url, API_BASE_URL);

        if (!uri) {
          return null;
        }

        return (
          <View className="relative" key={photo.id ?? uri}>
            <Pressable
              accessibilityLabel={`${name} photo ${index + 1}`}
              accessibilityRole="imagebutton"
              onPress={() =>
                openAssetViewer(
                  photos.map((item) => ({ title: item.alt || name, url: item.url })),
                  index,
                )
              }
            >
              <Image
                contentFit="cover"
                source={{ uri }}
                style={{ borderRadius: 12, height, width: large ? 148 : 120 }}
              />
            </Pressable>

            {photo.id ? (
              <Pressable
                accessibilityLabel="Remove photo"
                accessibilityRole="button"
                className="absolute right-1 top-1 rounded-full bg-black/60 p-1"
                hitSlop={8}
                disabled={disabled || busy}
                onPress={() => onRemove(photo.id as string)}
              >
                <Ionicons color="#ffffff" name="close" size={13} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}
