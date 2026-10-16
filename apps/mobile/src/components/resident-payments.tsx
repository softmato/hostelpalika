import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { Pressable, View } from "react-native";

import { FLOAT_SHADOW, PaintedAmount, usePortalPaint } from "@/components/portal-shared";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { formatMoney, heroAmountSize } from "@/lib/format";
import { toastSuccess } from "@/lib/toast";

/**
 * One line under the card's balance: a small-caps heading, what the money is
 * for, and the money itself.
 *
 * ## It replaced a two-up that had no amount on it
 *
 * The card used to end in two half-width facts — `Next due` and `Reference
 * code` — and the `Next due` half showed the *name* of the next charge with its
 * due date underneath and **no figure at all**. So the screen read:
 *
 * > Total outstanding **Rs 18,800** · Next due *Admission fee* · [ Pay now ]
 *
 * The headline is every open invoice added up. The button pays exactly one of
 * them. A resident whose admission fee was Rs 2,000 tapped a card that said
 * 18,800 and landed on a payment screen for 2,000, and nothing anywhere on the
 * card had told them those were different numbers. That is a correctness
 * problem wearing a layout problem's clothes.
 *
 * The line carries the amount now, on the right where money goes, directly
 * above a button that names the same figure. Two numbers on one card is fine
 * as long as the card says which is which — what is not fine is showing one of
 * them and acting on the other.
 *
 * ## Full width, not a half
 *
 * A half-width fact ellipses. `portal-shared.tsx` records what that cost the
 * admin card — `Rs 74,0…`, the figures the card exists to show being the first
 * thing lost — and a line whose left is a label and whose right is a figure
 * gives the figure a fixed cost and the label everything else, which is the
 * split a list row has used since lists existed.
 */
export type DuesLine = {
  /** The figure on the right. `null` for a line with no money on it. */
  amount: number | null;
  /** The small-caps name above it — `Pay this next`, `Last paid`. */
  heading: string;
  /** What the money is for — `Admission fee`, `Bhadra 2083 BS`. */
  label: string;
  /** A quieter line underneath — `Due Bhadra 19, 2083 BS`. */
  note?: string;
};

/**
 * The resident's statement card — what Payments leads with.
 *
 * ## Why a card, and why not Home's hero
 *
 * The Payments tab used to open with **two** bordered white cards saying
 * overlapping things: a `Total outstanding` box, and directly under it a
 * `Due next` box carrying an amount, a due date, the reference code and both
 * actions. Two money figures in the first two hundred points of a screen, one
 * of which contains the other, is a screen that makes the reader do the
 * subtraction before it will tell them what to do.
 *
 * So it is one object now. The shape is taken from `<AdminMoneyCard>` rather
 * than from `<PortalHeroCard>`, and the difference is the whole point:
 *
 * - **Home** is a full-bleed hero with the building behind it, cornered at 18
 *   and inset 14. It is the front door, so it names the app and the hostel.
 * - **Payments is a card on a page** — inset on all four sides, cornered at 22,
 *   floating with a shadow under it. A statement is an object you hold, not a
 *   surface you stand on.
 *
 * That is exactly the split the admin portal already draws between its Home and
 * its Money tab, and `portal-shared.tsx` records why it matters: five screens
 * whose top two hundred points are identical stop saying where you are.
 *
 * ## Three facts, in the order they get asked
 *
 * **What do I owe** — the painted figure. **Is any of it late** — the pill under
 * it. **What am I paying right now, and how much** — the line below the rule,
 * which is the invoice the two buttons act on and which names its own amount.
 * Nothing else. Everything the card used to carry that was not one of those
 * three has moved somewhere that answers a question somebody asked here.
 *
 * ## The reference code left the card
 *
 * It held the second half of the two-up on the argument that a bank transfer
 * carrying it settles itself while one that does not has to be matched to a
 * person by hand. That is true, and it is why the code has not gone anywhere:
 * it is a `<ReferenceStrip>` on the page directly under the buttons, one row
 * lower than it was and still above the fold.
 *
 * What it is no longer is a *peer of the money*. This card is read in about a
 * second by somebody working out what they owe, and half of it was a string
 * they need only once they are already inside their banking app. Sitting beside
 * the next charge, it was also taking the width that charge's amount needed —
 * see {@link DuesLine}.
 *
 * ## Everything on the card is on the paint
 *
 * It had a themed `bg-card` footer holding the reference code and the two
 * buttons — a white register glued to the bottom of a green one, which made a
 * single object read as two stacked cards with no gap between them. The design
 * board draws it as one painted block, with the actions on the page
 * *underneath* the card rather than inside it.
 *
 * That is the better division and not just the drawn one. The card is the
 * **statement**. The buttons are what you *do* about it, and a control sitting
 * on the page background is unambiguously a control; one sitting in a white
 * shelf welded to a card is a piece of the card.
 *
 * ## The guardian portal passes a second line
 *
 * `lines` is a list because the two portals lead with different things. A
 * resident gets one — the charge they are about to pay. A guardian, who has no
 * button to press and no reference code to quote, gets that plus `Last paid`,
 * which is the fact somebody checking up on a household is actually there for.
 */
