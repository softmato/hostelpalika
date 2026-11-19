import { type ReactNode, useState } from "react";
import {
  Pressable,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The single-line box height, and the floor under a multiline one — the web's
 * `h-11` (docs/DESIGN.md §6 "Fields").
 *
 * A number rather than a `min-h-*` class on the multiline branch: NativeWind
 * compiles the class list at bundle time, and a name nothing else uses can
 * resolve to nothing and take the floor with it. Written this way it cannot.
 */
export const FIELD_HEIGHT = 44;

/**
 * The edge and side inset for a field box, focused or not.
 *
 * The web draws focus as a green edge plus a 1px ring; React Native has no
 * ring, so the edge goes to 2 and the inset gives the extra 1 back — the text
 * does not jump sideways when the caret arrives.
 */
export function fieldBoxStyle(focused: boolean, borderColor: string) {
  return { borderColor, borderWidth: focused ? 2 : 1, paddingHorizontal: focused ? 11 : 12 };
}

/**
 * A labelled field, single-line or multiline — the one field look the web uses
 * (white, 44dp, `rounded-lg`, thin warm-grey `--input` edge, crisp green focus).
 * `Select` and `BirthDateField` draw the same box.
 *
 * ## The box has to be told when it is holding a textarea
 *
 * Callers that want a textarea pass the height straight to the `TextInput`. A
 * tall input inside a fixed-height row that centres its children does not clip:
 * React Native has no `overflow: hidden` by default, so the input overflowed the
 * border and the first line of text was drawn *above* the box, on top of the
 * field's own label. So the row branches: single-line keeps the fixed height
 * and centres, and multiline lets the input's own height define the box, with
 * `FIELD_HEIGHT` as the floor.
 *
 * `textAlignVertical: "top"` is applied here rather than left to callers because
 * it is what stops Android centring a single line of text in a tall box. A
 * caller's own `style` is merged last and still wins.
 */
/**
 * The borders {@link Input.tone} can ask for.
 *
 * One utility per tone and no fill: a tinted *background* on a field reads as a
 * field that cannot be edited, which is the opposite of what every one of these
 * means.
 */
const FIELD_TONES = {
  danger: "destructive",
  success: "success",
  warning: "warning",
} as const;

type InputProps = Omit<TextInputProps, "className"> & {
  error?: string | null;
  hint?: string;
  label?: string;
  /**
   * Drawn inside the field, ahead of the text — the same slot {@link Select}
   * already has, and named the same so a form built from both lines up.
   *
   * A node rather than an icon name, because the marks these forms need are not
   * all one set: `finance/payment-setup` puts a `<WalletMark>` beside an
   * account number while the rest of the form takes a glyph. Size it for a
   * 44dp field — about 16 to 20 points.
   *
   * It is decoration, so it carries no label: the field's own `label` is what a
   * screen reader reads.
   */
  leading?: ReactNode;
  /** "Optional" at the right of the label line, as on the web — never in the label. */
  optional?: boolean;
  /** Renders the show/hide toggle and starts masked. */
  secure?: boolean;
  /**
   * Colours the border without printing a sentence under it.
   *
   * For a field the *screen* has something to say about, where the sentence is
   * already said once, elsewhere, about the group — the claim form's receipt
   * read that fills three fields and leaves one empty.
   *
   * `error` still wins: a validation failure is about this field alone and has
   * its own words, and focus wins over both, because a border that will not
   * follow the caret reads as a field that is not taking input.
   */
  tone?: keyof typeof FIELD_TONES;
  /** Rendered inside the field, after the text — a tick, a calendar glyph. */
  trailing?: ReactNode;
};

/** A field's label: the web's 14px medium line above the box. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <Text variant="label">{children}</Text>;
}

export function Input({
  error,
  hint,
  label,
  leading,
  multiline = false,
  optional = false,
  secure = false,
  onBlur,
  onFocus,
  style,
  tone,
  trailing,
  ...props
}: InputProps) {
  const { colors } = useAppTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const disabled = props.editable === false;

  // A colour value, not a `border-*` class: on the phone the class edge drew black.
  const borderColor = focused
    ? error
      ? colors.destructive
      : colors.primary
    : error
      ? colors.destructive
      : tone
        ? colors[FIELD_TONES[tone]]
        : colors.input;

  return (
    <View className="gap-1.5">
      {label || optional ? (
        <View className="flex-row items-center justify-between gap-2">
          {label ? <FieldLabel>{label}</FieldLabel> : <View />}
          {optional ? <Text variant="caption">Optional</Text> : null}
        </View>
      ) : null}

      <View
        className={`flex-row gap-2 rounded-lg ${disabled ? "bg-muted opacity-60" : "bg-card"} ${
          multiline ? "items-stretch" : "h-11 items-center"
        }`}
        style={[fieldBoxStyle(focused, borderColor), multiline ? { minHeight: FIELD_HEIGHT } : null]}
      >
        {/*
          A row with `gap-2` rather than left padding on the `TextInput`:
          padding would put the caret under the glyph on an empty field.
        */}
        {leading ?? null}

        <TextInput
          className={`flex-1 text-base text-foreground ${multiline ? "" : "h-full"}`}
          multiline={multiline}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry={secure && !revealed}
          /*
            Single-line: no vertical padding. Android adds its own on top of the
            line height, and inside the fixed row that left too little room —
            digits came out clipped top and bottom. The row centres it.
          */
          style={[
            multiline ? { paddingBottom: 10, paddingTop: 10, textAlignVertical: "top" } : { paddingVertical: 0 },
            style,
          ]}
          {...props}
        />

        {secure ? (
          <Pressable
            accessibilityLabel={revealed ? "Hide password" : "Show password"}
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => setRevealed((value) => !value)}
          >
            <Text className="text-primary" variant="label">
              {revealed ? "Hide" : "Show"}
            </Text>
          </Pressable>
        ) : null}

        {trailing ?? null}
      </View>

      {error ? (
        <Text className="text-destructive" variant="caption">
          {error}
        </Text>
      ) : hint ? (
        <Text className={tone === "success" ? "text-success" : undefined} variant="caption">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
