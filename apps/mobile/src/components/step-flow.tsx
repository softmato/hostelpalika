import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ComponentProps, useState, type ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";
import Animated, {
  FadeIn,
  FadeInLeft,
  FadeInRight,
  ReduceMotion,
  ZoomIn,
} from "react-native-reanimated";

import { AppBar } from "@/components/ui/app-bar";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";

/**
 * The pieces of a one-question-group-at-a-time flow. Built for the ID card
 * (`app/id-card/edit.tsx`) and shared with hostel registration and the
 * service-provider application, so the three read as one app rather than
 * three forms that happen to ask similar things.
 */

/**
 * One step: a "Step n of N" bar, the step's heading, and its fields sliding in
 * from the side they came from. Keyed on the step so each mounts fresh — only
 * `entering` animates, because two stacked forms inside a scroll view is a jump
 * rather than a transition.
 */
export function StepFrame({
  actions,
  bar = false,
  barLabel,
  children,
  footer,
  forward,
  onBack,
  position,
  scrollEnabled,
  stepKey,
  subtitle,
  title,
  total,
}: {
  actions?: ReactNode;
  /** A segmented progress bar for the header instead of the "Step n of N" title. */
  bar?: boolean;
  /** Under the bar. Defaults to "Step n of N". */
  barLabel?: string;
  children: ReactNode;
  footer: ReactNode;
  forward: boolean;
  onBack: () => void;
  /** 1-based. */
  position: number;
  scrollEnabled?: boolean;
  stepKey: string;
  subtitle: string;
  title: string;
  total: number;
}) {
  return (
    <Screen
      footer={footer}
      header={
        bar ? (
          <StepBar
            label={barLabel ?? `Step ${position} of ${total}`}
            onBack={onBack}
            position={position}
            total={total}
          />
        ) : (
          <AppBar
            actions={actions}
            centerTitle
            onBack={onBack}
            showBack
            title={`Step ${position} of ${total}`}
          />
        )
      }
      scroll
      scrollEnabled={scrollEnabled}
    >
      <Animated.View
        className="gap-6 pb-4 pt-2"
        entering={(forward ? FadeInRight : FadeInLeft)
          .duration(220)
          .reduceMotion(ReduceMotion.System)}
        key={stepKey}
      >
        <View className="gap-1">
          <Text variant="title">{title}</Text>
          <Text variant="muted">{subtitle}</Text>
        </View>
        {children}
      </Animated.View>
    </Screen>
  );
}

/** Back, and one segment per step filled in green up to this one. */
function StepBar({
  label,
  onBack,
  position,
  total,
}: {
  label: string;
  onBack: () => void;
  position: number;
  total: number;
}) {
  const { colors } = useAppTheme();
  const insets = useSystemInsets();

  return (
    <View className="flex-row items-center gap-2 bg-background pb-2 pl-2 pr-5" style={{ paddingTop: insets.top + 4 }}>
      <Pressable
        accessibilityLabel="Back"
        accessibilityRole="button"
        className="h-11 w-11 items-center justify-center rounded-full active:bg-muted"
        onPress={onBack}
      >
        <Ionicons color={colors.foreground} name="arrow-back" size={22} />
      </Pressable>
      <View
        accessibilityLabel={label}
        accessibilityRole="progressbar"
        accessibilityValue={{ max: total, min: 0, now: position }}
        className="flex-1 gap-1.5 pt-3"
      >
        <View className="flex-row gap-1">
          {Array.from({ length: total }, (_, at) => (
            <View className={`h-1.5 flex-1 rounded-full ${at < position ? "bg-primary" : "bg-muted"}`} key={at} />
          ))}
        </View>
        <Text variant="caption">{label}</Text>
      </View>
    </View>
  );
}

/**
 * A field's label, always shown — the floating `line` label disappears into an
 * empty field, and a form of blank lines does not say what it is asking. The
 * dot marks a required answer; `children` sit at the end of the line.
 */
export function FieldHead({
  children,
  label,
  required = false,
}: {
  children?: ReactNode;
  label: string;
  required?: boolean;
}) {
  return (
    <View className="min-h-5 flex-row items-center gap-2">
      <Text className="flex-1 text-sm text-muted-foreground" variant={null}>
        {label}
        {required ? <Text className="text-primary" variant={null}>{"  ●"}</Text> : null}
      </Text>
      {children}
    </View>
  );
}

/** A `line` {@link Input} under a {@link FieldHead}. */
export function Field({
  aside,
  label,
  required,
  variant = "line",
  ...input
}: Omit<ComponentProps<typeof Input>, "label"> & {
  /** End of the label line — a "From map" tag. */
  aside?: ReactNode;
  label: string;
  required?: boolean;
}) {
  return (
    <View className="gap-0.5">
      <FieldHead label={label} required={required}>
        {aside}
      </FieldHead>
      <Input accessibilityLabel={label} variant={variant} {...input} />
    </View>
  );
}

