import { useEffect, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";

import { Text } from "@/components/ui/text";
import { MOTION } from "@/constants/motion";
import { formatMoney } from "@/lib/format";

/**
 * How much smaller the `Rs` is than the digits it prefixes.
 *
 * Every banking app our users already have does this — see
 * `ui_inspiration_folder/app_recordings/NOTES.md` §4. The reason it matters is
 * that the currency is the one part of the string that is **the same on every
 * row**: at equal weight it is pure repetition competing with the figures, and
 * shrinking it lets a column of amounts be scanned by their digits alone.
 *
 * A ratio rather than a fixed size, because this renders at four scales from an
 * inline row to a 30-point display figure — and exported, because the painted
 * surfaces cannot use this component (its tone classes resolve to
 * `text-foreground`, which is near-black on the accent) and must not re-decide
 * the ratio. See `<PaintedAmount>`.
 */
export const CURRENCY_SCALE = 0.72;

/**
 * A total counts up from zero the first time it has a value (M7), then sits
 * still: a refresh that changes it just shows the new figure. The frames are
 * plain JS state, which is fine for the one or two totals a screen carries.
 */
function useCountUp(target: number | null | undefined, enabled: boolean) {
  const reduce = useReducedMotion();
  const [run, setRun] = useState<{ done: boolean; shown: number | null }>({
    done: !enabled || reduce,
    shown: null,
  });

  useEffect(() => {
    if (run.done || !target) {
      return;
    }

    const start = Date.now();
    let frame = 0;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / MOTION.countUp);
      // Ease-out cubic: quick at first, settling onto the real figure.
      setRun(t < 1 ? { done: false, shown: Math.round(target * (1 - (1 - t) ** 3)) } : { done: true, shown: null });
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [run.done, target]);

  return run.done || !target ? target : (run.shown ?? 0);
}

/**
 * Each size, as the `<Text>` variant that already draws it.
 *
 * Not a class string through `className`, which is what this was and what made
 * "Due at move-in" render `NPR` *larger* than its digits. `<Text>` applies its
 * default `body` variant first — `text-base` — and a `text-2xl` appended after
 * it does not win: both rules reach the compiled stylesheet and which one lands
 * is decided by generation order, not by where it sat in the string. So the
 * digits stayed at 16 while the prefix, sized by a real `fontSize` style, scaled
 * to 24 × 0.72 and overtook them. The same trap `<Card>`'s `padding` and
 * `<AppBar>`'s `ink` document: one slot, one value.
 */
const VARIANTS = {
  display: "display",
  inline: "body",
  large: "title",
} as const;

/**
 * The point size each variant above actually resolves to.
 *
 * Duplicated from Tailwind's scale because the currency prefix is sized as a
 * *fraction* of its parent, and a variant name carries no number to take a
 * fraction of. If `<Text>`'s scale changes, change it here too — they are one
 * fact written twice, which is the trade for not hard-coding four more classes.
 */
const SIZE_PT: Record<keyof typeof VARIANTS, number> = {
  display: 30,
  inline: 16,
  large: 24,
};

/**
 * An amount, rendered the one way the app renders amounts.
 *
 * The tone rule is the reason this is a component rather than a call to
 * `formatMoney`: an outstanding balance is the number the screen exists to
 * communicate, and it should be the loudest thing on it, while a zero balance
 * should be quiet — "NPR 0" in red is a false alarm. `owed` colours by the
 * value, so no screen has to decide.
 */
export function Money({
  className = "",
  owed = false,
  size = "inline",
  tone = "default",
  value,
}: {
  className?: string;
  /** Colour by whether anything is actually outstanding. */
  owed?: boolean;
  size?: keyof typeof VARIANTS;
  /**
   * Colour by what *kind* of money this is, for a caller that already knows the
   * direction — a statement's rows are credits or debits by construction, so
   * there is nothing about the value for `owed` to decide.
   *
   * `debit` is red and it is not an alarm. It is the wallet vocabulary the
   * reference apps use for money out (`NOTES.md`), read against the green of the
   * hostel's own statement, and the resident's screen labels every one of these
   * rows `Paid` — the colour says which way it went, not that anything is wrong.
   *
   * A separate prop rather than a third `owed` state because the two answer
   * different questions: `owed` reads the *balance* and colours by whether any
   * of it is left, `tone` states the *direction* and does not look at the value
   * at all. A caller that sets both has a bug; `owed` wins, because a balance is
   * the more specific claim.
   *
   * Not passed through `className`. Both `text-foreground` and `text-success`
   * reach the compiled stylesheet, and which one wins is decided by generation
   * order rather than by where it sat in the string — the trap `<AppBar>`'s
   * `ink` and `<Card>`'s `padding` both document. One slot, one value.
   */
  tone?: "credit" | "debit" | "default";
  value: number | null | undefined;
}) {
  const inkClass = owed
    ? (value ?? 0) > 0
      ? "text-destructive"
      : "text-success"
    : tone === "credit"
      ? "text-success"
      : tone === "debit"
        ? "text-destructive"
        : "text-foreground";

  const text = formatMoney(useCountUp(value, size !== "inline"));

  /*
   * A dash is not an amount — it is the absence of one — so it keeps the plain
   * treatment. Splitting on the first space would otherwise give it a `Rs`
   * prefix it never had and a nested `Text` with nothing in it.
   */
  const prefix = text.startsWith("Rs ") ? "Rs" : null;

  return (
    <Text className={`${inkClass} ${className}`} variant={VARIANTS[size]}>
      {prefix ? (
        <>
          {/*
            Nested `Text`, which on React Native inherits the parent's colour and
            weight and overrides only what it names — so the currency stays the
            same tone as its digits and only the size changes. `fontSize` has to
            be a style: the parent's size comes from a class, so there is no
            number here to write a class against.
          */}
          <Text style={{ fontSize: SIZE_PT[size] * CURRENCY_SCALE }}>{prefix} </Text>
          {text.slice(3)}
        </>
      ) : (
        text
      )}
    </Text>
  );
}
