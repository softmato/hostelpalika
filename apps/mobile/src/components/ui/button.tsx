import type { LucideIcon } from "lucide-react-native";
import { ActivityIndicator, Pressable, type PressableProps, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

const VARIANTS = {
  danger: {
    base: "bg-destructive",
    disabled: "bg-destructive opacity-40",
    label: "text-destructive-foreground",
  },
  ghost: {
    base: "bg-transparent",
    disabled: "bg-transparent opacity-40",
    label: "text-primary",
  },
  outline: {
    base: "border border-border bg-transparent",
    disabled: "border border-border bg-transparent opacity-40",
    label: "text-foreground",
  },
  primary: {
    base: "bg-primary",
    disabled: "bg-primary opacity-40",
    label: "text-primary-foreground",
  },
  secondary: {
    base: "bg-secondary",
    disabled: "bg-secondary opacity-50",
    label: "text-secondary-foreground",
  },
} as const;

const SIZES = {
  lg: { label: "text-base", wrapper: "h-14 px-6 rounded-2xl" },
  md: { label: "text-base", wrapper: "h-12 px-5 rounded-xl" },
  sm: { label: "text-sm", wrapper: "h-9 px-3 rounded-lg" },
} as const;

type ButtonProps = Omit<PressableProps, "children" | "style"> & {
  className?: string;
  /** Fires a selection tick on press. Off for destructive flows with their own confirm. */
  haptic?: boolean;
  /** A Lucide glyph ahead of the label, tinted to match it. Hidden while loading. */
  icon?: LucideIcon;
  label: string;
  /**
   * Replaces the size's own type classes on the label — **both** of them, so a
   * caller that wants a quieter weight is not fighting `font-semibold` for
   * specificity.
   *
   * For the rare button whose text should not shout at the size the button
   * needs to be. The complaint screen's Send is the case: it is a full-width
   * `md` because it wants the tap target, but `text-base font-semibold` on a
   * calm screen reads as an alarm. Use it for type only — the tone classes are
   * still appended after this and stay the variant's.
   */
  labelClassName?: string;
  loading?: boolean;
  size?: keyof typeof SIZES;
  variant?: keyof typeof VARIANTS;
};

export function Button({
  className = "",
  disabled,
  haptic = true,
  icon: Icon,
  label,
  labelClassName,
  loading = false,
  onPress,
  size = "md",
  variant = "primary",
  ...props
}: ButtonProps) {
  const { colors } = useAppTheme();
  const tone = VARIANTS[variant];
  const iconColor =
    variant === "primary"
      ? colors.primaryForeground
      : variant === "danger"
        ? "#ffffff"
        : variant === "ghost"
          ? colors.primary
          : colors.foreground;
  const dimensions = SIZES[size];
  // A button mid-request must not accept a second press — double-submitting a
  // payment claim is a real cost, not a cosmetic one.
  const isBlocked = Boolean(disabled) || loading;
  /*
   * Busy is not disabled, and it must not be *painted* as disabled.
   *
   * Both used to take `tone.disabled`, which for `primary` is `bg-primary/40`
   * under a `text-primary-foreground` label — white on 40% green, which is
   * barely a contrast at all. The button appeared to empty itself the instant
   * it was pressed: the label went, the spinner is white on the same wash, and
   * what the cook saw was a pale rectangle. That is the worst possible feedback
   * for the one press on this screen that costs money to repeat, because the
   * obvious reading is that nothing happened and it wants pressing again.
   *
   * So a busy button keeps its full-strength ground and its readable label, and
   * the spinner is the only thing that changes. Disabled still dims, because
   * that one genuinely means "not for you right now".
   */
  const isBusy = loading && !disabled;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled: isBlocked }}
      className={`flex-row items-center justify-center active:opacity-80 ${dimensions.wrapper} ${
        isBlocked && !isBusy ? tone.disabled : tone.base
      } ${className}`}
      disabled={isBlocked}
      onPress={(event) => {
        if (haptic) {
        }

        onPress?.(event);
      }}
      {...props}
    >
      {loading ? (
        <View className="mr-2">
          {/*
            White on the two variants whose ground is a solid colour and whose
            own label is already white. Left to the platform default elsewhere,
            where the ground is transparent or muted.
          */}
          <ActivityIndicator
            color={variant === "primary" || variant === "danger" ? "#ffffff" : undefined}
            size="small"
          />
        </View>
      ) : Icon ? (
        <View className="mr-2">
          <Icon color={iconColor} size={size === "sm" ? 16 : 18} strokeWidth={2} />
        </View>
      ) : null}

      {/*
        `variant={null}`: the button owns its label's type completely.

        With the default `body` variant the label carried `text-base` from the
        variant table *and* the size's own class, and NativeWind settles that
        collision by stylesheet order rather than string order — so `text-base`
        won and `size="sm"` rendered at 16pt like everything else. Stating the
        whole treatment here is the only way the size table means anything.
      */}
      <Text
        className={`${labelClassName ?? `font-semibold ${dimensions.label}`} ${tone.label}`}
        variant={null}
      >
        {label}
      </Text>
    </Pressable>
  );
}