/**
 * − n +, for a count. The number is typed as well as stepped: twenty rooms is
 * twenty taps otherwise. Values are the form's strings; blank reads as 0.
 */
export function NumberStepper({
  error = false,
  label,
  max,
  min = 0,
  onChange,
  value,
}: {
  error?: boolean;
  /** Read out, and used for the buttons' "More …" / "Fewer …". */
  label: string;
  max?: number;
  min?: number;
  onChange: (next: string) => void;
  value: string;
}) {
  const { colors } = useAppTheme();
  const count = Number(value) || 0;
  const button = (by: 1 | -1) => {
    const off = by < 0 ? count <= min : max !== undefined && count >= max;

    return (
      <Pressable
        accessibilityLabel={`${by < 0 ? "Fewer" : "More"} — ${label}`}
        accessibilityRole="button"
        className="h-12 w-12 items-center justify-center rounded-xl bg-muted active:opacity-60"
        disabled={off}
        onPress={() => onChange(String(Math.min(max ?? Infinity, Math.max(min, count + by))))}
      >
        <Ionicons color={off ? colors.border : colors.foreground} name={by < 0 ? "remove" : "add"} size={20} />
      </Pressable>
    );
  };

  return (
    <View className="flex-row items-center gap-1.5">
      {button(-1)}
      <TextInput
        accessibilityLabel={label}
        className={`border-b text-center font-semibold ${error ? "border-destructive text-destructive" : "border-border text-foreground"}`}
        inputMode="numeric"
        maxLength={5}
        onChangeText={(text) => onChange(text.replace(/\D/g, ""))}
        placeholder="0"
        placeholderTextColor={colors.mutedForeground}
        selectTextOnFocus
        /*
          Sized here, not with `text-lg`: that class brings a 28pt line height,
          and inside Android's default vertical padding the digits were clipped
          top and bottom. No padding, no font padding, a line that fits the box.
        */
        style={{
          fontSize: 18,
          fontVariant: ["tabular-nums"],
          height: 48,
          includeFontPadding: false,
          lineHeight: 24,
          minWidth: 56,
          paddingHorizontal: 4,
          paddingVertical: 0,
          textAlignVertical: "center",
        }}
        value={value}
      />
      {button(1)}
    </View>
  );
}

/** Drawn as step 1 itself while the flow loads, so arriving reads as one move. */
export function StepSkeleton({
  bar = false,
  subtitle,
  title,
  total,
}: {
  bar?: boolean;
  subtitle: string;
  title: string;
  total: number;
}) {
  return (
    <Screen
      header={
        bar ? (
          <StepBar label={`Step 1 of ${total}`} onBack={() => router.back()} position={1} total={total} />
        ) : (
          <AppBar centerTitle showBack title={`Step 1 of ${total}`} />
        )
      }
    >
      <View className="gap-6 pt-2">
        <View className="gap-1">
          <Text variant="title">{title}</Text>
          <Text variant="muted">{subtitle}</Text>
        </View>
        {[0, 1, 2, 3].map((row) => (
          <Skeleton height={44} key={row} />
        ))}
      </View>
    </Screen>
  );
}

/**
 * A section that folds away. Closing it only hides the fields — what was typed
 * stays in the draft — and a section holding an error is held open so the red
 * line under a field can never be folded out of sight.
 */
