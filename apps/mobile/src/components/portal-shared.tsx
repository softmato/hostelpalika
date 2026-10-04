import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { IconButton } from "@/components/ui/icon-button";
import { CURRENCY_SCALE } from "@/components/ui/money";
import { Text } from "@/components/ui/text";
import { APP_NAME, APP_NAME_PARTS, logo } from "@/constants/branding";
import { adminHero } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";
import type { NightChip } from "@/lib/admin-home";

/**
 * The pieces more than one admin screen draws.
 *
 * ## What this file used to be, and why it shrank
 *
 * It began as `admin-chrome.tsx`: a painted app bar and a painted band of
 * figures, applied to Money, Residents, Today, Alerts and More so the group
 * would feel like one product. It did the opposite. Five tabs whose top two
 * hundred points were identical stopped saying *where you are* — sameness at the
 * top of a screen is not a design system, it is a missing signpost — and the
 * owner's reaction to seeing it on a device was immediate and correct.
 *
 * So the shared *layout* went and the shared *language* stayed. Each tab now has
 * its own shape, chosen from what the screen is for:
 *
 * - **Home** — a full-bleed hero with the hostel's photograph behind it. The
 *   front door, so it names the app and the building.
 * - **Money** — a card inset on all four sides with a shadow under it. A
 *   statement is an object you hold, not a surface you stand on.
 * - **Residents** — search in the bar. A directory is something you look into.
 * - **Alerts** — filter tabs first. An inbox is something you triage.
 * - **Today** — the date in the bar, a progress card under it. A shift.
 * - **More** — no coloured object at all. A list of doors should not shout.
 *
 * What is left here is what genuinely recurs: the lift under a floating card,
 * the paint's colour pair, a frosted figure tile and the night chips. Anything
 * that only one screen uses now lives with that screen.
 */

/**
 * Lift for a card that floats over paint or over a list.
 *
 * Both halves are needed and neither is optional: `elevation` is the only thing
 * Android draws, and the `shadow*` trio is the only thing iOS reads. A card
 * overlapping a saturated ground with no shadow does not read as floating above
 * it — it reads as a hole cut in it.
 */
export const FLOAT_SHADOW = {
  elevation: 8,
  shadowColor: "#000000",
  shadowOffset: { height: 6, width: 0 },
  shadowOpacity: 0.13,
  shadowRadius: 16,
} as const;

/**
 * The admin paint, resolved for the active scheme.
 *
 * Two screens use it and they use it in different shapes — Home bleeds it to the
 * edges, Money insets it into a card — which is exactly why the *colour* is
 * shared and the geometry is not.
 */
export function usePortalPaint() {
  const { isDark } = useAppTheme();

  return isDark ? adminHero.dark : adminHero.light;
}

/**
 * An amount on painted ground, with `NPR` smaller than the digits it prefixes.
 *
 * The white-on-accent counterpart to `<Money>`, and a separate component because
 * that one cannot be used here: its tone classes resolve to `text-foreground`,
 * which is near-black in light mode and invisible on the paint.
 *
 * What the two do share is the **ratio**. `CURRENCY_SCALE` is imported rather
 * than repeated, because the currency being smaller than the figure is one
 * decision — taken from the banking apps our users already have, NOTES.md §4 —
 * and two files disagreeing about it by a hundredth is the kind of drift nobody
 * ever notices on purpose.
 *
 * Sized in points rather than by class: every caller computes its size from the
 * string it is about to draw (`heroAmountSize`), and a class name carries no
 * number to take a fraction of.
 *
 * `lineHeight` is not optional, and 1.25 was nowhere near enough of it — see
 * `LINE_HEIGHT`.
 */
