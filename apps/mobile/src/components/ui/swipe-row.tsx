import { type ReactNode, useCallback, useRef } from "react";
import { Pressable, View } from "react-native";
import Swipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * A row you can pull to the left to uncover one action on its right.
 *
 * ## Why the action hides
 *
 * The roster row already spends its width on a face, a name, a room, a phone
 * number and a status — the four things that let somebody find a person. A
 * permanent call button would take a fifth column from the one row on the screen
 * that is already tightest, to serve the *second* thing an admin does with a
 * resident rather than the first. Hiding it behind a swipe is the pattern every
 * mail and messaging app on the phone already teaches, so it costs no
 * explanation, and it leaves the tap doing the obvious thing: opening the record.
 *
 * ## Only when there is something to do
 *
 * Callers must not render this around a row whose action would not work — a
 * resident with no phone number gets a plain row, not a swipe that reveals a
 * button that cannot dial. A gesture that sometimes uncovers a dead control is
 * worse than one that is sometimes absent, because the dead control is only
 * discovered after the pull.
 *
 * ## It closes itself
 *
 * `onPress` runs with the panel closing, so coming back from the dialler — or
 * from the record, if the tap went there instead — does not find a row still
 * hanging open from a gesture made a minute ago.
 */
export function SwipeRow({
  actionIcon,
  actionLabel,
  children,
  onAction,
  tone = "primary",
}: {
  actionIcon: GlyphName;
  /** One short word. It sits under the glyph, so it has room for one. */
  actionLabel: string;
  children: ReactNode;
  onAction: () => void;
  tone?: "destructive" | "primary";
}) {
  const { colors } = useAppTheme();
  const ref = useRef<SwipeableMethods>(null);

  const press = useCallback(() => {
    ref.current?.close();
    onAction();
  }, [onAction]);

  const renderAction = useCallback(
    () => (
      <View className="justify-center py-0.5 pl-2">
        <Pressable
          accessibilityLabel={actionLabel}
          accessibilityRole="button"
          className="h-full items-center justify-center gap-1 rounded-2xl px-4 active:opacity-85"
          onPress={press}
          style={{
            backgroundColor: tone === "destructive" ? colors.destructive : colors.primary,
            // Wide enough for the glyph and its word, and narrow enough that the
            // row underneath is still readable while the panel is open.
            width: 84,
          }}
        >
          <Glyph color="#ffffff" name={actionIcon} size={20} />
          {/* White on the filled action in both themes — `button.tsx` writes the
              same literal for the same reason: the palette has no foreground
              token for these fills. */}
          <Text className="text-xs font-semibold" style={{ color: "#ffffff" }}>
            {actionLabel}
          </Text>
        </Pressable>
      </View>
    ),
    [actionIcon, actionLabel, colors.destructive, colors.primary, press, tone],
  );

  return (
    <Swipeable
      // Below the default 2: the panel is one button wide, and a stiff row makes
      // people pull twice before they believe anything is under there.
      friction={1.6}
      overshootRight={false}
      ref={ref}
      renderRightActions={renderAction}
      // Released past a third of the button's width and it opens the rest of the
      // way, rather than demanding the full pull.
      rightThreshold={32}
    >
      {children}
    </Swipeable>
  );
}
