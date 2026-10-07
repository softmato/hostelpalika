import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, View } from "react-native";

import {
  FLOAT_SHADOW,
  HERO_AMOUNT_LEAD_TRIM,
  HERO_LINE_GAP,
  PaintedAmount,
  PortalBrandHeader,
  PortalHeroCard,
} from "@/components/portal-shared";
import { SosHeaderButton } from "@/components/sos-header-button";
import { type ActionTile, ActionTiles } from "@/components/ui/action-grid";
import { Text } from "@/components/ui/text";
import { roleAccent } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { formatMoney, heroAmountSize, maskMoney } from "@/lib/format";
import type { StayPill } from "@/lib/resident-home";

const QUESTIONCALL_LOGO = require("../../assets/images/questioncall-logo.png");

/**
 * The parts the resident Home screen is built out of.
 *
 * ## It is the admin Home, with a resident's subject
 *
 * The two screens are now one design: a `bg-background` bar carrying the
 * platform lockup and the bell, a painted account card inset under it, tinted
 * glyph cells straddling the fold, and a grid of doors that the screen ends on.
 * `<PortalHeroCard>` and `ui/action-grid.tsx` are literally the same components
 * in both, so the two cannot drift apart by a corner radius or a column pitch.
 *
 * They differ by one thing in the middle: the admin keeps its shortcut row and
 * its queue card as two cards with a heading between them, and here they are a
 * single row — three shortcuts and the one count worth the fold. Same component,
 * one fewer seam; see `<ResidentHomeActions>`.
 *
 * What differs is what each card is *about*, which is the whole of the
 * difference between the two roles:
 *
 * | admin | here |
 * | --- | --- |
 * | the hostel's name | the hostel they live in |
 * | `HH-6F2A9C41`, the hostel's code | their room type and move-in date |
 * | is the listing live | did they check in tonight |
 * | everything collected, ever | everything they owe right now |
 * | residents / vacant / occupancy | which month, and how late |
 * | this month, and what is still due | outstanding / deposit held |
 *
 * ## The money is the other direction, and that is the one real divergence
 *
 * An owner's headline is income and there is nothing to *do* about it, so their
 * card carries no button. A resident's headline is a debt, and the app exists to
 * settle it — so this card has `Pay now` where the admin's has its month-on-month
 * pill, and it appears only when something is actually owed.
 *
 * ## Measured sizes are written as styles, not as `text-[NNpx]`
 *
 * NativeWind compiles its class list from a build-time scan of the source, so an
 * arbitrary value appearing nowhere else in the app is absent from the generated
 * stylesheet until the bundler rebuilds — the class resolves to nothing and the
 * text renders at its default size, silently. Every measured dimension in this
 * file follows `admin-home.tsx` in writing itself as a style.
 *
 * The same goes for **white opacities**: Tailwind's scale runs 5, 10, 20, 25,
 * 30, 40, 50, 60, 70, 75, 80, 90, 95, 100, and `/15` or `/85` resolve to nothing
 * at all — leaving our `<Text>` on `variant="body"`, which is `text-foreground`,
 * which is near-black on the paint. Two shipped bugs on the admin card came from
 * exactly that; every white here is a step that exists.
 */

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The fixed bar: whose product this is, SOS, the hostel's page, and the bell.
 *
 * `<PortalBrandHeader>` with SOS in its `actions` slot — see that component for
 * the lockup, the eye and why the bar is never painted.
 *
 * ## What it replaced, and what was lost on purpose
 *
 * A greeting: `Good evening, Sujan`, with the hostel's name as a subtitle. It
 * read well and it spent the most valuable strip on the screen saying something
 * the resident already knows, on every single open. The hostel's name moved to
 * the card, where it is the identity the money belongs to; the greeting is gone.
 *
 * ## SOS is here rather than floating
 *
 * It was a red circle hovering above the tab bar that hid itself on scroll. A
 * control that moves, overlaps what you are reading and disappears is not one
 * anybody trusts in an emergency — so it took a fixed seat on the one bar that
 * never scrolls away, and leftmost of the row so that a hostel whose listing is
 * not live does not shift it. See `<SosHeaderButton>`.
 */
