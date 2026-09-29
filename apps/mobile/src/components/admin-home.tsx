import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  FLOAT_SHADOW,
  HERO_AMOUNT_LEAD_TRIM,
  HERO_LINE_GAP,
  PaintedAmount,
  PortalBrandHeader,
  PortalHeroCard,
} from "@/components/portal-shared";
import {
  ActionCard,
  ActionCell,
  type ActionTile,
  ActionTiles,
} from "@/components/ui/action-grid";
import { Text } from "@/components/ui/text";
import { roleAccent } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import type { AdminHostel } from "@/lib/admin-api";
import {
  type EarningsSummary,
  heroPhotoUrl,
  hostelCode,
  type MonthDelta,
  occupancyLine,
  trendAxis,
  trendPoints,
  trendSegments,
  trendTickLabel,
  type TrendBar,
} from "@/lib/admin-home";
import { API_BASE_URL } from "@/lib/api";
import { formatMoney, heroAmountSize, maskMoney } from "@/lib/format";
import { absoluteMediaUrl } from "@/lib/media";

/**
 * The parts the admin Home screen is built out of.
 *
 * Split from the screen for the ordinary reason — `index.tsx` was becoming a
 * file where the shape of the page was buried under the drawing of it — and
 * because the pieces below are where the *visual* decisions live, while the
 * screen holds the data ones.
 *
 * ## Two colour systems on one screen, and where the line is
 *
 * Everything from the quick-action card downwards is a themed surface: palette
 * tokens, `bg-card`, `text-foreground`, and it inverts with the phone's theme.
 * The header and hero are **painted** — a coloured object the page scrolls
 * under, the way a bank card is — so their foreground is white in both schemes
 * and their literals are literals. A themed `foreground` up there would be
 * near-black in light mode: correct by the token, unreadable on the gradient.
 *
 * The one place this is easy to get wrong is a shared component landing on the
 * paint, which is why `IconButton` grew a `tone` rather than the header growing
 * its own bell.
 *
 * ## Measured sizes are written as styles, not as `text-[NNpx]`
 *
 * NativeWind compiles its class list from a build-time scan of the source, so an
 * arbitrary value appearing nowhere else in the app is absent from the generated
 * stylesheet until the bundler rebuilds — the class resolves to nothing and the
 * text renders at its default size, silently. `discovery-header.tsx` learnt this
 * the hard way and every measured dimension in this file follows it.
 */

/*
 * An `OVERLAP` / `HERO_FOOT` pair lived here: the quick actions were pulled 44
 * points up into a full-bleed hero that padded its own bottom by 62, so the card
 * straddled the gradient's edge.
 *
 * Both went when the hero became an inset card. Straddling needs an edge that
 * runs the full width of the screen — a card pulled up onto another card's
 * rounded corner is not the same gesture, it is two objects colliding. The
 * pattern is still the house style on screens that keep a painted band; this is
 * not one of them any more.
 */

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The fixed bar: whose product this is, the listing, and the bell.
 *
 * `<PortalBrandHeader>` with this role's screen-reader sentence on the eye —
 * see that component for why the platform name sits above the hostel, why the
 * bar is never painted, and why the eye is withheld rather than drawn onto a
 * 404. This wrapper exists so the Home screen keeps naming its own header, and
 * so `onPreview` keeps the name the admin screen has always called it.
 *
 * ## Why an owner needs this most
 *
 * Every other role already had a way to their hostel's public page — a resident
 * has it on Home, every card in Search opens one — while the person who
 * *writes* the listing had no way to look at it.
 */