/**
 * How much taller than the font the line box has to be.
 *
 * On a device this was clipping the figure at **both** ends: the zeros came back
 * with flat tops and the thousands comma came back as a full stop, its tail cut
 * off below the baseline. That is a line box shorter than the glyphs it is being
 * asked to hold.
 *
 * Two things were wrong and only one of them was the multiplier.
 *
 * No font is bundled with this app, so every phone renders these figures in
 * whatever face its OS ships, and OEM Android skins ship rounded display faces
 * whose ascent and descent run past the Roboto metrics 1.25 quietly assumes.
 *
 * The larger cause was the **nested** currency span. On Android a `Text` whose
 * children carry different font sizes takes its line box from the smaller span,
 * so a 34-point figure was being laid out in a box measured for its own
 * 24-point `NPR` — which is why the two-up at 16 was perfect while the headline
 * above it lost the tops of its zeros and the tail of its comma. The prefix now
 * carries the parent's `lineHeight` explicitly, which is the whole fix; the
 * multiplier only has to cover the font.
 */
const LINE_HEIGHT = 1.45;

export function PaintedAmount({
  className = "font-semibold tracking-tight text-white",
  size,
  value,
}: {
  className?: string;
  /** Point size of the digits. `NPR` is drawn at `CURRENCY_SCALE` of it. */
  size: number;
  /** Already formatted — `formatMoney`, so a missing figure arrives as `—`. */
  value: string;
}) {
  const lineHeight = Math.round(size * LINE_HEIGHT);

  return (
    <Text className={className} numberOfLines={1} style={{ fontSize: size, lineHeight }}>
      {/*
        A dash is not an amount, it is the absence of one, so it keeps the plain
        treatment rather than being given an `Rs` prefix it never had.

        The prefix is `formatMoney`'s, so the two have to agree on the exact
        string — it was `NPR ` until 2026-09-05.
      */}
      {value.startsWith("Rs ") ? (
        <>
          {/*
            `text-white` is not redundant, and leaving it off is what shipped a
            card with a near-black currency prefix in front of white digits. React Native
            would inherit the parent's colour — but the parent here is our own
            `<Text>`, which defaults to `variant="body"`, and that variant paints
            `text-foreground` on every instance that does not override it. The
            nested one overrides nothing, so it takes the themed foreground:
            correct by the token, invisible on the paint.
          */}
          <Text
            className="text-white"
            style={{ fontSize: Math.round(size * CURRENCY_SCALE), lineHeight }}
          >
            Rs{" "}
          </Text>
          {value.slice(3)}
        </>
      ) : (
        value
      )}
    </Text>
  );
}

/*
 * A `BannerStat` — a frosted tile carrying a 10pt small-caps label, a glyph and
 * a figure — stood here, and Home's hero drew three of them along its bottom
 * edge: residents, vacant beds, occupancy.
 *
 * They went when the hero was taken to the shape of the account card in
 * `ebl-01`, and the reason is worth keeping. That card has **no such tiles**: a
 * balance, the name it belongs to as a quiet line, and one row of two figures.
 * Ours had six figures in four containers under a seventh in a fifth, which is
 * how a card stops being read at a glance and starts being studied. The three
 * counts are context, never a tap target, so they became one line of text under
 * the headline — `occupancyLine` — and the frosted-object treatment stayed
 * where it earns itself, on `GlassPanel` and the identity row.
 *
 * Its one hard-won rule is not tile-specific and still applies to anything set
 * in that 10pt small-caps: about **eleven characters** fit at three-up on a
 * 320dp phone. Twelve came back as `NOT MOVED…` on a device — pick a shorter
 * word rather than a truer one.
 */

/*
 * A `BannerFacts` pair — two figures split by a hairline — lived here and was
 * drawn once, by Home's hero, where it printed "This month" and "Still to
 * collect" directly above a Money section carrying the same two numbers. The
 * shape came back to the hero inline, on its own paint, so this stayed deleted;
 * the hero now prints that same month-and-shortfall pair, and it is no longer a
 * duplicate because the Money section it duplicated moved off Home entirely.
 *
 * Its lesson outlived it and is worth keeping written down: **give each half a
 * fixed fraction of the row, never size the chips to their content.** The first
 * cut wrapped `shrink` chips, and every chip gave up width to its neighbours
 * until all of them ellipsed — `NPR 74,000 this month` came back as
 * `NPR 74,0…`, so the figures the card existed to show were the first thing
 * lost. `AdminMoneyCard` draws the surviving instance of the pattern, on paint
 * of its own, and carries that note with it.
 */

