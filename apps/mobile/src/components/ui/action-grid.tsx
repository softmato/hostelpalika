import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { FLOAT_SHADOW } from "@/components/portal-shared";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The four-up card of tinted glyph cells, and the only shape a menu of
 * destinations takes in this app.
 *
 * `NOTES.md` §3 is the most consistent thing in the whole reference set: a menu
 * of destinations is **always** a grid of tinted glyphs with a short label, and
 * never full-width rows carrying a sentence each. Admin Home is built out of
 * three of these — the shortcut row, the queue row and the Manage grid — and
 * they are deliberately one object at three lengths.
 *
 * It lived in `admin-home.tsx` until the resident Home was taken to the same
 * shape. Nothing about it was ever admin-specific: a cell is a glyph, a label,
 * an optional count and a destination. What each portal supplies is the list.
 *
 * ## The rules that came with it, and must survive being moved
 *
 * - **A zero count goes grey whatever the tone.** A screen showing coloured
 *   pills that read `0` teaches people to ignore the colour on the day one of
 *   them is not.
 * - **A destination carries no count at all.** `badge` is omitted, not passed as
 *   zero, for a cell that is a door rather than a queue — the two read as
 *   different kinds of thing at a glance, which is exactly what they are.
 * - **Rows are chunked explicitly, never wrapped.** See `<ActionTiles>`.
 */

/**
 * The tints, one per meaning.
 *
 * A row of four identically-coloured tiles is read word by word; four colours
 * are recognised by position after about two uses, which is the entire point of
 * a shortcut row. They are the app's existing semantic tones rather than four
 * decorative ones — money is the money colour, the night roster is the warning
 * colour — so nothing here invents a fifth meaning for a colour used elsewhere.
 *
 * `admin` and `resident` are the two role accents a home screen paints with.
 * Both are written out in full because NativeWind compiles its stylesheet from a
 * build-time scan of the source: a class assembled at runtime resolves to
 * nothing, silently.
 */
export const ACTION_TONES = {
  admin: "bg-role-admin-soft",
  brand: "bg-brand-soft",
  danger: "bg-destructive-soft",
  resident: "bg-role-resident-soft",
  success: "bg-success-soft",
  warning: "bg-warning-soft",
} as const;

export type ActionTone = keyof typeof ACTION_TONES;

/**
 * The white card every four-up row sits in.
 *
 * There are three of them on a home screen — the shortcuts, the queues and the
 * grid — and they are deliberately the same object: one bordered card, four
 * evenly-spaced icon cells, no dividers. It replaced a grid of four *separate*
 * bordered tiles under "Waiting for you", which put four card edges on the
 * screen where the row above had one, so two things that behave identically
 * looked like different kinds of thing.
 *
 * No padding of its own beyond the shell — the shortcut row supplies its own
 * horizontal inset because it sits outside the page's padded body, and the queue
 * row is inside it.
 */
export const ACTION_CARD = "rounded-3xl border border-border bg-card px-2 py-4";

/**
 * Cells per row, for every one of the three cards.
 *
 * Written once because it is one decision: the shortcut row, the queue row and
 * the service grid are the same object at three lengths, and a grid that quietly
 * used a different pitch from the rows above it would read as a second design.
 */
export const ACTION_COLUMNS = 4;

/** The single-row shell. Hand it `<ActionCell>`s. */
export function ActionCard({ children }: { children: ReactNode }) {
  return (
    <View className={`flex-row items-start gap-1 ${ACTION_CARD}`} style={FLOAT_SHADOW}>
      {children}
    </View>
  );
}

/** Four evenly-spaced cells. `flex-1` each, so they shrink to fit the gap. */
export function ActionRow({ children }: { children: ReactNode }) {
  return <View className="flex-row items-start gap-1">{children}</View>;
}

