import { PLATFORM_NAME, PLATFORM_NAME_PARTS, POWERED_BY } from "@hostel/brand/brand";

/**
 * Product identity in one place.
 *
 * The name itself lives in `packages/shared/src/brand/brand.ts`, shared with the
 * web, the server and the emails — rename the platform there, never here.
 */

export const APP_NAME = PLATFORM_NAME;

/**
 * The wordmark, split so the home header can draw the tail in brand green — the
 * two-tone lockup the discovery mockup uses.
 */
export const APP_NAME_PARTS = PLATFORM_NAME_PARTS;

/** Shown under the mark on the splash screen. */
export { POWERED_BY };

export const logo = {
  /** The HP mark, for light backgrounds. */
  mark: require("../../assets/images/logo-mark.png"),
  /** The HP mark with a white H, for dark surfaces. */
  markLight: require("../../assets/images/logo-mark-light.png"),
  /** The full "HostelPalika" lockup. */
  wordmark: require("../../assets/images/wordmark.png"),
  /** The same lockup for green bars: white letters, mint P. */
  wordmarkOnGreen: require("../../assets/images/wordmark-on-green.png"),
  /** Softmato's logo, for the "Powered by" line. */
  softmato: require("../../assets/images/powered-by-softmato.png"),
} as const;
