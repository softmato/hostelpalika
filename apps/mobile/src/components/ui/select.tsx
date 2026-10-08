import { Ionicons } from "@expo/vector-icons";
import { type ReactNode, useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { FieldLabel, Input } from "@/components/ui/input";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * A single-choice field: a trigger that reads like an `Input`, and a sheet.
 *
 * ## Not a native picker
 *
 * `@react-native-picker/picker` renders a spinner on iOS and a dropdown on
 * Android, so the same field is two different controls with two different
 * heights and no shared styling — on a form that is otherwise entirely
 * `Input`s, the picker is the row that looks like it came from another app.
 * A sheet is one control on both platforms and inherits the theme.
 *
 * ## Why the trigger mirrors `Input`
 *
 * Same height, same border, same label and error slots. A field that opens a
 * sheet and a field that opens a keyboard should be indistinguishable until
 * they are tapped; anything else makes the form look misaligned.
 */

export type SelectOption<T extends string> = {
  /** Second line in the sheet — what the option means, when the label is terse. */
  description?: string;
  label: string;
  /**
   * Drawn ahead of the label — in the sheet's row, and on the trigger once this
   * option is the chosen one.
   *
   * A node rather than an icon name, because the one list that needs it draws
   * `<WalletMark>` (an image on a white tile), not an `<Ionicons>`.
   *
   * **The same node appears in both places, so size it for the trigger.** The
   * trigger is `h-12`, which leaves room for a mark up to about 28 points; pass
   * anything taller and the field grows past the `<Input>`s either side of it,
   * which is the one thing this component exists not to do. Sharing the node
   * rather than taking two is deliberate — a picker whose mark changes size the
   * moment you choose it reads as two different controls.
   */
  leading?: ReactNode;
  /** Dimmed and untappable, with {@link tag} saying why — "Added". */
  disabled?: boolean;
  /** Options sharing a group sit under one heading, in the order they first appear. */
  group?: string;
  /** Right-aligned and quiet — "2 beds". */
  meta?: string;
  tag?: string;
  value: T;
};

/**
 * The borders {@link Select.tone} can ask for — the same three `Input` draws,
 * because the trigger has to be indistinguishable from the field above it.
 */
const FIELD_TONES = {
  danger: "border-destructive",
  success: "border-success",
  warning: "border-warning",
} as const;

type SelectProps<T extends string> = {
  disabled?: boolean;
  error?: string | null;
  hint?: string;
  label?: string;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  /**
   * Lets a value outside `options` be typed into the search and chosen —
   * returns the row's wording ("Use “Hetauda”"). Implies `searchable`.
   */
  customLabel?: (text: string) => string;
  /** A search field over the options, for a list too long to scan. */
  searchable?: boolean;
  /** Sheet heading. Defaults to `label`. */
  sheetTitle?: string;
  /** Border-only emphasis, said by the screen rather than by a validator. See `Input`. */
  tone?: keyof typeof FIELD_TONES;
  value: T | null | undefined;
  /**
   * `line` matches {@link Input}'s boxless variant. `compact` is a small pill
   * sized to its value, with no label — for a choice that sits beside a
   * section title rather than in a column of fields.
   */
  variant?: "box" | "compact" | "line";
};

export function Select<T extends string>({
  customLabel,
  disabled = false,
  error,
  hint,
  label,
  onChange,
  options,
  placeholder = "Select",
  searchable = false,
  sheetTitle,
  tone,
  value,
  variant = "box",
}: SelectProps<T>) {
  const line = variant === "line";
  const compact = variant === "compact";
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);

  const selected =
    options.find((option) => option.value === value) ??
    // A typed-in value is still the value: shown as itself.
    (customLabel && value ? { label: value, value } : null);

  const choose = useCallback(
    (next: T) => {
      onChange(next);
      // Closed on choice, not on a second Done tap: there is exactly one
      // selection to make and the sheet has nothing left to say afterwards.
      setOpen(false);
    },
    [onChange],
  );

  const borderTone = error
    ? "border-destructive"
    : tone
      ? FIELD_TONES[tone]
      : "border-border";

  return (
    <View className={line ? "gap-1" : "gap-1.5"}>
      {label && !compact ? (
        line ? (
          <View style={{ opacity: selected ? 1 : 0 }}>
            <FieldLabel>{label}</FieldLabel>
          </View>
        ) : (
          <Text variant="label">{label}</Text>
        )
      ) : null}

      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        accessibilityValue={{ text: selected?.label ?? placeholder }}
        /*
          The left inset tightens when there is a mark to show.

          `px-4` in front of a 28-point tile puts the tile where the *text*
          belongs and pushes the label a third of the way across the field. The
          mark takes the gutter instead and the label sits where a leading
          adornment always puts it.
        */
        className={`flex-row items-center active:opacity-80 ${
          compact
            ? "h-9 gap-1 rounded-full border px-3"
            : line
              ? "h-11 gap-2.5 border-b"
              : `h-12 gap-2.5 rounded-xl border bg-card pr-4 ${selected?.leading ? "pl-2.5" : "pl-4"}`
        } ${borderTone} ${disabled ? "opacity-50" : ""}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
      >
        {/*
          The chosen option's own mark, on the trigger.

          Without it the logo a resident just tapped in the sheet vanishes the
          instant they choose it, so the control that is hardest to get right —
          picking the wrong method sends the hostel looking for the payment in
          the wrong statement — is the one that shows the least once it is
          filled in. The confirmation of a choice should look like the choice.
        */}
        {selected?.leading ?? null}

        <Text
          className={`${compact ? "text-sm font-semibold" : "flex-1"} ${selected ? "text-foreground" : "text-muted-foreground"}`}
        >
          {selected?.label ?? (line && label ? label : placeholder)}
        </Text>
        <Ionicons color={colors.mutedForeground} name="chevron-down" size={compact ? 14 : 18} />
      </Pressable>

      {error ? (
        <Text className="text-destructive" variant="caption">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption">{hint}</Text>
      ) : null}

      <OptionSheet
        onChoose={choose}
        onClose={() => setOpen(false)}
        onCustom={customLabel ? (text) => choose(text as T) : undefined}
        customLabel={customLabel}
        open={open}
        options={options}
        searchable={searchable || Boolean(customLabel)}
        title={sheetTitle ?? label}
        value={value}
      />
    </View>
  );
}

/**
 * The sheet half of {@link Select}, for a list opened from something that is
 * not a field — "Add room type" opens it straight from a dashed row.
 */
export function OptionSheet<T extends string>({
  customLabel,
  onChoose,
  onClose,
  onCustom,
  open,
  options,
  searchable = false,
  searchPlaceholder = "Search",
  title,
  value,
}: {
  customLabel?: (text: string) => string;
  onChoose: (value: T) => void;
  onClose: () => void;
  onCustom?: (text: string) => void;
  open: boolean;
  options: readonly SelectOption<T>[];
  searchable?: boolean;
  searchPlaceholder?: string;
  title?: string;
  value?: T | null;
}) {
  const { colors } = useAppTheme();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((option) => `${option.label} ${option.group ?? ""}`.toLowerCase().includes(needle))
    : options;
  const exact = options.some((option) => option.label.toLowerCase() === needle);
  const close = () => {
    setQuery("");
    onClose();
  };

  return (
    // `tall` when searching: a list that shrinks as you type would drag the sheet with it.
    <Sheet bare onClose={close} open={open} tall={searchable} title={title}>
      {searchable ? (
        <View className="px-5 pb-1 pt-3">
          <Input
            autoCapitalize="none"
            autoCorrect={false}
            leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
            onChangeText={setQuery}
            placeholder={searchPlaceholder}
            returnKeyType="search"
            value={query}
          />
        </View>
      ) : null}

      {shown.map((option, at) => (
        <View key={option.value}>
          {option.group && option.group !== shown[at - 1]?.group ? (
            <Text className="px-5 pb-1 pt-4 font-semibold text-foreground" variant={null}>
              {option.group}
            </Text>
          ) : null}
          <SheetRow
            disabled={option.disabled}
            label={option.label}
            leading={option.leading}
            onPress={() => {
              setQuery("");
              onChoose(option.value);
            }}
            selected={option.value === value}
            subtitle={option.description}
            trailing={
              <View className="flex-row items-center gap-2">
                {option.tag ? (
                  <Text className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" variant={null}>
                    {option.tag}
                  </Text>
                ) : null}
                {option.meta ? <Text variant="caption">{option.meta}</Text> : null}
                {option.value === value ? (
                  <Ionicons color={colors.primary} name="checkmark" size={20} />
                ) : null}
              </View>
            }
          />
        </View>
      ))}

      {onCustom && customLabel && needle && !exact ? (
        <SheetRow
          label={customLabel(query.trim())}
          leading={<Ionicons color={colors.primary} name="add-circle-outline" size={22} />}
          onPress={() => {
            const text = query.trim();
            setQuery("");
            onCustom(text);
          }}
        />
      ) : null}

      {searchable && !shown.length && !(onCustom && needle) ? (
        <Text className="px-5 py-6 text-center" variant="muted">
          Nothing matches “{query.trim()}”.
        </Text>
      ) : null}
    </Sheet>
  );
}
