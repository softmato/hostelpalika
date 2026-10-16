import { Pressable, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp, LinearTransition } from "react-native-reanimated";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { useUploads } from "@/hooks/use-uploads";
import { openSavedFile } from "@/lib/native-downloads";
import {
  dismissUpload,
  type UploadRow,
  uploadRowFraction,
  uploadRowMessage,
} from "@/lib/upload-queue";

/**
 * Live progress for every upload in the app, mounted once at the root.
 *
 * ## Why the top edge
 *
 * The obvious place is the bottom, where the web puts it — but this is a root
 * overlay and the root cannot know what is under it. Half the screens in the
 * app sit inside a `<Tabs>` navigator whose bar is absolutely positioned, and
 * the rest may have a sticky footer holding the only submit button; anchoring
 * to the bottom would cover one or the other, which is exactly the unpressable
 * button the shell contract in §0 of MOBILE_APP_PHASES.md exists to prevent.
 * The top edge has one occupant, the AppBar, and covering a title for the few
 * seconds a transfer takes costs nothing.
 *
 * ## Why it survives navigation
 *
 * The upload keeps running when the screen that started it is popped —
 * `lib/uploads.ts` is a plain module and does not care — so the report has to
 * outlive the screen too. A resident who attaches a receipt and then goes back
 * to check the amount would otherwise see the progress vanish and have no way
 * to tell whether their evidence was sent.
 */

export function UploadToaster() {
  const insets = useSystemInsets();
  const rows = useUploads();

  if (rows.length === 0) {
    return null;
  }

  return (
    <View
      className="absolute inset-x-0 gap-2 px-4"
      // Taps fall through the container to whatever is behind it; only the
      // dismiss button and a finished download's open tap are interactive.
      style={{ pointerEvents: "box-none", top: insets.top + 8 }}
    >
      {rows.map((row) => (
        <UploadCard key={row.id} row={row} />
      ))}
    </View>
  );
}

function UploadCard({ row }: { row: UploadRow }) {
  const { colors } = useAppTheme();
  const failed = row.stage === "failed";
  const succeeded = row.stage === "succeeded";
  const fraction = uploadRowFraction(row);
  /*
   * The glyph is the only thing on this card that says *which way* the bytes
   * are going before the sentence under it is read, and a download reported by
   * an upward cloud is the kind of small wrongness that makes people distrust
   * the whole readout.
   */
  const moving =
    row.direction === "download" ? "cloud-download" : "cloud-upload";
  // A finished download that landed somewhere openable opens on tap, the same
  // as its notification — see `openSavedFile`.
  const openUri = succeeded ? row.openUri : undefined;

  return (
    <Animated.View
      className="overflow-hidden rounded-2xl border border-border bg-card"
      entering={FadeInUp.duration(180)}
      exiting={FadeOutUp.duration(160)}
      // Keeps the remaining rows from jumping when one above them expires.
      layout={LinearTransition.duration(180)}
      style={{
        elevation: 4,
        shadowColor: "#000",
        shadowOffset: { height: 2, width: 0 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
      }}
    >
      <View className="flex-row items-center gap-3 px-4 py-3">
        <Glyph
          color={failed ? colors.destructive : succeeded ? colors.success : colors.primary}
          name={failed ? "alert-circle" : succeeded ? "checkmark-circle" : moving}
          size={20}
        />

        <Pressable
          accessibilityRole={openUri ? "button" : undefined}
          className="flex-1"
          disabled={!openUri}
          onPress={() => {
            if (!openUri) {
              return;
            }

            dismissUpload(row.id);
            void openSavedFile({ mimeType: row.openMimeType, path: row.openPath, uri: openUri });
          }}
        >
          <Text variant="label">{row.label}</Text>
          <Text
            className={failed ? "text-destructive" : undefined}
            numberOfLines={2}
            variant="caption"
          >
            {openUri ? `${uploadRowMessage(row)}. Tap to open.` : uploadRowMessage(row)}
          </Text>
        </Pressable>

        {/*
          Dismiss, not cancel. `expo-file-system`'s upload has no abort handle
          once it is in flight, so a "Cancel" that only hid the row would be a
          lie about what happened to the bytes.
        */}
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => dismissUpload(row.id)}
        >
          <Glyph color={colors.mutedForeground} name="close" size={18} />
        </Pressable>
      </View>

      {/* A hairline rather than a full bar: it is a progress readout, not a
          control, and a chunky bar on a floating card reads as a dialog. */}
      <View className="h-1 bg-muted">
        <View
          className={failed ? "h-1 bg-destructive" : "h-1 bg-primary"}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </View>
    </Animated.View>
  );
}
