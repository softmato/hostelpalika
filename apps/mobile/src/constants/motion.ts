import { FadeInDown, ReduceMotion, type WithSpringConfig } from "react-native-reanimated";

/**
 * How the app moves, in one place (tracker: `docs/MOTION_AND_ICONS.md`, Track M).
 * The web portals mirror these as `--motion-*` variables in `globals.css`.
 *
 * Every spring carries `ReduceMotion.System`: with the phone's "remove
 * animations" setting on, the value jumps instead of travelling.
 */
const PRESS: WithSpringConfig = { damping: 22, mass: 0.6, reduceMotion: ReduceMotion.System, stiffness: 420 };
const SLIDE: WithSpringConfig = { damping: 20, mass: 0.8, reduceMotion: ReduceMotion.System, stiffness: 260 };

export const MOTION = {
  /** A finger going down and coming back up: quick, barely bouncy. */
  press: PRESS,
  /** Something travelling into place: the tab pill. */
  slide: SLIDE,
  /** Buttons, tiles and cards shrink to this under a finger. */
  pressScale: 0.96,
  /** Full-width rows shrink less, or the edges visibly jump. */
  rowScale: 0.985,
  fast: 160,
  base: 220,
  /** A total counting up from zero the first time it shows. */
  countUp: 650,
  /** One sweep of the skeleton's light band. */
  shimmer: 1100,
  /** Gap between list rows fading up, and how many rows get it. */
  stagger: 45,
  staggerRows: 8,
  /**
   * A large `AppBar` title shrinks to the bar's own size (`text-base` over
   * `text-2xl`) across this much page scroll, and a hairline fades in under it.
   */
  titleCollapse: { distance: 48, scale: 16 / 24 },
} as const;

/** Rise 10px and fade in: a screen body on mount, a list row on first load. */
export function riseIn(delay = 0) {
  return FadeInDown.delay(delay)
    .duration(MOTION.base)
    .withInitialValues({ opacity: 0, transform: [{ translateY: 10 }] })
    .reduceMotion(ReduceMotion.System);
}