/*
 * An `AttentionRow` lived here — a tinted glyph, a title, a sentence of plain
 * English, a filled count pill and a chevron — and Home drew five of them in one
 * bordered card under the heading "Waiting for you".
 *
 * It was replaced by a two-column grid of `<InfoTile>`s, and the reason is worth
 * keeping: the row was optimised for *reading* and the question it answered was
 * a *looking* question. "Is anything waiting, and roughly how much" is a shape,
 * and five stacked sentences is the slowest possible way to draw a shape. The
 * tiles keep everything the row had that mattered — the tone, the count, the
 * plain-English gloss as a caption — in a quarter of the vertical space.
 *
 * Two of its rules moved into `<InfoTile>` intact and must not be dropped there:
 * **a zero count goes grey whatever the tone**, and **a destination carries no
 * count at all**. Both exist because a screen that shows five coloured pills
 * reading `0` teaches people to ignore the colour on the day one of them is not.
 */

/* -------------------------------------------------------------------------- */
/* Tonight                                                                    */
/* -------------------------------------------------------------------------- */

const CHIP_TONES: Record<NightChip["tone"], { dot: string; text: string; wrap: string }> = {
  danger: {
    dot: "bg-destructive",
    text: "text-destructive",
    wrap: "border-destructive/25 bg-destructive/10",
  },
  neutral: {
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    wrap: "border-border bg-muted",
  },
  success: { dot: "bg-success", text: "text-success", wrap: "border-success/25 bg-success-soft" },
  warning: { dot: "bg-warning", text: "text-warning", wrap: "border-warning/25 bg-warning-soft" },
};

/**
 * Tonight's roster as a wrapped strip of chips.
 *
 * The stack of label/value rows this replaces spent five lines of screen telling
 * a hostel where everyone is accounted for that everyone is accounted for. A
 * chip strip is one line most nights and grows only when something is wrong —
 * and the ordering does the rest of the work: `nightChips` sorts by how much a
 * status needs a person, so an SOS or an unverified resident is the leftmost
 * chip rather than being alphabetised under the thirty-nine who are safely in.
 *
 * Home's summary of the roster; the Today tab draws the same data as a progress
 * card instead, because there it is the thing being worked through rather than a
 * thing being glanced at.
 */