export function ResidentHomeHeader({
  onHostelPage,
}: { onHostelPage?: () => void } = {}) {
  return (
    <PortalBrandHeader
      actions={<SosHeaderButton />}
      hostelPageLabel="Open your hostel's page"
      onHostelPage={onHostelPage}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Tonight's answer, in the corner the account card keeps for its state.
 *
 * The admin card's `ListingPill` with a different fact behind it, and the same
 * two appearances for the same reason: **settled is a quiet translucent pill,
 * anything else is solid white and reads as a flag**, because those are the two
 * states that need different reactions.
 *
 * Pressable, which the admin's is not. A listing's state is something an owner
 * can only fix on another screen entirely; a night status is answered in one tap
 * on the screen this opens, so a flag that cannot be acted on would be the wrong
 * object here. `stayPill` decides which of the two it is.
 */
function StayStatePill({ onPress, pill }: { onPress: () => void; pill: StayPill }) {
  return (
    <Pressable
      accessibilityLabel={`${pill.label}. Open your night status.`}
      accessibilityRole="button"
      className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 active:opacity-70 ${
        pill.settled ? "bg-white/25" : "bg-white"
      }`}
      hitSlop={6}
      onPress={onPress}
    >
      <View
        className={`h-1.5 w-1.5 rounded-full ${pill.settled ? "bg-white" : "bg-[#b45309]"}`}
      />
      <Text
        className={`font-semibold ${pill.settled ? "text-white" : "text-[#b45309]"}`}
        numberOfLines={1}
        style={{ fontSize: 10 }}
      >
        {pill.label}
      </Text>
    </Pressable>
  );
}

/**
 * The one thing allowed to interrupt the card.
 *
 * The admin hero's SOS strip, in the slot it occupies and under the same rule:
 * it sits **above the money**, inside the paint, so it cannot be scrolled past.
 * An urgent notice is the resident's version of that — the hostel marks a notice
 * urgent when it is about water going off, a gate closing early or an inspection
 * tomorrow, and those are worthless read a day late.
 *
 * White on the gradient rather than amber on it: a tinted panel on a saturated
 * green ground is the one combination that loses its contrast, and the white
 * card is the only element on the paint that looks like it came from somewhere
 * more urgent.
 */
function UrgentNoticeStrip({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`${count} urgent notices. Open notices.`}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-2xl bg-white px-3.5 py-3 active:opacity-80"
      onPress={onPress}
      style={FLOAT_SHADOW}
    >
      <View className="h-9 w-9 items-center justify-center rounded-full bg-[#fef3c7]">
        <Ionicons color="#b45309" name="megaphone" size={18} />
      </View>

      <View className="flex-1">
        <Text className="text-sm font-semibold text-[#92400e]">
          {count === 1 ? "An urgent notice is up" : `${count} urgent notices are up`}
        </Text>
        <Text className="text-[#78350f]" style={{ fontSize: 11 }}>
          Your hostel needs you to read this today
        </Text>
      </View>

      <Ionicons color="#92400e" name="chevron-forward" size={17} />
    </Pressable>
  );
}

/**
 * The card's action, on the themed half rather than on the paint.
 *
 * It started as a small white pill beside the figure, in the slot the admin card
 * gives its month-on-month pill — which made the two cards the same object with
 * one extra chip, and made the single thing this screen exists for the smallest
 * control on it. Down here it is a filled brand button on a `bg-card` surface,
 * which is what it would be anywhere else in the app.
 *
 * Two labels, because it is two different actions. Owing something, it settles a
 * debt; owing nothing, it opens a history — and a `Pay now` on a zero balance is
 * how somebody ends up paying next month's rent twice.
 */
function HeroAction({ onPress, owes }: { onPress: () => void; owes: boolean }) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={owes ? "Pay what you owe" : "Open your payments"}
      accessibilityRole="button"
      className={`flex-row items-center gap-1.5 rounded-full px-4 py-2.5 active:opacity-80 ${
        owes ? "bg-primary" : "border border-border bg-card"
      }`}
      hitSlop={6}
      onPress={onPress}
    >
      <Ionicons
        color={owes ? "#ffffff" : colors.mutedForeground}
        name={owes ? "card" : "time-outline"}
        size={14}
      />
      <Text
        className={`font-bold ${owes ? "text-white" : "text-foreground"}`}
        numberOfLines={1}
        style={{ fontSize: 13 }}
      >
        {owes ? "Pay now" : "Payments"}
      </Text>
    </Pressable>
  );
}

/**
 * The stay as a rent card: where they live, and what is left to pay on it.
 *
 * ## Two registers, which is what stops it being the warden's card
 *
 * The first cut of this was `HostelHero` with a resident's data poured into it —
 * same paint, same four blocks, same hairline two-up — and on a device the two
 * home screens were one screen with different numbers on it. A resident and the
 * person who bills them should not be looking at the same object.
 *
 * So this one is **paint over a themed surface**, which is `NOTES.md` §11
 * (`esewa-07`, `esewa-08`): the subject on colour, and a second register below a
 * rule carrying the position and one action. Nothing in the app used that split
 * yet, and it is exactly the one this card wants — what you owe is the hostel's
 * number; what you do about it is yours.
 *
 * | painted | themed footer |
 * | --- | --- |
 * | the hostel's name, and tonight's answer | `Deposit held` |
 * | their room type, and the day they moved in | `Pay now` |
 * | `REMAINING TO PAY` over the figure | |
 * | which month it is, and how late | |
 *
 * ## The figure is labelled, and that is why it is printed once
 *
 * The admin card leads with an unlabelled total and *names* it in the two-up
 * below — which is what `ebl-01` does, and why `Outstanding` used to sit under
 * `NPR 18,800` carrying the same `NPR 18,800`. Here the label is above the
 * figure instead, in the small caps the reference gives every figure it names,
 * so the fact is stated once and the footer is free to carry the deposit and the
 * button rather than a repeat.
 *
 * ## What it replaced
 *
 * A `DuesCard` (a bordered white card with the amount, a status pill, a due
 * label and a full-width button), a `StatStrip` of three metric tiles, and a
 * `HostelCard` with a photo thumbnail and a wrap of contact chips — three
 * objects, three surfaces, about two thirds of the first screenful. Every fact
 * they carried is still on this screen; the photo became the card's ground, the
 * three tiles became the pill and the badge on this card, and the contact chips
 * became a shortcut that dials.
 *
 * ## The deposit
 *
 * A resident's second figure, and the one they can never find: it is money of
 * theirs the hostel is holding, it is on the dashboard payload already, and
 * before this it appeared on no mobile screen at all. It is masked with the
 * headline by the same switch — covering the amount you owe while printing the
 * amount you have on deposit two rows below would hide nothing worth hiding.
 */
export function ResidentStayHero({
  deposit,
  dueAmount,
  duesNote,
  hostelName,
  onNotices,
  onNightStatus,
  onPay,
  photoUrl,
  roomLabel,
  sinceLabel,
  stay,
  urgentCount,
}: {
  /** `resident.depositAmount` — theirs, held by the hostel. */
  deposit: number;
  dueAmount: number;
  /** One line under the figure — `duesLine`, which owns the priority order. */
  duesNote: string;
  hostelName: string | null;
  onNightStatus: () => void;
  onNotices: () => void;
  onPay: () => void;
  photoUrl: string | null;
  /** `Single room` — humanized, without the word "room" doubled. */
  roomLabel: string;
  /** The move-in date, already in the reader's calendar. No `Since` prefix. */
  sinceLabel: string;
  stay: StayPill;
  urgentCount: number;
}) {
  /*
   * Hidden until asked for, exactly as on the admin card. A resident opens this
   * in a common room with three other people on the sofa, and what it leads with
   * is what they owe — which is nobody else's business. Component state, not
   * persisted: it is covered again next launch, which is what every banking app
   * this card is modelled on does.
   */
  const [shown, setShown] = useState(false);
  const real = formatMoney(dueAmount);
  const amount = shown ? real : maskMoney(real);
  /*
   * Sized from whichever string is actually being drawn. Sizing off the real
   * figure would leave `NPR XXX.xx` set in the small type a six-digit figure
   * needs, and the headline would visibly change size on every toggle.
   */
  const size = heroAmountSize(amount);
  const money = (value: number) => {
    const formatted = formatMoney(value);

    return shown ? formatted : maskMoney(formatted);
  };

  const owes = dueAmount > 0;

  return (
    <PortalHeroCard
      footer={
        /*
          The second register. `bg-card`, ordinary tokens, and the one control on
          the card — see `<PortalHeroCard>`'s `footer` note for why it bleeds to
          the card's edges rather than sitting in the padded block above.
        */
        <View className="flex-row items-center justify-between gap-3 px-4 py-3.5">
          <View className="flex-1 gap-1">
            <Text
              className="font-semibold uppercase tracking-wider text-muted-foreground"
              numberOfLines={1}
              style={{ fontSize: 10 }}
            >
              Deposit held
            </Text>
            <Text
              className="font-semibold text-foreground"
              numberOfLines={1}
              style={{ fontSize: 15 }}
            >
              {money(deposit)}
            </Text>
          </View>

          <HeroAction onPress={onPay} owes={owes} />
        </View>
      }
      photoUrl={photoUrl}
    >
      {/* Lines one and two: where they live, and on what terms. */}
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1" style={{ gap: HERO_LINE_GAP }}>
          <Text className="font-semibold text-white" numberOfLines={1} style={{ fontSize: 16 }}>
            {hostelName ?? "Your hostel"}
          </Text>

          {/*
            The account-number block — what a resident is asked at the office:
            which room, since when.

            **Two rows, each with its own glyph**, rather than one string joined
            by a `·`. Joined, it did not fit beside the state pill on a 360dp
            phone: it came back from the device first as `Since Bhadra 19, 2…`
            with the year cut off, and then wrapping in the middle of the date,
            so `2083 BS` sat alone on a second line under a bed icon. There is no
            short form of a BS date to fall back on, so the two facts get a row
            each and the calendar glyph says which is which.
          */}
          <View className="gap-1.5">
            {[
              { icon: "bed-outline", text: roomLabel },
              { icon: "calendar-outline", text: `Since ${sinceLabel}` },
            ].map((row) => (
              <View className="flex-row items-center gap-1.5" key={row.icon}>
                <Ionicons
                  color="rgba(255,255,255,0.75)"
                  name={row.icon as keyof typeof Ionicons.glyphMap}
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

        <StayStatePill onPress={onNightStatus} pill={stay} />
      </View>

      {urgentCount > 0 ? (
        <UrgentNoticeStrip count={urgentCount} onPress={onNotices} />
      ) : null}

      <View style={{ gap: 6, marginTop: HERO_AMOUNT_LEAD_TRIM }}>
        {/*
          The label the admin card does not have, and the reason this figure is
          printed once rather than twice — see the note at the top.
        */}
        <Text
          className="font-semibold uppercase tracking-wider text-white/75"
          numberOfLines={1}
          style={{ fontSize: 11 }}
        >
          Remaining to pay
        </Text>

        <View className="flex-row items-center gap-2">
          <PaintedAmount size={size} value={amount} />

          {/*
            Beside the figure, not in the card's corner: it is the control *for
            this number*, and somebody who cannot find it reads a row of Xs as a
            bug.
          */}
          <Pressable
            accessibilityLabel={shown ? "Hide the amounts" : "Show the amounts"}
            accessibilityRole="button"
            className="-m-2 p-2 active:opacity-60"
            hitSlop={8}
            onPress={() => {
              setShown((current) => !current);
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
          One sentence about the figure above it, chosen by `duesLine` — which
          puts a claim in review ahead of everything, because telling somebody
          who has already paid that they are four days overdue is the one thing
          this line can say that costs them money.
        */}
        <View className="mt-1.5 flex-row items-center gap-1.5">
          <Ionicons color="rgba(255,255,255,0.8)" name="receipt-outline" size={13} />
          <Text className="flex-1 text-white/80" numberOfLines={1} style={{ fontSize: 12 }}>
            {duesNote}
          </Text>
        </View>
      </View>
    </PortalHeroCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Home actions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One row of tinted glyph cells, straddling the fold under the hero.
 *
 * It was two cards with a `Waiting for you` heading between them: this shortcut
 * row, then a second, identically-built card of four queue cells a section-gap
 * below. They were the same object drawn twice — a glyph, a label and a
 * destination, differing only in whether the destination carries a number — and
 * the heading over the second one named that difference, which is not a
 * difference a resident is looking for. What they are looking for is *where to
 * go*, and it now sits in one place under the money.
 *
 * ## What the merge dropped, and what it kept
 *
 * `Invoices`, `Complaints` and `Night status` came off Home. Each was a count on
 * a door, and each door is reached without it: the Payments tab is a
 * thumb-width below this card, and Complaints and Night status are rows on More.
 * A queue cell earns its place on the fold by being the thing a resident opens
 * the app for, and on a screen whose hero is already the money and its due date,
 * three of the four were repeating what the card above them had said.
 *
 * `Notices` stayed, as the row's one counted cell. Nothing else on this screen
 * says a notice is urgent — the hero's badge is the same number, and it is the
 * only fact here the resident cannot get from the money.
 *
 * ## The order
 *
 * **Digital ID** leads, because it is the single most phone-shaped thing a
 * resident owns: produced at a gate, at a counter, to a warden who does not
 * recognise them. Then **Call hostel**, one tap to the office rather than
 * reading a number off a chip; then **Notices**; then, for students,
 * **QuestionCall**. `Raise issue` came off so QuestionCall sits in the first row
 * instead of alone on a second: Complaints is a row on More, with its history.
 *
 * ## The rules both cards brought, which still hold
 *
 * - **A destination carries no count at all.** `badge` is omitted, not passed as
 *   zero, for the three shortcuts. A cell with a count and a cell without read
 *   as different kinds of thing at a glance, which is exactly what they are.
 * - **Notices counts the unread ones**, per user, so opening one clears it.
 * - **Tones are meanings, not decoration**, and no two of them repeat in the
 *   row — four colours are recognised by position after about two uses, which is
 *   the entire reason these cells are tinted. `Notices` wore the warning tone in
 *   the card it came from, where nothing else did; here `Call hostel` already
 *   has it, so the notice board takes the row's remaining colour rather than
 *   drawing the second amber square the eye then has to read word by word.
 * - **A resident with no hostel phone number gets one cell fewer.** `onCall` is
 *   optional and the cell is simply not in the list; `<ActionTiles>` pads the
 *   short row with a spacer, so the column pitch holds either way.
 *
 * ## SOS is not here, and must not be added
 *
 * `<SosFab>` is mounted outside the navigator in `(resident)/_layout.tsx`, so it
 * is on screen on every resident tab and survives tab changes mid-countdown. A
 * cell repeating it would be a second, quieter alarm — and the one that scrolls
 * away.
 */
export function ResidentHomeActions({
  onCall,
  onIdCard,
  onNotices,
  questionCall,
  unreadNotices,
}: {
  /** `tel:` the hostel. Omitted when the listing carries no phone number. */
  onCall?: () => void;
  onIdCard: () => void;
  onNotices: () => void;
  /**
   * The study-partner cell, last, under QuestionCall's own logo and the one
   * tone the row has not used. The caller decides whether it shows (students
   * only, site-config switch) — data this row does not have. More has no row
   * for it on purpose: it is not a screen of ours.
   */
  questionCall?: { label: string; onPress: () => void };
  /** Notices this resident has not opened. */
  unreadNotices: number;
}) {
  const { colors } = useAppTheme();

  const tiles: ActionTile[] = [
    {
      glyph: colors.primary,
      icon: "card-outline",
      key: "id-card",
      label: "Digital ID",
      onPress: onIdCard,
      tone: "brand",
    },
    /*
      A cell that dials nothing is worse than a missing cell, so this one is in
      the list only when the listing carries a number.
    */
    ...(onCall
      ? [
          {
            glyph: colors.warning,
            icon: "call-outline",
            key: "call",
            label: "Call hostel",
            onPress: onCall,
            tone: "warning",
          } satisfies ActionTile,
        ]
      : []),
    {
      badge: unreadNotices,
      glyph: colors.success,
      icon: "megaphone-outline",
      key: "notices",
      label: "Notices",
      onPress: onNotices,
      tone: "success",
    },
    ...(questionCall
      ? [
          {
            glyph: colors.primary,
            icon: "school-outline",
            image: QUESTIONCALL_LOGO,
            key: "questioncall",
            label: questionCall.label,
            onPress: questionCall.onPress,
            tone: "resident",
          } satisfies ActionTile,
        ]
      : []),
  ];

  return (
    <View className="px-5">
      <ActionTiles tiles={tiles} />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Your stay                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Everything else, as one grid of doors — and where Home ends.
 *
 * ## These are `more.tsx`'s rows, deliberately
 *
 * Same destinations, same icons, same order as the More tab, which sounds like
 * duplication and is the opposite. More is the exhaustive list with a sentence
 * of explanation on each; this is the same list with the explanations off, for
 * somebody who already knows where they are going. Diverging them would mean a
 * resident learning two maps of one product, so a tile added here is a row added
 * there in the same breath.
 *
 * ## What is not here
 *
 * Anything already on `<ResidentHomeActions>` — Digital ID, Call hostel, Notices
 * and QuestionCall. A cell up there and a tile down here are two doors to one
 * room inside a single scroll, which is the rule that took `Statement` off the
 * admin's grid. `more.tsx` has no action row at all, so More keeps every one of
 * those rows — and it is where Complaints and Night status now live, since the
 * merge took their cells off Home.
 *
 * Community too: it is a bottom tab, and unlike Residents on the admin side it
 * has no second identity as a section of the product. Food likewise — the tab is
 * one thumb-width away and the day's menu is already a card on this screen.
 */
export function ResidentServiceGrid({
  onOpen,
  onPrefetch,
}: {
  onOpen: (href: string) => void;
  /**
   * Called on touch-down with the href about to be pushed.
   *
   * The grid knows the hrefs and nothing else — which query each one implies is
   * `lib/resident-queries.ts`'s business, so a tile added here without an entry
   * there simply loads the way it always did.
   */
  onPrefetch?: (href: string) => void;
}) {
  const { colors, scheme } = useAppTheme();

  const services = [
    { href: "/profile", icon: "person-outline", label: "Profile", tone: "resident" },
    /*
      Directly beside Profile, because sharing your record with a parent is a
      decision people revisit — after a fee goes unpaid, after an argument — and
      it must not be something you can only reach two screens deep.
    */
    { href: "/guardians", icon: "shield-outline", label: "Guardians", tone: "brand" },
    {
      href: "/attendance",
      icon: "location-outline",
      label: "Location",
      tone: "warning",
    },
    {
      href: "/night-status-history",
      icon: "moon-outline",
      label: "Night history",
      tone: "brand",
    },
    {
      href: "/offer-program/mine",
      icon: "ribbon-outline",
      label: "Offer Program",
      tone: "success",
    },
    { href: "/hostels", icon: "search-outline", label: "Explore", tone: "brand" },
    { href: "/referrals", icon: "gift-outline", label: "Refer", tone: "success" },
    { href: "/review", icon: "star-outline", label: "Review", tone: "warning" },
  ] as const;

  const glyph = {
    brand: colors.primary,
    resident: roleAccent.RESIDENT[scheme],
    success: colors.success,
    warning: colors.warning,
  } as const;

  /*
    The chunking into rows of four, and the spacers that keep the last row's
    column pitch, are `<ActionTiles>`'s job — see the note there for why this may
    never become a `flex-wrap`.
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
