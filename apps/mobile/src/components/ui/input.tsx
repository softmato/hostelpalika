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
 * The single-line box height, and the floor under a multiline one.
 *
 * A number rather than `h-12` / `min-h-12` on the multiline branch: `h-12` is a
 * class this app uses in a dozen places and is certainly generated, but
 * `min-h-12` appears nowhere else, and NativeWind compiles the class list at
 * bundle time — a name nothing else uses can resolve to nothing and take the
 * floor with it. Written this way it cannot.
 */
const FIELD_HEIGHT = 48;

/**
 * A labelled field, single-line or multiline.
 *
 * ## The box has to be told when it is holding a textarea
 *
 * The bordered row was `h-12` and `items-center` for every field, and callers
 * that wanted a textarea passed the height straight to the `TextInput` —
 * `style={{ height: 132, paddingTop: 12, textAlignVertical: "top" }}` and
 * variants of it, in eight screens. A 132dp input inside a 48dp row that centres
 * its children does not clip: React Native has no `overflow: hidden` by default,
 * so the input **overflowed the border by 42dp in each direction** and the first
 * line of text was drawn *above* the box, on top of the field's own label. The
 * ID card form showed it worst — "Permanent address" rendered its value on the
 * label line with an empty box underneath, which reads as two broken fields
 * rather than one.
 *
 * So the row now branches: single-line keeps the fixed 48dp and centres, and
 * multiline stops constraining the height and lets the input's own height define
 * the box. `FIELD_HEIGHT` is the floor, so a textarea with no height given is
 * still at least as tall as an ordinary field instead of collapsing to one line.
 *
 * `textAlignVertical: "top"` is applied here rather than left to callers because
 * it is not a preference — it is what stops Android centring a single line of
 * text in a tall box, and every caller that remembered it wanted the same thing.
 * A caller's own `style` is merged last and still wins.
 */
/**
 * The borders {@link Input.tone} can ask for.
 *
 * One utility per tone and no fill: a tinted *background* on a field reads as a
 * field that cannot be edited, which is the opposite of what every one of these
 * means — each of them is asking to be looked at, and two of them are asking to
 * be typed in.
 */
const FIELD_TONES = {
  danger: "border-destructive",
  success: "border-success",
  warning: "border-warning",
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
   * all one set: `finance/payment-setup` puts a `<WalletMark>` (an image on a
   * white tile) beside an account number while the rest of the form takes a
   * lucide glyph. Size it for a 48dp field — about 18 to 22 points.
   *
   * It is decoration, so it carries no label: the field's own `label` is what a
   * screen reader reads, and an icon that announced itself would make every row
   * say its own name twice.
   */
  leading?: ReactNode;
  /** Renders the show/hide toggle and starts masked. */
  secure?: boolean;
  /**
   * Colours the border without printing a sentence under it.
   *
   * For the case `error` cannot express: a field the *screen* has something to
   * say about, where the sentence is already said once, elsewhere, about the
   * group. The claim form is the case it exists for — a receipt read fills
   * three fields and leaves one empty, and the resident has to be shown *which*
   * of them still wants an answer while a single notice at the top explains
   * why. Four red captions repeating one banner is not that.
   *
   * `error` still wins: a validation failure is about this field alone and has
   * its own words, and focus wins over both, because a border that will not
   * follow the caret reads as a field that is not taking input.
   */
  tone?: keyof typeof FIELD_TONES;
  /** Rendered inside the field, after the text — a tick, a calendar glyph. */
  trailing?: ReactNode;
  /**
   * `line` drops the box for a bare value over a hairline, with a small caps
   * label: the minimal form style of the ID card flow.
   */
  variant?: "box" | "line";
};

/** The small uppercase label a `line` field sits under. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </Text>
  );
}

export function Input({
  error,
  hint,
  label,
  leading,
  multiline = false,
  secure = false,
  onBlur,
  onFocus,
  style,
  tone,
  trailing,
  variant = "box",
  ...props
}: InputProps) {
  const line = variant === "line";
  const { colors } = useAppTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const borderTone = error
    ? "border-destructive"
    : focused
      ? "border-primary"
      : tone
        ? FIELD_TONES[tone]
        : "border-border";

  return (
    <View className={line ? "gap-1" : "gap-1.5"}>
      {/* A `line` label sits in the field as its placeholder and floats up once there is something to label. */}
      {label ? (
        line ? (
          <View style={{ opacity: focused || props.value ? 1 : 0 }}>
            <FieldLabel>{label}</FieldLabel>
          </View>
        ) : (
          <Text variant="label">{label}</Text>
        )
      ) : null}

      <View
        className={`flex-row gap-2 ${line ? "border-b" : "rounded-xl border bg-card px-4"} ${
          multiline ? "items-stretch" : line ? "h-11 items-center" : "h-12 items-center"
        } ${borderTone}`}
        style={multiline ? { minHeight: FIELD_HEIGHT } : undefined}
      >
        {/*
          Above the input, not inside it. A leading node in the same row keeps the
          48dp height and the text simply starts after it — which is why this is a
          row with `gap-2` rather than left padding on the `TextInput`: padding
          would put the caret under the glyph on an empty field.
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
            line height, and inside the fixed 44/48dp row that left too little
            room — digits came out clipped top and bottom. The row centres it.
          */
          style={[
            multiline ? { paddingTop: line ? 8 : 12, textAlignVertical: "top" } : { paddingVertical: 0 },
            style,
          ]}
          {...props}
          placeholder={line && label && !focused ? label : props.placeholder}
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