export function NightStrip({ chips }: { chips: readonly NightChip[] }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {chips.map((chip) => {
        const palette = CHIP_TONES[chip.tone];

        return (
          <View
            className={`flex-row items-center gap-2 rounded-full border px-3 py-1.5 ${palette.wrap}`}
            key={chip.key}
          >
            <View className={`h-1.5 w-1.5 rounded-full ${palette.dot}`} />
            <Text className={`text-xs font-medium ${palette.text}`}>{chip.label}</Text>
            <Text className={`text-xs font-bold ${palette.text}`}>{chip.count}</Text>
          </View>
        );
      })}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The hero card                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How much of the building's own photograph shows through the colour.
 *
 * Low on purpose. This is a *ground*, not a picture: white text at five sizes
 * sits on top of it, and every one of them stops being legible over a
 * photograph with its own bright and dark areas.
 *
 * It was 0.24, and on a device that is not texture — the windows are countable,
 * and the two-up figures land on whichever part of the facade happens to be
 * dark. `ebl-01` is the calibration: its mountain is a *ghost*, the card reads
 * as flat colour everywhere text sits, and you notice the photograph second. At
 * 0.11 you can still tell it is your building, which is the whole of what it is
 * there to do.
 */
const PHOTO_WEIGHT = 0.11;

/**
 * The card's geometry, measured off `ebl-01` rather than guessed.
 *
 * The reference screenshot is 576px wide, so every number in it converts by
 * `× 0.625` to points on a 360dp phone. What it gives:
 *
 * | | reference | here |
 * | --- | --- | --- |
 * | side margin | 23px → 14dp (4.0% of the screen) | `HERO_INSET` |
 * | card width | 529px → 331dp (92% of the screen) | whatever is left |
 * | corner | ~15px → 9dp | `HERO_RADIUS`, rounded up |
 * | padding | 24px → 15dp, 29px top, 23px bottom | `HERO_PAD` |
 * | height | 304px → 190dp | falls out of the content |
 *
 * The card was inset 20 and cornered at 26 — narrower than the reference and
 * twice as round, which is what made it read as a lozenge rather than as a bank
 * card. `AdminMoneyCard` keeps 26 for now; if these two ever need to match, this
 * is the measured one.
 */
const HERO_INSET = 14;

const HERO_RADIUS = 18;

const HERO_PAD = { paddingBottom: 18, paddingHorizontal: 16, paddingTop: 20 } as const;

/**
 * The gaps, and why they are this big.
 *
 * The first cut of this card was correct and unreadable: every row was right and
 * the whole thing was a brick. Measuring `ebl-01` says why — its rows sit **19,
 * 14, 28 and 27 points apart** ink to ink, and ours were between four and
 * twelve. A bank card is mostly air; that is the difference between a card you
 * glance at and a paragraph you parse.
 *
 * These are the CSS gaps that land on those ink gaps once line-height slack is
 * accounted for, so they read a few points tighter than the numbers above.
 */
export const HERO_BLOCK_GAP = 20;

export const HERO_LINE_GAP = 10;

/**
 * Pulls the money block up under the identity block.
 *
 * `PaintedAmount` runs a 1.45 line box so the device font's glyphs are not
 * clipped, and about half of that slack lands *above* the digits — so a 20-point
 * block gap measures 20 and reads as nearly 30. This cancels the leading rather
 * than shrinking `HERO_BLOCK_GAP`, which would also close up the gap above the
 * rule, where the space is doing its job.
 */
export const HERO_AMOUNT_LEAD_TRIM = -9;

/**
 * Two soft discs bled off the edges — the fallback texture.
 *
 * A flat ramp behind six elements reads as a coloured rectangle, and every
 * payment card and banking home this screen is modelled on breaks that up
 * somehow. When there is a photograph, the photograph does that job and these
 * would be competing with it, so they are drawn **only** when there is none.
 *
 * `pointerEvents: "none"` and outside the content flow, so nothing above them
 * moves; clipped by the card's `overflow: hidden`, which is also what keeps them
 * inside the rounded corners.
 */
function HeroOrnament() {
  return (
    <View className="absolute inset-0" style={{ pointerEvents: "none" }}>
      <View
        className="absolute rounded-full bg-white/10"
        style={{ height: 190, right: -60, top: -70, width: 190 }}
      />
      <View
        className="absolute rounded-full bg-white/5"
        style={{ bottom: -40, height: 130, left: -30, width: 130 }}
      />
    </View>
  );
}

/**
 * The painted card both home screens lead with: paint, texture, corners, lift.
 *
 * The admin's hostel and the resident's stay are the *same object* — `ebl-01`'s
 * account card — carrying different content: an identity block, a state pill, a
 * big figure, a quiet line and a two-up. Only the content differs, so only the
 * content lives with each portal and everything measured lives here.
 *
 * It was `HostelHero`'s own body until the resident Home was taken to this
 * shape. Duplicating the geometry would have meant two files disagreeing about
 * a corner radius the moment either was touched, and the whole reason these
 * numbers carry a table of measurements is that they are not guesses to be
 * re-guessed.
 *
 * ## The white on it is white, in both schemes
 *
 * This is a painted surface, not a themed one: its foreground is white in light
 * and dark mode alike, and a themed `text-foreground` on it renders near-black
 * on the accent and disappears. `<PaintedAmount>` exists for that reason and
 * every caller's literals should be checked against Tailwind's actual opacity
 * scale — `/15` and `/85` are not on it and silently resolve to nothing.
 */
export function PortalHeroCard({
  children,
  /**
   * A second register, on a themed surface, inside the same corners.
   *
   * `NOTES.md` §11: the reference statement card carries the transaction on
   * paint and the running position below a rule, and "two registers of
   * information in one card" is what stops the lower half needing a sentence of
   * prose to explain itself. It bleeds to the card's edges — outside the padded
   * content above, inside the gradient's `overflow: hidden`, so the bottom
   * corners clip themselves.
   *
   * `bg-card` rather than white: this half is a **themed** surface and inverts
   * with the phone, which is the point of having two registers at all. Anything
   * drawn in here uses ordinary tokens, not the paint's white literals.
   *
   * The admin's hostel card passes none — it is paint top to bottom, and that is
   * now one of the things telling the two home screens apart.
   */
  footer,
  /** The building, as the card's ground. `null` swaps in `HeroOrnament`. */
  photoUrl,
}: {
  children: ReactNode;
  footer?: ReactNode;
  photoUrl: string | null;
}) {
  const paint = usePortalPaint();

  return (
    <View style={{ paddingHorizontal: HERO_INSET }}>
      <LinearGradient
        /*
          Three stops, holding `from` flat for the first 45%: no colour travel at
          all over the half of the card the eye actually lands on — the name and
          the total — so the ramp supports the content instead of competing with
          it.
        */
        colors={[paint.from, paint.from, paint.to]}
        end={{ x: 0, y: 1 }}
        locations={[0, 0.45, 1]}
        start={{ x: 0, y: 0 }}
        style={[FLOAT_SHADOW, { borderRadius: HERO_RADIUS, overflow: "hidden" }]}
      >
        {/*
          The building, under the colour rather than beside it, and only when
          there is one — `HeroOrnament` is the alternative texture, never both.
        */}
        {photoUrl ? (
          <>
            <Image
              contentFit="cover"
              source={{ uri: photoUrl }}
              style={[StyleSheet.absoluteFill, { opacity: PHOTO_WEIGHT }]}
              transition={300}
            />
            {/*
              A darkening wash, faint at the top and strongest at the bottom
              where the smallest text on the card is. A photograph with a bright
              sky in its lower half is what takes a white 10-point label below
              the contrast floor, and it is not a case anybody would think to
              test for.
            */}
            <LinearGradient
              colors={["rgba(0,0,0,0.06)", "rgba(0,0,0,0.34)"]}
              end={{ x: 0, y: 1 }}
              start={{ x: 0, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </>
        ) : (
          <HeroOrnament />
        )}

        <View style={[HERO_PAD, { gap: HERO_BLOCK_GAP }]}>{children}</View>

        {footer ? <View className="bg-card">{footer}</View> : null}
      </LinearGradient>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/** The platform wordmark, in points. */
const WORDMARK = 25;

/** The logo mark beside it, sized to the wordmark's cap height. */
const MARK = 26;

/**
 * The front-door bar of a portal: whose product this is, the hostel's page, and
 * the bell.
 *
 * ## One component, because it was already the same bar four times
 *
 * `AdminHomeHeader` and `ResidentHomeHeader` were byte-for-byte the same view —
 * the same lockup, the same wordmark/mark pair, the same eye, the same bell — declared
 * twice, and the guardian and cook portals were about to become a third and a
 * fourth. Two copies is a thing you fix; four is a thing you stop being able to.
 * Now the mark's size, the wordmark's letter-spacing and the order of the
 * actions cannot drift between roles, because there is one of each.
 *
 * ## Why the platform sits above the hostel, and does not move
 *
 * Two identities are in play and they answer different questions. *HostelPalika* is
 * the app you opened — chrome, identical in every role, and the public side of
 * the app has always drawn it in exactly this spot. The hostel is the *subject*
 * of the page, and it belongs on the card below. Stacking them the other way
 * round makes the app feel like it belongs to whichever hostel loaded.
 *
 * ## It is `bg-background`, never painted
 *
 * This bar was once a flat fill of the hero's first stop, joining seamlessly
 * into a full-bleed card — one green mass from the status bar down, in which the
 * card was not a card but a region. `ebl-01` is unambiguous: the bar is the page
 * background, the card is the only coloured object, and the distance between
 * those two facts is what makes the card look like something you could pick up.
 *
 * ## The eye, and why it is sometimes not there
 *
 * It opens the hostel's public page — the same `hostel/[slug]` screen a stranger
 * browsing the app sees. An eye rather than a globe or a share arrow: both of
 * those promise to leave the app (`hostel-share.ts` builds a real `https://` URL
 * for exactly that, and it is a different action), whereas this pushes a screen
 * inside it.
 *
 * It is drawn only when the caller hands over an `onHostelPage`, and a caller
 * only builds one when it has a slug. That is not caution:
 * `getPublicHostelBySlug` filters on `status: "PUBLISHED"` **and**
 * `verificationStatus: "VERIFIED"`, so a hostel mid-application would answer
 * this tap with "Hostel was not found" — which, to somebody waiting on approval,
 * reads as their hostel having been deleted. Every server payload that feeds
 * this sends `""` rather than a slug in that state, so withholding the door is
 * the default and no screen has to remember the rule.
 *
 * ## `label` is not optional
 *
 * "Preview" alone in a screen reader is a verb with no object, and the object
 * differs by role: an owner is checking *their listing*, a resident is opening
 * *their hostel's page*, a guardian is looking at *their ward's hostel*. The
 * glyph is shared; the sentence a screen reader speaks is the caller's.
 */
export function PortalBrandHeader({
  actions,
  compactBrand = false,
  hostelPageLabel = "Open the hostel's page",
  onHostelPage,
}: {
  /**
   * Slot ahead of the eye and the bell, for a control only one role has.
   *
   * The resident's SOS button is the whole reason it exists — a control that
   * must never move, on the one bar that never scrolls away. Leftmost of the
   * row because the eye is conditional, and an emergency control that shifts
   * position depending on whether the hostel's listing is live is the same
   * problem in a smaller form.
   */
  actions?: ReactNode;
  /** Leave room for the branch control on narrow admin screens. */
  compactBrand?: boolean;
  /** What a screen reader says for the eye. See the note above. */
  hostelPageLabel?: string;
  /** Omitted, and the eye hidden, when there is no live listing to open. */
  onHostelPage?: () => void;
}) {
  const { colors } = useAppTheme();
  const insets = useSystemInsets();

  return (
    <View className="bg-background" style={{ paddingTop: insets.top }}>
      <View className="min-h-14 flex-row items-center gap-2.5 px-5 pb-2 pt-1">
        <Image contentFit="contain" source={logo.mark} style={{ height: MARK, width: MARK }} />

        <View accessibilityLabel={APP_NAME} accessibilityRole="header" className="min-w-0 flex-1">
          <Text numberOfLines={1} adjustsFontSizeToFit={compactBrand} minimumFontScale={0.6} style={{ fontSize: compactBrand ? 18 : WORDMARK, fontWeight: "800", letterSpacing: -0.4 }}>
            <Text style={{ color: colors.foreground }}>{APP_NAME_PARTS.head}</Text>
            <Text style={{ color: colors.primary }}>{APP_NAME_PARTS.tail}</Text>
          </Text>
        </View>

        {actions}

        {onHostelPage ? (
          <IconButton label={hostelPageLabel} name="eye-outline" onPress={onHostelPage} />
        ) : null}

        <NotificationBell />
      </View>
    </View>
  );
}
