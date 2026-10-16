import { useState } from "react";
import { Pressable, View } from "react-native";

import {
  HERO_AMOUNT_LEAD_TRIM,
  HERO_LINE_GAP,
  PaintedAmount,
  PortalHeroCard,
} from "@/components/portal-shared";
import { PersonAvatar } from "@/components/ui/avatar";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { formatMoney, heroAmountSize, maskMoney } from "@/lib/format";

/**
 * The guardian portal's front door, and the third portal to lead with the same
 * card.
 *
 * ## Why this is `<PortalHeroCard>` and not another bordered box
 *
 * Guardian Home opened with `<GuardianWardCard>` — a plain white card holding an
 * avatar, three lines and a `Call` button — under a 16-point `AppBar`. Beside
 * the admin's painted hostel hero and the resident's painted stay hero, the
 * portal a **parent** uses was the one that looked unfinished, and it is the
 * portal whose users are least forgiving of an app that looks unfinished about
 * their child.
 *
 * So it is the same object the other two lead with: the account card from
 * `ebl-01` (`NOTES.md` §2) — an identity block, a state pill, one big figure, a
 * quiet line, and a themed second register below a rule. What differs is the
 * content, which is the whole of the difference between the roles.
 *
 * ## No photograph of the building, deliberately
 *
 * `GuardianDashboard.hostel` carries a name, a contact and a location and **no
 * photo URL**. `<PortalHeroCard>` draws `HeroOrnament` — two soft discs bled off
 * the edges — whenever `photoUrl` is null, which is exactly the fallback texture
 * this needs. Adding a photo field to the guardian payload would mean shipping
 * the building's picture to an account that is not a resident of it, for
 * decoration.
 *
 * The *ward's* face is a different thing and does lead the card: it is their
 * own child, the picture the resident chose for themselves, and it is the one
 * piece of this screen a parent recognises before reading a word of it.
 *
 * ## The figure is conditional, and the card does not pretend otherwise
 *
 * `summary` is `null` — not a zeroed summary — when the resident has not shared
 * fees, and the whole money block is then absent rather than drawn as `NPR 0`.
 * A parent shown a zero would read "nothing is owed", which is a statement about
 * their child's rent that this app has no basis for making. Absent is the honest
 * shape, and `sharedSections` on the More tab is where a guardian finds out
 * which flags are off.
 */
