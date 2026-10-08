import { Image } from "expo-image";
import { X } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { API_BASE_URL } from "@/lib/api";
import { absoluteMediaUrl } from "@/lib/media";

/**
 * Previews of what the hostel and service-provider applications have uploaded
 * — every upload shows what went up, never just a file name. The step flow
 * itself is `components/step-flow.tsx`.
 */

/**
 * An upload's URL, resolved against the API origin. Without R2 the public
 * upload route answers a relative `/uploads/…` path, and a phone has no page
 * origin to resolve it against — the preview would be an empty box after an
 * upload that worked. See `lib/media.ts`.
 */
export function uploadUri(url: string): string {
  return absoluteMediaUrl(url, API_BASE_URL) ?? url;
}

/** On a card-coloured disc, because a glyph straight onto an unknown photo is invisible against half of them. */
export function RemoveButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={`Remove ${label}`}
      accessibilityRole="button"
      className="absolute right-2 top-2 h-7 w-7 items-center justify-center rounded-full bg-card"
      hitSlop={8}
      onPress={onPress}
    >
      <X color={colors.destructive} size={16} strokeWidth={2.5} />
    </Pressable>
  );
}

/** One uploaded file, shown large: the image itself, or the words of a document attached as text. */
export function UploadPreview({
  attachment,
  label,
  onRemove,
  text,
}: {
  attachment: { fileName: string; url: string };
  label: string;
  onRemove: () => void;
  /** Drawn instead of the image, for a document that went up as text. */
  text?: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="gap-1.5">
      <View className="overflow-hidden rounded-2xl bg-muted">
        {text !== undefined ? (
          <Text className="p-4 pr-11 leading-5 text-foreground" numberOfLines={10} variant="caption">
            {text}
          </Text>
        ) : (
          <Image
            accessibilityLabel={label}
            contentFit="cover"
            source={{ uri: uploadUri(attachment.url) }}
            style={{ aspectRatio: 1.6, backgroundColor: colors.muted, width: "100%" }}
            transition={150}
          />
        )}
        <RemoveButton label={label} onPress={onRemove} />
      </View>
      <Text numberOfLines={1} variant="caption">
        {attachment.fileName}
      </Text>
    </View>
  );
}

/** A horizontal strip of uploaded images, each removable. */
export function PhotoStrip({
  onRemove,
  photos,
}: {
  onRemove: (url: string) => void;
  photos: readonly { fileName: string; url: string }[];
}) {
  const { colors } = useAppTheme();

  if (photos.length === 0) {
    return null;
  }

  return (
    <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
      {photos.map((photo) => (
        <View className="overflow-hidden rounded-xl" key={photo.url}>
          <Image
            accessibilityLabel={photo.fileName}
            contentFit="cover"
            source={{ uri: uploadUri(photo.url) }}
            style={{ backgroundColor: colors.muted, height: 104, width: 104 }}
            transition={120}
          />
          <RemoveButton label={photo.fileName} onPress={() => onRemove(photo.url)} />
        </View>
      ))}
    </ScrollView>
  );
}