export function AdminHomeHeader({
  /**
   * Opens the hostel's public page. Omitted — and the control hidden — when
   * there is no single hostel, or when its listing is not live.
   */
  onPreview,
}: { onPreview?: () => void } = {}) {
  return (
    <PortalBrandHeader
      hostelPageLabel="See your listing as visitors do"
      onHostelPage={onPreview}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * ## `/85` and `/15` are not opacities, they are nothing
 *
 * Twice now this card has shipped text the same colour as the page it was
 * painted on: `text-white/85` on the ID line, and `border-white/15` on the rule
 * above the two-up. Tailwind's opacity scale runs 5, 10, 20, 25, 30, 40, 50, 60,
 * 70, 75, 80, 90, 95, 100 — **15 and 85 are not on it**, NativeWind's build-time
 * scan emits no class for them, and the utility silently resolves to nothing.
 *
 * The failure is worse than a missing tint: with no colour class left, our
 * `<Text>` falls back to `variant="body"`, which is `text-foreground` — so the
 * line renders near-black on the accent and disappears. Every white on this card
 * is a step that exists, and a new one must be checked against that list before
 * it is typed.
 */

/**
 * This month against last, as a pill beside the section label.
 *
 * The only pill left on the hero. Three of them wrapped across the amount block
 * in the first cut, and a wrapping row of `shrink` chips is a truncation
 * machine: every chip gives up width to its neighbours until each one ellipses,
 * so `NPR 74,000 this month` became `NPR 74,0…` and the figures the hero exists
 * to show were the first thing lost. What those chips carried went to a fixed
 * two-up row, and then off the hero altogether — the month is the Money
 * section's subject and was being answered twice.
 *
 * This one survives as a pill because it is genuinely a *label*, not a figure —
 * it is short, bounded (`Up 99% on Sep` is the worst case), and it belongs
 * beside the heading it qualifies rather than under the number.
 *
 * The month's own figure came back, but as the right half of the fixed two-up
 * under the headline rather than as a chip beside it — see the note there. A
 * pill is the wrong container for a currency amount and always was.
 */
function DeltaPill({ delta }: { delta: MonthDelta }) {
  const icon =
    delta.direction === "up" ? "arrow-up" : delta.direction === "down" ? "arrow-down" : "remove";

  return (
    <View className="flex-row items-center gap-1 rounded-full border border-white/25 bg-white/20 px-2.5 py-1">
      <Ionicons color="rgba(255,255,255,0.9)" name={icon} size={11} />
      <Text className="font-semibold text-white" numberOfLines={1} style={{ fontSize: 11 }}>
        {delta.label}
      </Text>
    </View>
  );
}

/**
 * The one thing allowed to interrupt the hero.
 *
 * It sits **above the money**, which is the rule the previous Home already held
 * and the reason it is inside the gradient rather than in the body: the cost of
 * scrolling past this one is somebody's safety, so it may not be below anything,
 * and the body's first block is a screen further down.
 *
 * White on the gradient rather than red on it — a red panel on a saturated
 * teal-green ground is the one combination that loses its contrast, and the
 * white card is both louder and the only element on the hero that looks like it
 * came from a different, more urgent screen.
 *
 * It is an alarm, not the control. Acknowledging happens on the card in the body
 * below, which carries the resident, the message and the button.
 */
function HeroSosStrip({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`${count} SOS alerts active. Open the alerts queue.`}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-2xl bg-white px-3.5 py-3 active:opacity-80"
      onPress={() => {        onPress();
      }}
      style={FLOAT_SHADOW}
    >
      <View className="h-9 w-9 items-center justify-center rounded-full bg-[#fee2e2]">
        <Ionicons color="#dc2626" name="warning" size={18} />
      </View>

      <View className="flex-1">
        <Text className="text-sm font-semibold text-[#b91c1c]">
          {count === 1 ? "An SOS is active" : `${count} SOS alerts are active`}
        </Text>
        <Text className="text-[#7f1d1d]" style={{ fontSize: 11 }}>
          A resident is waiting for someone to respond
        </Text>
      </View>

      <Ionicons color="#b91c1c" name="chevron-forward" size={17} />
    </Pressable>
  );
}

/**
 * The listing's state, in the corner the account card keeps for it.
 *
 * `ebl-01` puts `Active` hard against the card's top-right, and it is the first
 * thing the eye reaches after the account's name — which is right, because a
 * card whose account is closed is a different card. Ours carries the same fact
 * about the public listing: a hostel sitting in `DRAFT` takes no inquiries at
 * all, and the screen this replaced reported that four sections down under
 * "Your listing", which is where you look once you already suspect something is
 * wrong.
 *
 * Live is a quiet translucent pill; anything else is solid white and reads as a
 * flag, because those are the two states that need different reactions.
 */
function ListingPill({ listing }: { listing: { live: boolean; note: string } }) {
  return (
    <View
      className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${
        listing.live ? "bg-white/25" : "bg-white"
      }`}
    >
      <View className={`h-1.5 w-1.5 rounded-full ${listing.live ? "bg-white" : "bg-[#b45309]"}`} />
      <Text
        className={`font-semibold ${listing.live ? "text-white" : "text-[#b45309]"}`}
        numberOfLines={1}
        style={{ fontSize: 10 }}
      >
        {listing.live ? "Live" : listing.note}
      </Text>
    </View>
  );
}

/**
 * The hostel as a bank account card: whose it is, its number, and its money.
 *
 * ## It is a card now, and that was the whole complaint
 *
 * This was a full-bleed painted band under a painted header — one green mass
 * from the status bar down to the quick actions, with the hostel's name in a
 * frosted panel inside it and three frosted tiles along its bottom. Every
 * element on it was correct and the object it added up to was not: a card is
 * something with edges, sitting on a ground that is not the same colour as it.
 *
 * `ebl-01` is the model, and it is four lines and a row:
 *
 * | EBL | here |
 * | --- | --- |
 * | `SAVINGS GENERAL` | the hostel's name |
 * | `08500501204444` | `hostelCode` — `HH-6F2A9C41` — and the area |
 * | `NPR 52.43` | everything collected, ever |
 * | `SIDDHANT YADAV` | residents, free beds, how full |
 * | `Actual` / `Available Balance` | `In Bhadra` / `Still due` |
 *
 * Inset on all four sides with a shadow under it, cornered, lifted, and with the
 * building's own photograph as its ground: all of that is `<PortalHeroCard>`,
 * which the resident Home draws too. What is below is only this card's content.
 *
 * ## Why the money still leads
 *
 * A hostel owner already knows what they collected this month — they set the
 * rent and they know how many residents they have. What they cannot get without
 * a laptop is the total: what this building has taken in since it opened. That
 * is the figure in 34-point type, `DeltaPill` answers "and is that good" in
 * words beside it, and the trend card in the body draws the rest.
 *
 * The two-up under it used to repeat that total on the left, under `Since
 * opening`. Nothing else on the card competes for that reading — the headline
 * *is* the lifetime figure — so the label was naming something already named,
 * and the row spent half of itself on a second copy of the number above it.
 * Both halves are the billing period now: what came in, and what has not.
 *
 * The repeat did do one job, and it is kept for exactly the case that needed
 * it. A warden without `viewPayments` gets no lifetime figure at all and the
 * headline silently falls back to the month — so when `lifetime` is null the
 * left half goes back to `Since opening` reading `—`, which is the only thing
 * on the card that tells the two cases apart. See `earningsSummary`.
 *
 * ## `Still due` is that month's shortfall, not the hostel's
 *
 * `thisMonthBilled - thisMonth`, so the two halves are one sentence about one
 * period rather than two figures at different scales — a month's collections
 * beside an all-time arrears total is a comparison nobody is making. Lifetime
 * outstanding is a real question, and Money is the screen that answers it next
 * to the residents it belongs to.
 *
 * The subtraction clamps at zero on the total, where `overall.outstanding`
 * clamps per invoice: a resident who overpaid one invoice offsets another's
 * shortfall here by that much. The period roll-up carries no per-month arrears
 * field to do better, and a hostel with overpayments can only read that figure
 * correctly on Money in any case.
 *
 * ## The left half names its month
 *
 * `In Bhadra`, not `This month`. A hostel does not bill the month the phone is
 * in — it bills the period on the invoice, and the two come apart every time a
 * hostel raises next month's rent early. `This month` beside a figure that
 * belongs to a different month is the kind of label that only looks correct
 * until somebody reconciles against it.
 *
 * It is the period the figure was actually summed over (`earnings.period`),
 * spelled in the calendar the reader chose, and it falls back to `This month`
 * on the degraded path where there is no period key to name. `In September`
 * is the longest string it produces, which is what keeps it inside its half of
 * the row — `This month · September` did not fit on a 360dp phone.
 */
export function HostelHero({
  delta,
  earnings,
  hostel,
  listing,
  occupancy,
  onSos,
  residents,
  sosCount,
  vacantBeds,
}: {
  /** This month against last. Null in a first month — see `monthOverMonth`. */
  delta: MonthDelta | null;
  earnings: EarningsSummary;
  hostel: AdminHostel | null;
  listing: { live: boolean; note: string };
  /** Percent, or `null` when the hostel has never configured its rooms. */
  occupancy: number | null;
  onSos: () => void;
  residents: number;
  sosCount: number;
  vacantBeds: number;
}) {
  const dates = useDates();
  const photo = absoluteMediaUrl(heroPhotoUrl(hostel), API_BASE_URL);
  const code = hostelCode(hostel);
  const lifetimeKnown = earnings.lifetime !== null;
  /*
   * Hidden until asked for. The hero is the one screen an owner opens in a
   * corridor with residents standing next to them, and what it leads with is
   * everything the building has ever taken in — so the default is masked and
   * the eye is the only way to it. Component state, not persisted: the next
   * time the app is opened it is covered again, which is the behaviour every
   * banking app this screen is modelled on has.
   */
  const [shown, setShown] = useState(false);
  const real = formatMoney(lifetimeKnown ? earnings.lifetime : earnings.thisMonth);
  const amount = shown ? real : maskMoney(real);
  /*
   * Sized from whichever string is actually being drawn. Sizing off the real
   * figure would leave `NPR XXX.xx` set in the small type a seven-digit total
   * needs, and the headline would visibly change size on every toggle.
   */
  const size = heroAmountSize(amount);
  const money = (value: number | null) => {
    const formatted = formatMoney(value);

    return shown ? formatted : maskMoney(formatted);
  };
  /*
   * `In Bhadra` — the period the figure beside it was summed over, in the
   * reader's calendar. `formatPeriodMonth` hands back `—` for a period it
   * cannot read at all, and `In —` reads as a rendering fault, so that case
   * takes the generic label with the rest of the degraded path.
   */
  const month = earnings.period ? dates.periodMonth(earnings.period) : "";
  const monthLabel = month && month !== "—" ? `In ${month}` : "This month";
  /*
   * What that month was billed, less what it collected. Clamped, because a
   * month that took in more than it billed — an early payment against next
   * month's invoice lands in the period it was billed for, but a part-payment
   * settled twice does not — would otherwise print a negative arrears figure.
   */
  const monthShortfall = Math.max(0, earnings.thisMonthBilled - earnings.thisMonth);

  return (
    <PortalHeroCard photoUrl={photo}>
      {/* Lines one and two: the account's name, its number, and its state. */}
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1" style={{ gap: HERO_LINE_GAP }}>
          <Text
            className="font-semibold text-white"
            numberOfLines={1}
            style={{ fontSize: 16 }}
          >
            {/*
              A warden scoped to several hostels has no single profile to
              name, and the figures below still cover all of them — so the
              line widens rather than showing an empty one.
            */}
            {hostel?.name ?? "Your hostels"}
          </Text>

          <View className="flex-row items-center gap-1.5">
            <Ionicons
              color="rgba(255,255,255,0.75)"
              name={code ? "id-card-outline" : "albums-outline"}
              size={12}
            />
            {/*
              The account-number line. Tracked out a little, the way every
              card prints the one string on it that a person has to read
              aloud or copy by hand.
            */}
            <Text
              className="flex-1 text-white/80"
              numberOfLines={1}
              style={{ fontSize: 13, letterSpacing: 0.5 }}
            >
              {code ?? "Every hostel you manage"}
            </Text>
          </View>
        </View>

        <ListingPill listing={listing} />
      </View>

      {/*
        The one thing allowed to interrupt the card, and it sits above the
        money: the cost of scrolling past this one is somebody's safety, so
        it may not be below anything. It is an alarm, not the control —
        acknowledging happens on the card in the body below, which carries
        the resident, the message and the button.
      */}
      {sosCount > 0 ? <HeroSosStrip count={sosCount} onPress={onSos} /> : null}

      <View style={{ gap: HERO_LINE_GAP, marginTop: HERO_AMOUNT_LEAD_TRIM }}>
        <View className="flex-row items-end justify-between gap-2">
          {/*
            Sized from the string it is about to draw, with `NPR` a little
            under three-quarters of the digits — the treatment every balance
            in `ebl-01` and `ebl-02` gets. `PaintedAmount` owns that ratio
            and the Android `lineHeight` guard a figure this size needs.
          */}
          <View className="flex-1 flex-row items-center gap-2">
            <PaintedAmount size={size} value={amount} />

            {/*
              Beside the figure, not in the card's corner: it is the control
              *for this number*, and an owner who cannot find it reads a row
              of Xs as a bug.
            */}
            <Pressable
              accessibilityLabel={shown ? "Hide the amounts" : "Show the amounts"}
              accessibilityRole="button"
              className="-m-2 p-2 active:opacity-60"
              hitSlop={8}
              onPress={() => {                setShown((current) => !current);
              }}
            >
              <Ionicons
                color="rgba(255,255,255,0.9)"
                name={shown ? "eye-outline" : "eye-off-outline"}
                size={17}
              />
            </Pressable>
          </View>

          {/*
            Only when there is a comparison to make. A first month, and a
            month following a blank one, both return null rather than a
            percentage computed against zero.
          */}
          {delta ? <DeltaPill delta={delta} /> : null}
        </View>

        {/*
          The quiet line, in the slot the account holder's name occupies on
          `ebl-01`: three counts set as a caption rather than as figures,
          because not one of them is a thing to act on and all three were
          competing with the amount for the same glance. `occupancyLine`
          drops occupancy rather than printing `0%` for a hostel that has
          never configured its rooms.
        */}
        <View className="flex-row items-center gap-1.5">
          <Ionicons color="rgba(255,255,255,0.8)" name="people-outline" size={13} />
          <Text className="flex-1 text-white/80" numberOfLines={1} style={{ fontSize: 12 }}>
            {occupancyLine({ occupancy, residents, vacantBeds })}
          </Text>
        </View>
      </View>

      {/*
        **Fixed halves, never sized to content.** `flex-1` on both, not
        `shrink`: a wrapping row of content-sized chips gives width away to
        its neighbours until every one of them ellipses, which is how
        `NPR 74,000` became `NPR 74,0…` in an earlier cut. `AdminMoneyCard`
        draws the same pattern and carries the same note.
      */}
      {/*
        A drawn hairline, not `border-t border-white/15`.

        That class pair shipped a **black** rule across the card: NativeWind
        compiles its stylesheet from a build-time scan, the slashed border
        colour resolved to nothing, and what was left was a border width with
        React Native's default colour behind it. A `bg-white/20` view is the
        same hairline through the path that demonstrably works on this
        surface — the two-up's own divider is drawn the same way.
      */}
      <View style={{ gap: 14 }}>
        <View className="h-px w-full bg-white/20" />

        <View className="flex-row items-center">
          {[
            /*
              Masked with the headline, by the same switch. Covering the big
              figure while printing the month and the arrears under it in
              16-point type would leave the hostel's takings on the screen for
              whoever is standing next to the owner, which is the whole of what
              the eye exists to prevent.
            */
            /*
              The month, unless there is no lifetime figure to have been
              redundant with — see the note above on the degraded path.
            */
            lifetimeKnown
              ? { label: monthLabel, value: money(earnings.thisMonth) }
              : { label: "Since opening", value: money(earnings.lifetime) },
            { label: "Still due", value: money(monthShortfall) },
          ].map((fact, index) => (
            <View className="flex-1 flex-row items-center" key={fact.label}>
              {index > 0 ? <View className="mr-3 h-9 w-px bg-white/25" /> : null}

              <View className="flex-1 gap-1">
                <Text
                  className="font-semibold uppercase tracking-wider text-white/75"
                  numberOfLines={1}
                  style={{ fontSize: 11 }}
                >
                  {fact.label}
                </Text>
                <PaintedAmount size={16} value={fact.value} />
              </View>
            </View>
          ))}
        </View>
      </View>
    </PortalHeroCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Quick actions                                                              */
/* -------------------------------------------------------------------------- */

/*
 * `ACTION_TONES`, `ActionCard`, `ActionRow` and the cell itself moved to
 * `ui/action-grid.tsx` when the resident Home was taken to this same shape.
 *
 * Nothing about them was admin-specific — a cell is a glyph, a label, an
 * optional count and a destination — and the alternative was a second portal
 * growing a near-identical copy, which is the mistake this codebase keeps
 * warning about. The three rules the cell carries (a zero count goes grey, a
 * door carries no count, rows are chunked and never wrapped) moved with it and
 * are written down there.
 */

/**
 * Everything else the hostel is run from, as one grid of doors.
 *
 * ## Why Home ends here rather than in six sections of figures
 *
 * The body under this used to be the rest of the product in longhand: a
 * collection card, a bar chart, a "still chasing" pair, tonight's roster and the
 * listing's view counts, each with a heading and a sentence under it. Every one
 * of those has a screen of its own that shows the same thing with room to
 * breathe — Money, Today, `manage/settings` — so Home was a summary of screens
 * you reach in one tap from the row above it, and it was three scrolls long.
 *
 * `ebl-01` and `esewa-01` both end their home the same way and it is the single
 * most consistent thing in the references: **a menu of destinations is a grid of
 * tinted glyphs with a short label**, never a stack of sections. What a home
 * screen is for is getting somewhere; the somewhere is where the detail lives.
 *
 * ## These are `more.tsx`'s rows, deliberately
 *
 * Same destinations, same icons, same order as the More tab — which sounds like
 * duplication and is the opposite. More is the exhaustive list with a sentence
 * of explanation on each; this is the same list with the explanations off, for
 * somebody who already knows where they are going. Diverging them would mean a
 * hostel owner learning two different maps of one product, so a tile added here
 * is a row added there in the same breath.
 *
 * **`Statement` is the one row with no tile here, and only on this screen.** It
 * sits four cells up under "Waiting for you", so a tile would be a second door
 * to it inside one scroll — the rule that took `Post notice` and
 * `Payments to check` off that row, applied in the other direction. More has no
 * "Waiting for you", so More keeps the row.
 */
export function ServiceGrid({
  onOpen,
  onPrefetch,
  owner = false,
}: {
  onOpen: (href: string) => void;
  /**
   * HOSTEL_ADMIN only draws the Wardens tile — its routes are
   * `requireHostelAdminPrincipal`, so a warden would get a tile that 403s.
   */
  owner?: boolean;
  /**
   * Called on touch-down with the href about to be pushed.
   *
   * The grid knows the hrefs and nothing else — which query each one implies is
   * `lib/admin-queries.ts`'s business, so a tile added here without an entry
   * there simply loads the way it always did.
   */
  onPrefetch?: (href: string) => void;
}) {
  const { colors, scheme } = useAppTheme();

  const services = [
    { href: "/manage/finance", icon: "cash-outline", label: "Finance", tone: "success" },
    { href: "/(admin)/residents", icon: "people-outline", label: "Residents", tone: "admin" },
    /*
      Roll call came down from the shortcut row when the Store took its cell.

      It belongs in a grid of destinations rather than in a row of shortcuts, by
      the rule that row is chosen on: those four are jobs done *standing up*, and
      this is a roster somebody sits and reads top to bottom. It kept the moon
      and the amber it had, so anyone who learnt the glyph finds the same object
      one section lower — and the nightly path to it through Today is unchanged.

      Next to Residents deliberately: it is that list, at night.
    */
    { href: "/manage/roll-call", icon: "moon-outline", label: "Night status", tone: "warning" },
    /*
      Came down from "Waiting for you" when the scanner took a shortcut slot and
      `Post notice` took its place there. It lands on Today rather than on a
      screen of its own because Today *is* the complaint queue — the section
      under the roll call is the whole of it, replies included.
    */
    {
      href: "/(admin)/today",
      icon: "chatbox-ellipses-outline",
      label: "Complaints",
      tone: "danger",
    },
    { href: "/manage/rooms", icon: "bed-outline", label: "Rooms", tone: "brand" },
    { href: "/manage/notices", icon: "megaphone-outline", label: "Notices", tone: "warning" },
    { href: "/manage/food", icon: "restaurant-outline", label: "Food", tone: "warning" },
    /*
      Beside Food, not inside it. Who is allowed to say a meal is ready used to
      be a card at the bottom of the menu editor, which was fine while it was a
      name and a switch — it is now a roster with two kinds of access, a rotate
      and a removal that renames a departed cook's history, and that is a door
      of its own. `manage/food.tsx` keeps a single row pointing here.
    */
    { href: "/manage/cook", icon: "flame-outline", label: "Cooks", tone: "warning" },
    // Beside Cooks: both are "who else works here".
    ...(owner
      ? [{ href: "/manage/wardens", icon: "shield-checkmark-outline", label: "Wardens", tone: "admin" } as const]
      : []),
    { href: "/manage/maintenance", icon: "construct-outline", label: "Repairs", tone: "danger" },
    { href: "/manage/reports", icon: "bar-chart-outline", label: "Reports", tone: "admin" },
    /*
      The hostel paying *us*, which is the one kind of money on this grid that
      does not belong to Finance.
      Every other tile here is the hostel's own operation. This one is the
      subscription that keeps the app switched on — the plan, the days left on
      it, and the invoices and receipts an accountant asks for. Folding it into
      Finance would put two opposite directions of money behind one door, and an
      owner reading "outstanding" would have to work out which debt it meant.
      Next to Settings deliberately: both are about the account rather than the
      building.
    */
    { href: "/manage/billing", icon: "card-outline", label: "Billing", tone: "success" },
    { href: "/manage/settings", icon: "settings-outline", label: "Settings", tone: "brand" },
  ] as const;

  const glyph = {
    admin: roleAccent.ADMIN[scheme],
    brand: colors.primary,
    danger: colors.destructive,
    success: colors.success,
    warning: colors.warning,
  } as const;

  /*
    The chunking into rows of four, and the spacers that keep the last row's
    column pitch, are `<ActionTiles>`'s job — see the note there for why this
    may never become a `flex-wrap`.
  */
  const tiles: ActionTile[] = services.map((service) => ({
    glyph: glyph[service.tone],
    icon: service.icon,
    key: service.href,
    label: service.label,
    onPress: () => onOpen(service.href),
    onPressIn: onPrefetch ? () => onPrefetch(service.href) : undefined,
    tone: service.tone,
  }));

  return <ActionTiles tiles={tiles} />;
}

/**
 * The jobs a phone is genuinely better at than the portal.
 *
 * Straddles the hero's bottom edge, which does more than decorate: it pins the
 * row to the fold. These are the shortcuts somebody opens the app *for*, and a
 * screen where they sat below a metric grid taught people to scroll past the
 * metrics every single time.
 *
 * ## Three, and the rule that decides which three
 *
 * `Payments` and `Residents` came off, and the reason is the one that should
 * have kept them off in the first place: **both are bottom tabs**, sitting a
 * thumb-width below this row with a badge on them. A shortcut to something
 * already permanently on screen is not a shortcut, it is the same door drawn
 * twice — and the second drawing is the one without the count.
 *
 * That is the whole rule: **never a bottom tab, always something you would do
 * standing up.** Leading *into* a section the `Manage` grid below also maps is
 * fine and unavoidable — that grid is the full map of the product, the way
 * `More` is, and a shortcut that appears nowhere else would be a feature with
 * one entrance. Repeating one of its tiles verbatim is not: see today's menu
 * below.
 *
 * So: **the supply store**, `Add resident` with somebody in front of you
 * (`/manage/resident/new`) and **scanning a resident's card** in the corridor —
 * the three things that happen away from a desk. Recording cash would have been
 * the fourth and cannot be here at all: that write needs an invoice chosen
 * first, so it lives on the row's sheet inside Payments.
 *
 * ## Today's menu came off, and the cell was not refilled
 *
 * It was the `Food` tile of the grid below drawn a second time a scroll higher:
 * same icon, same destination, no count to tell the two apart. It also failed
 * the rule on its own merits — setting a menu is picking meals and times, read
 * and chosen sitting down, which is the reason `Post notice` moved down a card
 * before it.
 *
 * Three cells rather than a fourth thing promoted to fill the hole: they are
 * `flex-1` and simply space themselves, and this row is a list of what
 * qualifies, not a shape with four slots that must be full.
 *
 * ## The Store took roll call's cell
 *
 * Roll call was the first of these four and is now a tile in the `Manage` grid
 * below. It is a *roster* — every resident, read top to bottom — which is a
 * sitting-down job that was wearing a standing-up slot, and the nightly path to
 * it through Today never went away.
 *
 * The Store earns the cell on the same test the scanner does: ordering
 * mattresses happens while somebody is standing in the room that needs them, it
 * exists nowhere else in the app, and it is not a bottom tab. It leads the row
 * because it is the only one of the four that opens a whole section rather than
 * a single screen — and it takes `brand` with it, so the scanner moved to amber
 * rather than leaving two green cells two apart.
 *
 * ## A warden gets roll call in that cell instead
 *
 * The store's routes are `requireHostelAdminPrincipal` — buying supplies spends
 * the hostel's money, which is not what a warden's permission set is about — so
 * a warden tapping Store would get a 403 and no explanation. `onStore` is
 * therefore optional, and the cell falls back to roll call when it is absent.
 *
 * Not a greyed-out tile and not an empty cell: a warden's nightly job genuinely
 * *is* the roll call, so the row adapts to who is holding the phone rather than
 * showing them a door they cannot open. The caller decides — see
 * `(admin)/index.tsx` — because this component has no business reading a role.
 *
 * ## `Post notice` moved down a card, and the scanner took its slot
 *
 * Writing a notice is a **sitting-down** job — it wants an audience, a category,
 * a schedule and an expiry, all of which are on `manage/notices` — so it never
 * really met the rule this row is chosen by. It is now a cell in `Waiting for
 * you`, where the other doors without a count already live.
 *
 * The scanner is the opposite, and is the reason that rule exists: one-handed,
 * done standing up with somebody in front of you, and the single action
 * `NOTES.md` §10 records *both* reference apps putting behind the centre FAB of
 * their tab bar. That note said no admin action had earned a FAB; this one has
 * earned the strongest slot this row can give it.
 *
 * ## No badges, and why they were taken off
 *
 * Payments and Residents carried red counts of waiting claims and inquiries.
 * Both numbers were already on screen twice over: the **tab bar** badges Money
 * and Residents with them, and the tab bar is visible at the same moment as
 * this row — two copies of one number about forty points apart — while the
 * queue rows below print them a third time, itemised and in plain English.
 *
 * A count needs one home. The tab bar keeps it, because that badge survives the
 * user navigating away from Home, and the queue rows keep the explanation.
 * These are shortcuts: their job is to be reachable, not to report.
 */
export function QuickActions({
  onNewResident,
  onRollCall,
  onScan,
  onStore,
}: {
  onNewResident: () => void;
  /** The fallback for the lead cell when `onStore` is absent. */
  onRollCall: () => void;
  onScan: () => void;
  /** Omitted for a warden — see the note above. */
  onStore?: () => void;
}) {
  const { colors, scheme } = useAppTheme();

  return (
    <View className="px-5">
      <ActionCard>
        {onStore ? (
          <ActionCell
            glyph={colors.primary}
            icon="storefront-outline"
            label="Store"
            onPress={onStore}
            tone="brand"
          />
        ) : (
          <ActionCell
            glyph={colors.warning}
            icon="moon-outline"
            label="Night status"
            onPress={onRollCall}
            tone="warning"
          />
        )}
        <ActionCell
          glyph={roleAccent.ADMIN[scheme]}
          icon="person-add-outline"
          label="Add resident"
          onPress={onNewResident}
          tone="admin"
        />
        <ActionCell
          glyph={colors.warning}
          icon="scan-outline"
          label="Scan resident"
          onPress={onScan}
          tone="warning"
        />
      </ActionCard>
    </View>
  );
}

/**
 * What is waiting, as one card of four rather than four cards of one.
 *
 * Identical in construction to the shortcut row above it, and that is the point:
 * these are destinations with a number on them, the row above is destinations
 * without, and they should differ by the number and by nothing else. The grid of
 * separate bordered tiles it replaces drew four card edges where the shortcuts
 * drew one, and the extra chrome was carrying no meaning.
 *
 * ## Counts come from the queues, never from the dashboard report
 *
 * `report.complaints` is every complaint the hostel has ever had, settled ones
 * included. Under a heading saying "waiting for you" that is quietly wrong in
 * the direction that makes an owner stop trusting the screen, so these read the
 * live queues — the same data the tab badges show.
 *
 * ## The row only holds what has no door elsewhere on Home
 *
 * Three cells came off it for that reason. Complaints went into the Manage grid
 * (they are also the largest section of `(admin)/today`, which the last cell
 * opens); `Post notice` went back to the Manage grid it is already a tile in;
 * and `Payments to check` went to the Money tab, which is a whole tab about
 * exactly that.
 *
 * ## Statement and Reconcile are two cells because they are two screens
 *
 * The cell labelled `Statement` opened `manage/statements`, which is the **bank
 * import** — while the Manage grid, one section below, carried a tile of the
 * same name opening `manage/finance/statement`, the hostel's own ledger of
 * credits. One word, two destinations, one scroll apart: whichever an owner
 * tapped first taught them the wrong thing about the other.
 *
 * Both halves of that are fixed here. `Statement` is now the ledger — the
 * figure an owner reaches for most often, so it gets the door on the row they
 * are already reading — and the import has the cell beside it under the name of
 * the job it actually does. The grid's tile came off in the same breath, by this
 * row's own rule: a cell here and a tile there are two doors to one room inside
 * a single scroll. `more.tsx` keeps its row, having no "Waiting for you".
 */
export function WaitingActions({
  inquiries,
  onInquiries,
  onReconcile,
  onStatement,
  onToday,
}: {
  inquiries: number;
  onInquiries: () => void;
  /** `manage/statements` — importing a bank or wallet export and matching it. */
  onReconcile: () => void;
  /** `manage/finance/statement` — the ledger of credits, day by day. */
  onStatement: () => void;
  onToday: () => void;
}) {
  const { colors, scheme } = useAppTheme();

  return (
    <ActionCard>
      {/*
        The ledger, wearing the glyph and the tone the Manage grid's tile wore
        before it came off — an owner who learnt the receipt in green finds the
        same object one section higher rather than a new one.
      */}
      <ActionCell
        glyph={colors.success}
        icon="receipt-outline"
        label="Statement"
        onPress={onStatement}
        tone="success"
      />
      {/*
        The bank import, under the name of the job rather than of the file.

        No badge: an import is something you *do*, not a queue that fills — the
        same reason `Today` below carries none. It keeps the amber the cell
        beside it used to have, so the row still reads left-to-right as "the
        money paperwork, then the people, then the day".
      */}
      <ActionCell
        glyph={colors.warning}
        icon="git-compare-outline"
        label="Reconcile"
        onPress={onReconcile}
        tone="warning"
      />
      <ActionCell
        badge={inquiries}
        glyph={roleAccent.ADMIN[scheme]}
        icon="mail-outline"
        label="New inquiries"
        onPress={onInquiries}
        tone="admin"
      />
      <ActionCell
        glyph={colors.success}
        icon="today-outline"
        label="Today"
        onPress={onToday}
        tone="success"
      />
    </ActionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Earnings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The plotted area, in points — the inside of the frame, not the whole block.
 *
 * 176, not the 112 it was drawn at first. A line chart is read by its *slope*,
 * and slope is the ratio of the plot's height to its width: at 112 points under
 * a card 300 wide, a month that doubled its takings still climbed at a shallow
 * angle, and the whole plot read as a strip of padding with a line in it. This
 * is roughly 3:5 on a 360dp phone, which is the shape the reference chart has.
 */
const CHART_HEIGHT = 176;

/**
 * The gutter down the left. Wide enough for `250k` at 10 points and no wider —
 * every point spent here is a point of slope lost from the plot.
 */
const AXIS_WIDTH = 32;

/** The line's own thickness, and the frame's. */
const LINE_WIDTH = 2;

/** Gridlines drawn between the ticks — five labels, four gaps. */
const SLICES = 4;

/**
 * The frame's border, in points. Absolutely-positioned children sit inside it,
 * so anything measured against the *outer* height has to allow for it.
 */
const FRAME = 1;

/**
 * Six months of collections, as a line on a scaled grid.
 *
 * ## Why a chart at all, on a screen that is otherwise figures
 *
 * "Collected this month" is a number with no scale attached — 74,000 is good or
 * bad depending entirely on what the last five months were, and that comparison
 * is the whole question behind "how is the hostel doing". Six months of shape
 * answer it without being read.
 *
 * ## A line, and the axis a line obliges
 *
 * This was six bars with no axis and no value labels, on the argument that
 * `NPR 74,000` will not fit in a 42-point column. That argument still holds and
 * nothing here breaks it — the per-month figures are still absent. What changed
 * is the mark: bars sized against each other are a comparison, while a line is
 * a *trajectory*, which is the thing an owner is actually looking for in six
 * months of rent. A line, though, cannot be read without knowing what its height
 * means, so the plot gets what the bars did not need: a rounded ceiling, four
 * gridlines under it, and short labels down the left (`0`, `20k`, `40k`). See
 * `trendAxis` for why the ceiling is rounded and never the peak itself.
 *
 * The month that matters keeps its figure in full above the plot, where there
 * is room for the currency code.
 *
 * ## Drawn out of `<View>`s, not SVG
 *
 * `react-native-svg` is not a dependency of this app and adding it is a native
 * rebuild for one chart, so the line is a row of thin views rotated to the angle
 * between each pair of points. That arithmetic is `trendPoints` and
 * `trendSegments`, in the library and tested — this file measures the box and
 * paints what they return.
 */
export function EarningsTrend({ bars }: { bars: readonly TrendBar[] }) {
  const { colors } = useAppTheme();

  /*
   * Measured, not assumed. The card this sits in is as wide as the phone minus
   * its padding, and the segment geometry is in points — so the line cannot be
   * laid out until the plot has been.
   *
   * Guarded the way `<Grid>` guards its own measurement: `onLayout` fires again
   * on every rotation and keyboard resize, and an unconditional `setState` in
   * that callback is a render loop on some Android devices.
   */
  const [plot, setPlot] = useState({ height: 0, width: 0 });

  if (bars.length === 0) {
    return null;
  }

  const best = bars.reduce((top, bar) => (bar.collected > top.collected ? bar : top));
  const latest = bars[bars.length - 1];
  const axis = trendAxis(bars, SLICES);
  const measured = plot.width > 0 && plot.height > 0;

  const points = trendPoints(bars, axis.ceiling, plot.width, plot.height);
  const segments = trendSegments(points, LINE_WIDTH);

  return (
    <View className="gap-2.5">
      {/*
        The figure the plot is the context for. It is stated here rather than on
        the line's last point because a label on the point would be the one value
        label on a chart that has none, and would move with the data.
      */}
      <View className="flex-row items-baseline justify-between">
        <Text variant="label">Collected</Text>
        <Text className="font-semibold">{formatMoney(latest.collected)}</Text>
      </View>

      <View className="flex-row">
        {/*
          The gutter and the plot both wait for the measurement — every mark in
          either is positioned in points computed from `plot`, so drawing them
          against a width of zero would stack five labels and five segments in
          one corner for a frame. `<Grid>` takes the same one-frame wait, and an
          empty frame is the honest intermediate state.
        */}
        <View style={{ height: CHART_HEIGHT, width: AXIS_WIDTH }}>
          {measured
            ? axis.ticks.map((tick, index) => (
                <Text
                  className="absolute right-1 text-right text-muted-foreground"
                  key={`tick-${index}`}
                  numberOfLines={1}
                  /*
                    Half a line-height above the rule it names, so the label is
                    centred on it rather than hanging under it. `FRAME` because
                    the rules are measured inside the plot's border and this
                    column has none.
                  */
                  style={{
                    fontSize: 10,
                    top: FRAME + (index * plot.height) / SLICES - 7,
                  }}
                >
                  {trendTickLabel(tick)}
                </Text>
              ))
            : null}
        </View>

        <View
          className="flex-1 overflow-hidden rounded-md"
          style={{
            borderColor: colors.border,
            borderWidth: FRAME,
            height: CHART_HEIGHT,
          }}
        >
          <View
            className="flex-1"
            onLayout={(event) => {
              const { height, width } = event.nativeEvent.layout;

              setPlot((current) =>
                Math.abs(current.width - width) > 0.5 ||
                Math.abs(current.height - height) > 0.5
                  ? { height, width }
                  : current,
              );
            }}
          >
            {measured ? (
              <>
                {/* Rules between the ticks, and one between each month. */}
                {axis.ticks.slice(1, -1).map((tick, index) => (
                  <View
                    key={`rule-${index}`}
                    style={{
                      backgroundColor: colors.border,
                      height: StyleSheet.hairlineWidth,
                      left: 0,
                      position: "absolute",
                      right: 0,
                      top: ((index + 1) * plot.height) / SLICES,
                    }}
                  />
                ))}

                {points.slice(1).map((point, index) => (
                  <View
                    key={`column-${bars[index + 1].period}`}
                    style={{
                      backgroundColor: colors.border,
                      bottom: 0,
                      left: (point.x + points[index].x) / 2,
                      position: "absolute",
                      top: 0,
                      width: StyleSheet.hairlineWidth,
                    }}
                  />
                ))}

                {segments.map((segment, index) => (
                  <View
                    key={`segment-${bars[index + 1].period}`}
                    style={{
                      backgroundColor: colors.primary,
                      borderRadius: LINE_WIDTH / 2,
                      height: LINE_WIDTH,
                      left: segment.left,
                      position: "absolute",
                      top: segment.top,
                      transform: [{ rotate: `${segment.angle}rad` }],
                      width: segment.width,
                    }}
                  />
                ))}

                {/*
                  One dot, on the last month. Six dots would be a scatter plot
                  with a line through it; one says which end is now — the job the
                  accented bar used to do.
                */}
                <View
                  style={{
                    backgroundColor: colors.primary,
                    borderColor: colors.card,
                    borderRadius: 5,
                    borderWidth: 2,
                    height: 10,
                    left: points[points.length - 1].x - 5,
                    position: "absolute",
                    top: points[points.length - 1].y - 5,
                    width: 10,
                  }}
                />
              </>
            ) : null}
          </View>
        </View>
      </View>

      {/* The month labels, under the plot and past the gutter. */}
      <View className="flex-row" style={{ paddingLeft: AXIS_WIDTH }}>
        {bars.map((bar) => (
          <Text
            className={`flex-1 text-center ${
              bar.latest ? "font-semibold text-foreground" : "text-muted-foreground"
            }`}
            key={bar.period}
            numberOfLines={1}
            style={{ fontSize: 11 }}
          >
            {bar.label}
          </Text>
        ))}
      </View>

      <Text variant="caption">
        {best.collected > 0
          ? `Best of these ${bars.length} months: ${best.label}, ${formatMoney(best.collected)}`
          : `Nothing has been collected in the last ${bars.length} months`}
      </Text>
    </View>
  );
}

/*
 * A `CollectionMeter` lived here: this month's figure in 24-point type, what was
 * billed in smaller type off to the right, and a `<Meter>` under the pair.
 *
 * `<DataCard>` does the same job in the same height and one more figure — the
 * month's shortfall, which was the subtraction every reader was performing
 * anyway — because three labelled columns side by side compare in a glance where
 * a large number above a small one does not. Its note about `null` being a state
 * rather than a zero survives in both `<Meter>` and `<DataCard>`; a hostel that
 * has billed nothing must never be shown an empty bar, which reads as having
 * collected nothing.
 */