export function GuardianWardHero({
  dueAmount,
  hostelName,
  nightLabel,
  onToggleAmount,
  relation,
  roomLabel,
  unpaidCount,
  wardImage,
  wardName,
  footer,
}: {
  /** `summary.dueAmount`, or `null` when fees are not shared. */
  dueAmount: number | null;
  hostelName: string | null;
  /** Tonight's answer, or `null` when night status is not shared. */
  nightLabel: string | null;
  onToggleAmount?: () => void;
  /** `mother`, `father`, `guardian` — already lower-cased by the caller. */
  relation: string;
  roomLabel: string;
  unpaidCount: number;
  /** Their `User.image`, or null. Drawn as an initial when they have no photo. */
  wardImage?: string | null;
  wardName: string;
  /** The themed lower register — the call action. */
  footer?: React.ReactNode;
}) {
  /*
   * Hidden until asked for, as on both the other heroes. A parent opens this at
   * work, on a bus, with somebody beside them, and what it leads with is what
   * their child owes. Component state rather than persisted: it covers itself
   * again next launch, which is what every banking app this card is modelled on
   * does.
   */
  const [shown, setShown] = useState(false);
  const real = dueAmount === null ? "" : formatMoney(dueAmount);
  const amount = shown ? real : maskMoney(real);

  return (
    <PortalHeroCard footer={footer} photoUrl={null}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1" style={{ gap: HERO_LINE_GAP }}>
          <View className="flex-row items-center gap-2.5">
            <PersonAvatar image={wardImage} name={wardName} size="sm" />

            <Text
              className="flex-1 font-semibold text-white"
              numberOfLines={1}
              style={{ fontSize: 18 }}
            >
              {wardName}
            </Text>
          </View>

          {/*
            Two rows with a glyph each rather than one string joined by a `·`.
            The resident hero learnt this on a device: joined, the line does not
            fit beside a state pill on a 360dp phone and wraps in the middle of
            whichever fact is longest — and a hostel's name is the longest string
            on this card by some distance.
          */}
          <View className="gap-1.5">
            {[
              { icon: "business", text: hostelName ?? "Their hostel" },
              { icon: "bed", text: roomLabel },
              { icon: "people", text: `You are their ${relation}` },
            ].map((row) => (
              <View className="flex-row items-center gap-1.5" key={row.icon}>
                <Glyph
                  color="rgba(255,255,255,0.75)"
                  name={row.icon as GlyphName}
                  size={12}
                />
                <Text
                  className="flex-1 text-white/80"
                  numberOfLines={1}
                  style={{ fontSize: 13, letterSpacing: 0.3 }}
                >
                  {row.text}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/*
          Tonight's answer as a frosted pill, and **only when it is shared**. The
          absence is the message when it is not: a pill reading "Unknown" on a
          parent's home screen is worse than no pill, because it looks like an
          answer.

          A word, never a time. `safety.asOf` is truncated to a day by the
          serializer on purpose — PHASES.md §4.1 treats the exact minute a
          resident was checked as surveillance rather than reassurance — and
          nothing on this card may derive one from it.
        */}
        {nightLabel ? (
          <View className="rounded-full bg-white/20 px-3 py-1.5">
            <Text
              className="font-semibold text-white"
              numberOfLines={1}
              style={{ fontSize: 11 }}
            >
              {nightLabel}
            </Text>
          </View>
        ) : null}
      </View>

      {dueAmount === null ? null : (
        <View style={{ gap: 6, marginTop: HERO_AMOUNT_LEAD_TRIM }}>
          <Text
            className="font-semibold uppercase tracking-wider text-white/75"
            numberOfLines={1}
            style={{ fontSize: 11 }}
          >
            Outstanding
          </Text>

          <View className="flex-row items-center gap-2">
            {/*
              Sized from whichever string is actually drawn. Sizing off the real
              figure would set `NPR XXX.xx` in the small type a six-digit number
              needs, and the headline would visibly change size on every toggle.
            */}
            <PaintedAmount size={heroAmountSize(amount)} value={amount} />

            <Pressable
              accessibilityLabel={shown ? "Hide the amount" : "Show the amount"}
              accessibilityRole="button"
              className="-m-2 p-2 active:opacity-60"
              hitSlop={8}
              onPress={() => {                setShown((current) => !current);
                onToggleAmount?.();
              }}
            >
              <Glyph
                color="rgba(255,255,255,0.9)"
                name={shown ? "eye" : "eye-off"}
                size={17}
              />
            </Pressable>
          </View>

          {/*
            One line about the figure above it, and it says who can act on it.
            There is no guardian payment route anywhere in `apps/web` — the web
            dashboard drew a "Make a Payment" button with nothing behind it — so
            the card states the limit rather than offering a control that would
            do nothing.
          */}
          <View className="mt-1.5 flex-row items-center gap-1.5">
            <Glyph color="rgba(255,255,255,0.8)" name="receipt" size={13} />
            <Text
              className="flex-1 text-white/80"
              numberOfLines={1}
              style={{ fontSize: 12 }}
            >
              {unpaidCount > 0
                ? `${unpaidCount} unpaid · settled from their own portal`
                : "Every month billed has been settled"}
            </Text>
          </View>
        </View>
      )}
    </PortalHeroCard>
  );
}

/**
 * The card's second register: the office's number, one tap away.
 *
 * `NOTES.md` §11 — a themed surface inside the same corners, carrying a
 * different kind of information from the paint above it. Here that is the one
 * thing a guardian ever *does* on this screen: ring the hostel. Everything
 * above the rule is something they read.
 *
 * Drawn only when the listing carries a number. The web put a "24/7 Emergency
 * Helpline" headline over a button that dialled nobody, which is worse than no
 * button — a parent who taps it in the one moment they need it learns the app
 * lies.
 */
export function GuardianCallRegister({
  hostelName,
  onCall,
}: {
  hostelName: string | null;
  onCall: () => void;
}) {
  /*
    A resolved token, not a literal. The paint above this rule is white in both
    schemes and its ink is written out; this half is a **themed** surface, so its
    green has to be the one the phone is currently on — `#0a8a4b` is the light
    value and would stay light-green on a dark card.
  */
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={`Call ${hostelName ?? "the hostel"}`}
      accessibilityRole="button"
      className="flex-row items-center justify-between gap-3 px-4 py-3.5 active:opacity-70"
      onPress={() => {        onCall();
      }}
    >
      <View className="flex-1 gap-1">
        <Text
          className="font-semibold uppercase tracking-wider text-muted-foreground"
          numberOfLines={1}
          style={{ fontSize: 10 }}
        >
          Hostel office
        </Text>
        <Text
          className="font-semibold text-foreground"
          numberOfLines={1}
          style={{ fontSize: 15 }}
        >
          {hostelName ?? "Call the hostel"}
        </Text>
      </View>

      <View className="flex-row items-center gap-1.5 rounded-full bg-brand-soft px-3.5 py-2">
        <Glyph color={colors.primary} name="call" size={13} />
        <Text className="font-semibold text-primary" style={{ fontSize: 12 }}>
          Call
        </Text>
      </View>
    </Pressable>
  );
}
