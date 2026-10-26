import { Image } from "expo-image";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

const THUMB = 56;

/**
 * The room's first photo, with the next ones fanned out behind it when there
 * are more — a deck, so "tap for more photos" needs no label. One photo draws
 * flat. The layers are the real next photos, not grey cards, so what peeks out
 * is what the viewer opens to.
 */
export function StackedThumb({ photos }: { photos: string[] }) {
  const { colors } = useAppTheme();
  const behind = photos.slice(1, 3);

  const layer = {
    backgroundColor: colors.muted,
    borderColor: colors.card,
    borderRadius: 12,
    borderWidth: 2,
    height: THUMB,
    width: THUMB,
  } as const;

  return (
    <View
      style={{
        height: THUMB,
        // Room on the right for the fanned layers to show past the front photo.
        marginRight: behind.length * 6,
        width: THUMB,
      }}
    >
      {behind
        .map((uri, index) => (
          <Image
            cachePolicy="memory-disk"
            contentFit="cover"
            key={uri}
            source={{ uri }}
            style={[
              layer,
              {
                left: (index + 1) * 6,
                opacity: index === 0 ? 0.9 : 0.7,
                position: "absolute",
                top: 0,
                transform: [{ rotate: `${(index + 1) * 6}deg` }, { scale: 1 - (index + 1) * 0.06 }],
              },
            ]}
          />
        ))
        // Drawn back to front: the farthest layer first.
        .reverse()}

      <Image
        cachePolicy="memory-disk"
        contentFit="cover"
        source={{ uri: photos[0] }}
        style={[layer, { borderWidth: behind.length > 0 ? 2 : 0 }]}
        transition={150}
      />

      {photos.length > 1 ? (
        <View className="absolute bottom-1 right-1 rounded-full bg-black/60 px-1.5">
          <Text className="text-white" style={{ fontSize: 10, fontWeight: "600" }}>
            {`+${photos.length - 1}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