export function ResidentDuesCard({
  claimsPending,
  lines,
  overdueCount,
  total,
}: {
  /** Claims the hostel has not verified. A clock, not a debt — hence its own pill. */
  claimsPending: number;
  /** The lines under the rule, in reading order. Empty on a settled account. */
  lines: readonly DuesLine[];
  overdueCount: number;
  total: number;
}) {
  const paint = usePortalPaint();
  const amount = formatMoney(total);

  return (
    <View className="px-5">
      <LinearGradient
        colors={[paint.from, paint.to]}
        end={{ x: 1, y: 1 }}
        start={{ x: 0, y: 0 }}
        style={[FLOAT_SHADOW, { borderRadius: 22, overflow: "hidden" }]}
      >
        {/*
          One disc, bled off the top-right — `AdminMoneyCard`'s, to the point. A
          card this size takes one before it stops reading as a card and starts
          reading as a pattern.
        */}
        <View className="absolute inset-0" style={{ pointerEvents: "none" }}>
          <View
            className="absolute rounded-full bg-white/10"
            style={{ height: 150, right: -55, top: -60, width: 150 }}
          />
        </View>

        <View className="gap-3.5 p-5">
          <View className="gap-1.5">
            <Text
              className="font-semibold uppercase tracking-wider"
              numberOfLines={1}
              style={{ color: "rgba(255,255,255,0.7)", fontSize: 10 }}
            >
              Total outstanding
            </Text>

            {/*
              Sized from the string it is about to draw, with `Rs` smaller than
              its digits and the line box Android needs at this size — all three
              of which `<PaintedAmount>` owns, so this card and Home's hero
              cannot render one resident's money two ways.

              `Rs 0` is drawn rather than swapped for a sentence. A settled
              month is a *fact about a balance*, and a card that changes shape
              when the balance reaches zero is a card the eye has to re-learn on
              the one day it is good news. The pill below it says the rest.
            */}
            <PaintedAmount size={heroAmountSize(amount)} value={amount} />

            {/*
              Under the amount, not on the card's shoulder.

              A pill in the top-right corner is read *before* the figure — it is
              higher on the page — so the screen announced "Overdue" and only
              then said how much. Sitting under the number it annotates, it
              reads in the order the sentence actually goes: this much, and it
              is late.
            */}
            <PaintPill
              count={overdueCount > 0 ? overdueCount : claimsPending}
              kind={
                overdueCount > 0
                  ? "overdue"
                  : claimsPending > 0
                    ? "verifying"
                    : total > 0
                      ? "open"
                      : "settled"
              }
            />
          </View>

          {lines.map((line) => (
            <PaintLine key={line.heading} {...line} />
          ))}
        </View>
      </LinearGradient>
    </View>
  );
}

/**
 * The state pill, in the one state that applies.
 *
 * Four states and never two at once. Overdue outranks a pending claim, which
 * outranks "open", which outranks "settled" — a resident who is both overdue and
 * waiting on verification needs to be told the first of those, and two pills on
 * a card this size is a card with a row of badges on it.
 *
 * The ink is a literal, as it is on `<AdminMoneyCard>`, and for the same reason:
 * this pill sits on paint in **both** schemes, so a themed `text-warning` would
 * resolve to the dark-mode value on a card that never goes dark. The amber is
 * `--warning`'s light value and the red is `--destructive`'s; they are copied
 * here rather than read, because reading them would give the wrong one half the
 * time.
 */