export function Accordion({
  caption,
  children,
  defaultOpen = false,
  forceOpen = false,
  title,
}: {
  caption: string;
  children: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  title: string;
}) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(defaultOpen);
  const shown = open || forceOpen;

  return (
    <View className="border-b border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: shown }}
        className="flex-row items-center gap-3 py-4 active:opacity-70"
        onPress={() => setOpen(!shown)}
      >
        <View className="flex-1 gap-0.5">
          <Text variant="subtitle">{title}</Text>
          <Text variant="caption">{caption}</Text>
        </View>
        <Ionicons
          color={colors.mutedForeground}
          name={shown ? "chevron-up" : "chevron-down"}
          size={20}
        />
      </Pressable>

      {shown ? (
        <Animated.View
          className="gap-6 pb-6"
          entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)}
        >
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A titled group inside a step. */
export function StepSection({
  action,
  caption,
  children,
  title,
}: {
  /** Drawn at the end of the title line — a remove button. */
  action?: ReactNode;
  caption?: string;
  children: ReactNode;
  title: string;
}) {
  return (
    <View className="gap-4 pt-2">
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-0.5">
          <Text variant="subtitle">{title}</Text>
          {caption ? <Text variant="caption">{caption}</Text> : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

/**
 * One step on Review, folded: done tick, title, Edit. Tapping the row opens
 * what was entered, read-only — a review that is also editable is the same
 * wall of fields the steps took apart. Edit is the only way back into a step.
 */
export function ReviewFold({
  children,
  complete,
  divider,
  onEdit,
  onToggle,
  open,
  title,
}: {
  children: ReactNode;
  complete: boolean;
  divider: boolean;
  onEdit: () => void;
  onToggle: () => void;
  open: boolean;
  title: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View>
      {divider ? <View className="mx-4 h-px bg-border/20" /> : null}
      <View className="flex-row items-center gap-3 py-3.5">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          className="flex-1 flex-row items-center gap-3 active:opacity-70"
          onPress={onToggle}
        >
          <Ionicons
            color={complete ? colors.primary : colors.warning}
            name={complete ? "checkmark-circle" : "alert-circle"}
            size={22}
          />
          <Text className="flex-1" variant="label">
            {title}
          </Text>
          <Ionicons
            color={colors.mutedForeground}
            name={open ? "chevron-up" : "chevron-down"}
            size={18}
          />
        </Pressable>
        <Pressable hitSlop={10} onPress={onEdit}>
          <Text className="text-primary" variant="label">
            Edit
          </Text>
        </Pressable>
      </View>

      {open ? (
        <Animated.View
          className="gap-2.5 pb-4 pl-9"
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
        >
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Label-and-value lines inside an opened {@link ReviewFold}. */
export function FactRows({
  facts,
}: {
  facts: readonly (readonly [string, string])[];
}) {
  return (
    <>
      {facts.map(([label, value], position) => (
        <View className="flex-row gap-3" key={`${label}-${position}`}>
          <Text className="w-32" variant="caption">
            {label}
          </Text>
          <Text className="flex-1 text-foreground" variant="caption">
            {value}
          </Text>
        </View>
      ))}
    </>
  );
}

/** Under the review rows: what still needs fixing, and a tap straight to it. */
export function ReviewVerdict({
  incomplete,
  onFix,
}: {
  /** The first unfinished step's title, or `null` when everything is done. */
  incomplete: string | null;
  onFix: () => void;
}) {
  const { colors } = useAppTheme();

  return incomplete ? (
    <Pressable
      className="flex-row items-center gap-2 rounded-xl bg-warning-soft px-4 py-3 active:opacity-70"
      onPress={onFix}
    >
      <Ionicons color={colors.warning} name="alert-circle" size={18} />
      <Text className="flex-1 text-warning" variant="label">
        Some details need fixing — {incomplete}
      </Text>
    </Pressable>
  ) : (
    <View className="flex-row items-center gap-2 rounded-xl bg-brand-soft px-4 py-3">
      <Ionicons color={colors.primary} name="checkmark-circle" size={18} />
      <Text className="flex-1 text-primary" variant="label">
        All details look good!
      </Text>
    </View>
  );
}

/**
 * The consent box above a flow's final button. The button stays tappable while
 * this is unticked and answers the tap with a toast — see the callers.
 */
export function TermsAgreement({
  agreed,
  error,
  onChange,
  prefix,
}: {
  agreed: boolean;
  error?: string;
  onChange: (value: boolean) => void;
  /** Everything before "our Terms and Privacy Policy." */
  prefix: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="gap-1.5">
      <View className="flex-row items-start gap-3">
        <Pressable
          accessibilityLabel="I agree to the Terms and Privacy Policy"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agreed }}
          hitSlop={10}
          onPress={() => onChange(!agreed)}
        >
          <Ionicons
            color={agreed ? colors.primary : colors.mutedForeground}
            name={agreed ? "checkbox" : "square-outline"}
            size={22}
          />
        </Pressable>
        <Text
          className="flex-1"
          onPress={() => onChange(!agreed)}
          variant="caption"
        >
          {prefix} our{" "}
          <Text
            className="text-primary"
            onPress={() => router.push("/legal/terms")}
            variant="caption"
          >
            Terms
          </Text>{" "}
          and{" "}
          <Text
            className="text-primary"
            onPress={() => router.push("/legal/privacy")}
            variant="caption"
          >
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
      {error ? (
        <Text className="text-destructive" variant="caption">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** An icon and a line, popping in after `delay` ms — the invitation screens' bullet. */
export function IconPoint({
  delay,
  icon,
  text,
}: {
  delay: number;
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row gap-3">
      <Animated.View
        entering={ZoomIn.delay(delay)
          .springify()
          .reduceMotion(ReduceMotion.System)}
      >
        <Ionicons color={colors.primary} name={icon} size={18} />
      </Animated.View>
      <Text className="flex-1" variant="muted">
        {text}
      </Text>
    </View>
  );
}
