import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { isOfflineError } from "@/lib/api-contract";

/**
 * The states every list and detail view has to handle — DESIGN.md §5.
 *
 * They live together so it is obvious when a screen has only implemented two of
 * them. An empty list and a failed request look identical to a user if you let
 * them both render as nothing.
 */

export function LoadingState({ label }: { label?: string }) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-1 items-center justify-center gap-3 py-16">
      <ActivityIndicator color={colors.primary} size="large" />
      {label ? <Text variant="muted">{label}</Text> : null}
    </View>
  );
}

/**
 * The tinted disc every state in this file leads with.
 *
 * ## Why an icon at all
 *
 * These states used to be two lines of centred text, and three of them —
 * "nothing here", "that failed", "you are offline" — read as the same object
 * at a glance. A reader scanning a screen that has just replaced its content
 * needs to know *which kind of nothing* this is before reading a word, and the
 * only channel fast enough for that is shape and colour.
 *
 * Kept to one disc, one glyph, one tone: the reference apps
 * (`NOTES.md` §9) draw an illustration and a pill, and an illustration is a
 * per-state asset nobody will maintain. A tinted circle is the same signal at
 * the cost of a token.
 *
 * The tone classes are literals in a table rather than composed at the call
 * site, for the reason `<Badge>` documents — a `bg-${tone}-soft` template never
 * reaches the compiled NativeWind stylesheet.
 */
const STATE_TONES = {
  danger: { background: "bg-destructive/10", ink: "destructive" },
  muted: { background: "bg-muted", ink: "mutedForeground" },
  success: { background: "bg-success-soft", ink: "success" },
  warning: { background: "bg-warning-soft", ink: "warning" },
} as const;

export type StateTone = keyof typeof STATE_TONES;

function StateIcon({
  name,
  tone,
}: {
  name: GlyphName;
  tone: StateTone;
}) {
  const { colors } = useAppTheme();
  const { background, ink } = STATE_TONES[tone];

  return (
    <View
      className={`h-14 w-14 items-center justify-center rounded-full ${background}`}
    >
      <Glyph color={colors[ink]} name={name} size={26} />
    </View>
  );
}

export function EmptyState({
  action,
  compact = false,
  description,
  icon,
  title,
  tone = "muted",
}: {
  action?: ReactNode;
  /**
   * For an empty state *inside a card*, rather than one holding a whole screen.
   *
   * The full-screen version is `flex-1` and generously padded, which is right
   * when it is the only thing on the page and wrong the moment it is a section:
   * `<Screen scroll>` gives its content container `grow`, so a `flex-1` empty
   * state inside a short page stretches to eat the leftover height, and "Nothing
   * to verify" came out as a 400-point box on a screen with four other sections
   * on it. Compact takes its natural height and pads like a row.
   */
  compact?: boolean;
  description?: string;
  /**
   * The disc's glyph. Omitted deliberately by the compact callers that sit
   * inside a card of rows, where a 56-point circle is taller than the section
   * it is apologising for.
   */
  icon?: GlyphName;
  title: string;
  tone?: StateTone;
}) {
  return (
    <View
      className={`items-center justify-center gap-2 px-8 ${
        compact ? "py-6" : "flex-1 py-16"
      }`}
    >
      {icon ? (
        <View className="pb-1">
          <StateIcon name={icon} tone={tone} />
        </View>
      ) : null}
      <Text className="text-center" variant="subtitle">
        {title}
      </Text>
      {description ? (
        <Text className="text-center" variant="muted">
          {description}
        </Text>
      ) : null}
      {action ? <View className="mt-3">{action}</View> : null}
    </View>
  );
}