function PaintPill({
  count,
  kind,
}: {
  count: number;
  kind: "open" | "overdue" | "settled" | "verifying";
}) {
  if (kind === "open") {
    return null;
  }

  if (kind === "settled") {
    return (
      <View className="mt-0.5 flex-row items-center gap-1 self-start rounded-full bg-white px-2.5 py-1">
        <Glyph color="#0a8a4b" name="checkmark-circle" size={11} />
        <Text className="font-bold text-[#0a8a4b]" numberOfLines={1} style={{ fontSize: 10 }}>
          Settled
        </Text>
      </View>
    );
  }

  const overdue = kind === "overdue";

  return (
    <View
      className="mt-0.5 flex-row items-center gap-1 self-start rounded-full px-2.5 py-1"
      style={{ backgroundColor: overdue ? "#fca5a5" : "#fcd34d" }}
    >
      <Glyph
        color={overdue ? "#7f1d1d" : "#78350f"}
        name={overdue ? "alert-circle" : "time"}
        size={11}
      />
      <Text
        className="font-bold"
        numberOfLines={1}
        style={{ color: overdue ? "#7f1d1d" : "#78350f", fontSize: 10 }}
      >
        {overdue
          ? count === 1
            ? "Overdue"
            : `${count} overdue`
          : count === 1
            ? "1 to verify"
            : `${count} to verify`}
      </Text>
    </View>
  );
}

/**
 * One {@link DuesLine}, drawn under a hairline.
 *
 * The label `shrink`s and the amount does not, so a long charge description
 * wraps before a figure ever loses a digit. The rule belongs to the line rather
 * than sitting between lines, so the first one is separated from the balance
 * above it and a second from the first without the card having to know how many
 * there are.
 *
 * **Two lines for the label, one for everything else.** A joining invoice is
 * `Admission fee + Security deposit` — the charge whose whole point is that both
 * halves are one payment — and at 15px beside a five-figure amount that ellipses
 * to `Admission fee + Security dep…` on a 360dp phone. Clipping the second half
 * of a two-part charge is the one truncation this line cannot afford.
 *
 * The small-caps ink is a resolved `rgba`, not `text-white/65`. On device that
 * class rendered the label near-*black* on the accent while `text-white/70` two
 * lines below it rendered correctly — the same generation-order race
 * `<AppBar>`'s `ink` and `<Card>`'s `padding` both document, and the one
 * `<PaintedAmount>` was written to dodge. A value in `style` cannot lose it.
 */
function PaintLine({ amount, heading, label, note }: DuesLine) {
  return (
    <View className="gap-1 border-t border-white/20 pt-3.5">
      <Text
        className="font-semibold uppercase tracking-wider"
        numberOfLines={1}
        style={{ color: "rgba(255,255,255,0.65)", fontSize: 9 }}
      >
        {heading}
      </Text>

      <View className="flex-row items-baseline justify-between gap-3">
        <Text
          className="shrink font-semibold text-white"
          numberOfLines={2}
          style={{ fontSize: 15 }}
        >
          {label}
        </Text>

        {amount === null ? null : (
          <Text className="font-bold text-white" numberOfLines={1} style={{ fontSize: 17 }}>
            {formatMoney(amount)}
          </Text>
        )}
      </View>

      {note ? (
        <Text numberOfLines={1} style={{ color: "rgba(255,255,255,0.72)", fontSize: 11 }}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The reference code, as one tap target.
 *
 * ## Why this is shared rather than written twice
 *
 * The Payments tab and the invoice detail screen both show this code and drew it
 * two different ways: the tab made the whole strip copy on tap, and the detail
 * screen printed the code in 24-point tracked type and put a **`Copy reference`
 * `<ListRow>` underneath it** — a list row acting as a button, under a value
 * that looked like a heading. One code, one object, one gesture.
 *
 * The Payments tab is a caller again, having briefly carried the code on the
 * painted card's two-up; `<ResidentDuesCard>` has why it came back down here.
 *
 * Renders nothing without a code. An empty reference box on an invoice the
 * server never minted one for is a box telling a resident to quote nothing.
 */
export function ReferenceStrip({
  code,
  hint,
}: {
  code: string | null;
  hint: string;
}) {
  const { colors } = useAppTheme();

  if (!code) {
    return null;
  }

  return (
    <Pressable
      accessibilityHint="Copies the code"
      accessibilityLabel={`Reference ${code}`}
      accessibilityRole="button"
      className="flex-row items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5 active:opacity-70"
      onPress={() => copyReference(code)}
    >
      <View className="flex-1">
        <Text variant="caption">{hint}</Text>
        <Text className="font-semibold tracking-wide" variant="label">
          {code}
        </Text>
      </View>
      <Glyph color={colors.primary} name="copy" size={18} />
    </Pressable>
  );
}

/**
 * Copy a reference code, with the haptic and the toast that say where it goes.
 *
 * One function rather than four copies of the same three lines: the invoice
 * summary, the pay screen's code card, the Payments tab's strip and the
 * certified-receipts header all copy the same kind of string, and a toast that
 * says something slightly different on each of them is four different promises
 * about what just happened.
 */
export function copyReference(code: string) {  void Clipboard.setStringAsync(code);
  toastSuccess("Reference copied", "Paste it into your transfer's remarks.");
}