export function ActionCell({
  badge,
  glyph,
  icon,
  label,
  onPress,
  onPressIn,
  selected,
  tone,
}: {
  /**
   * A count on the glyph. Omit entirely for a cell that is a door rather than a
   * queue — `Today` has no single number meaning "how much of that is waiting",
   * and a cell with a count and a cell without read as different kinds of thing
   * at a glance, which is exactly what they are.
   */
  badge?: number;
  glyph: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  /**
   * Touch-down, before the press resolves.
   *
   * Used for one thing only: starting the fetch the destination is about to
   * make. A finger resting on a tile is 100–300ms of head start, which is most
   * of the gap between tapping a tile and reading the screen behind it — and
   * unlike a launch-time warm-up it costs nothing for the tiles nobody touches.
   *
   * It must stay side-effect-free beyond that. This fires on a press that is
   * then dragged off and cancelled, so anything that *changes* something here
   * would happen without the user ever having chosen it.
   */
  onPressIn?: () => void;
  /**
   * Turns the cell from a door into a choice: the glyph fills with the brand
   * colour and the label goes bold. For a grid that *picks* one of several —
   * the spending categories on Add expense — where the alternative was a second
   * tile component with the same glyph, label and pitch. Omit it for a menu:
   * `undefined` draws exactly what this cell always drew.
   */
  selected?: boolean;
  tone: ActionTone;
}) {
  const { colors } = useAppTheme();
  const quiet = badge === 0;

  return (
    <Pressable
      accessibilityLabel={[label, badge === undefined ? null : `${badge} waiting`]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      className="flex-1 items-center gap-2 active:opacity-70"
      onPress={() => {
        onPress();
      }}
      onPressIn={onPressIn}
    >
      <View
        className={`h-12 w-12 items-center justify-center rounded-2xl ${
          selected ? "bg-primary" : ACTION_TONES[tone]
        }`}
      >
        <Ionicons color={selected ? colors.primaryForeground : glyph} name={icon} size={21} />

        {/*
          On the glyph's shoulder, where every phone home screen has trained
          people to look for "how many" — and a zero goes grey whatever the tone,
          because a row of coloured pills reading `0` teaches people to ignore
          the colour on the day one of them is not.
        */}
        {badge === undefined ? null : (
          <View
            className={`absolute -right-1.5 -top-1.5 h-5 items-center justify-center rounded-full px-1.5 ${
              quiet ? "bg-muted" : "bg-destructive"
            }`}
            // A style rather than `min-w-[20px]` — see the note in `<CardRow>`.
            style={{ minWidth: 20 }}
          >
            <Text
              className={`font-bold ${quiet ? "text-muted-foreground" : "text-white"}`}
              style={{ fontSize: 11 }}
            >
              {badge}
            </Text>
          </View>
        )}
      </View>

      {/*
        Two lines are allowed and they are set tight. `Payments to check` does
        not fit one line in a quarter of the card, and at the class default's
        leading the wrapped word floated so far below the first line that the
        cell stopped reading as one label — 14 points closes it up and keeps
        every cell in the row the same height.
      */}
      <Text
        className={`text-center ${selected ? "font-bold text-primary" : "font-medium text-foreground"}`}
        numberOfLines={2}
        style={{ fontSize: 11, lineHeight: 14 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export type ActionTile = {
  badge?: number;
  glyph: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Stable across renders. The destination's href does fine. */
  key: string;
  label: string;
  onPress: () => void;
  onPressIn?: () => void;
  /** See `<ActionCell selected>`. */
  selected?: boolean;
  tone: ActionTone;
};

/**
 * A list of destinations as one card of rows.
 *
 * ## Rows are chunked and written out — not `flex-wrap` over the whole list
 *
 * Wrapping was the obvious construction and it shipped a card with its second
 * row hanging *outside* the white surface: React Native's wrap does not grow the
 * container to the height of the lines it created, so the card drew itself
 * around the first four and the rest fell onto the page below it. Explicit rows
 * are also the same construction as the single-row cards above, which is what
 * keeps all three in step — and it is why the count is `ACTION_COLUMNS` here
 * whatever length the list happens to be.
 */
export function ActionTiles({ tiles }: { tiles: readonly ActionTile[] }) {
  const rows: ActionTile[][] = [];

  for (let index = 0; index < tiles.length; index += ACTION_COLUMNS) {
    rows.push(tiles.slice(index, index + ACTION_COLUMNS));
  }

  return (
    <View className={`gap-5 ${ACTION_CARD}`} style={FLOAT_SHADOW}>
      {rows.map((row) => (
        <ActionRow key={row[0].key}>
          {row.map((tile) => (
            <ActionCell
              badge={tile.badge}
              glyph={tile.glyph}
              icon={tile.icon}
              key={tile.key}
              label={tile.label}
              onPress={tile.onPress}
              onPressIn={tile.onPressIn}
              selected={tile.selected}
              tone={tile.tone}
            />
          ))}

          {/*
            Empty cells padding the short last row.

            Every cell is `flex-1`, so a row of one would draw a single tile
            stretched across the whole card — three times the width of the eight
            above it, and reading as a different kind of control rather than as
            the last item in a grid. The spacers keep the column pitch.
          */}
          {Array.from({ length: ACTION_COLUMNS - row.length }, (_, index) => (
            <View className="flex-1" key={`gap-${index}`} />
          ))}
        </ActionRow>
      ))}
    </View>
  );
}