export function ErrorState({
  icon = "close-circle",
  message,
  onRetry,
  title = "Something went wrong",
}: {
  icon?: GlyphName;
  message: string;
  onRetry?: () => void;
  /**
   * Overridable so a screen can name the thing that failed — "Couldn’t load
   * methods" tells a resident which half of the screen is missing, where a
   * generic heading makes them re-read the body to find out.
   */
  title?: string;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-8 py-16">
      <View className="pb-1">
        <StateIcon name={icon} tone="danger" />
      </View>
      <Text className="text-center" variant="subtitle">
        {title}
      </Text>
      <Text className="text-center" variant="muted">
        {message}
      </Text>
      {onRetry ? (
        <Button className="mt-2" label="Try again" onPress={onRetry} variant="outline" />
      ) : null}
    </View>
  );
}

/**
 * No network — a different fact from a failed request, and it must not be
 * dressed as one.
 *
 * "Something went wrong" next to a red cross tells a resident on a train that
 * their hostel’s server is broken and invites them to phone about it. The
 * cause is their signal, the fix is theirs, and the only honest control is a
 * retry — so the tone is muted rather than destructive and the heading names
 * the actual condition.
 *
 * Chosen by `isOfflineError()` reading the message `readApiError` produced,
 * rather than by a connectivity listener: there is no NetInfo in this app, and
 * a request that could not reach the server is a stronger signal than a radio
 * that claims to be up. The two cases it catches are a timeout and a request
 * that got no response at all.
 */
export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-8 py-16">
      <View className="pb-1">
        <StateIcon name="cloud-offline" tone="muted" />
      </View>
      <Text className="text-center" variant="subtitle">
        You&apos;re offline
      </Text>
      <Text className="text-center" variant="muted">
        Check your connection and try again.
      </Text>
      {onRetry ? (
        <Button className="mt-2" label="Retry" onPress={onRetry} variant="outline" />
      ) : null}
    </View>
  );
}

/**
 * The failure branch every screen in this app writes, as one component.
 *
 * Five payments screens each had `error ? <ErrorState/> : …` and none of them
 * could tell a dead server from a dead radio. Routing both through here means a
 * screen names its failure once and gets the right one of the two.
 */
export function FailureState({
  message,
  onRetry,
  title,
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  if (isOfflineError(message)) {
    return <OfflineState onRetry={onRetry} />;
  }

  return <ErrorState message={message} onRetry={onRetry} title={title} />;
}

/**
 * A section with nothing in it — the card and the compact empty state together.
 *
 * The pair was written out longhand at every call site, and drifted the way
 * repeated pairs do: `(admin)/today` alone had a section wrapping `EmptyState`
 * in a `Card`, a second one switching the card's padding on the row count so
 * the same `EmptyState` sat in a different inset, and two more explaining
 * emptiness in loose `<Text variant="muted">` prose with no title at all. Four
 * treatments of one idea on one screen.
 *
 * Callers with rows to draw still pass `padding="px-4 py-1"` to their own
 * `Card`, because a card of rows genuinely wants a narrower vertical inset than
 * a card of prose. What has gone is the *conditional* — the empty branch is a
 * different component now, not the same one with different padding.
 */
export function EmptyCard({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <Card>
      <EmptyState action={action} compact description={description} title={title} />
    </Card>
  );
}

/**
 * A section this account is not allowed to see.
 *
 * Deliberately **not** an `EmptyCard`. "No open requests" and "you may not look
 * at the open requests" are different facts, and rendering the second as the
 * first tells a warden their hostel has nothing pending when what actually
 * happened is that somebody did not tick a box in Warden Management. That is
 * the lie this codebase keeps having to un-tell, and it is worth its own
 * component so no screen has to remember to phrase it.
 *
 * The closing sentence matches `DeniedNotice`'s, which says the same thing for
 * a whole queue rather than for one section.
 */
export function PermissionCard({
  capability,
  feature,
}: {
  /** As a person would say it: "night status", "food", "maintenance". */
  capability: string;
  /** The section, capitalised for the start of a sentence: "The roll call". */
  feature: string;
}) {
  return (
    <Card className="gap-1">
      <Text variant="label">{`${feature} is not yours to see`}</Text>
      <Text variant="muted">
        {`It needs the ${capability} permission, which this account does not have. Ask your hostel admin if that looks wrong.`}
      </Text>
    </Card>
  );
}
