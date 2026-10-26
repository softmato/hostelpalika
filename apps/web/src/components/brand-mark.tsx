import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import Image from "next/image";

import { cn } from "@/lib/utils";

/**
 * The HP mark. Height comes from `className`; width follows the art.
 *
 * `adaptive` swaps in the white-H variant under `.dark` — only for surfaces that
 * follow the theme. The hard-coded light screens (auth, activation) leave it off,
 * or a dark-mode visitor would get a white H on a white page.
 */
export function BrandMark({ adaptive = false, className }: { adaptive?: boolean; className?: string }) {
  const size = cn("h-7 w-auto shrink-0", className);

  return (
    <>
      <Image
        alt={PLATFORM_NAME}
        className={cn(size, adaptive && "dark:hidden")}
        height={571}
        priority
        src="/brand/hostelpalika-mark.png"
        width={892}
      />
      {adaptive ? (
        <Image
          alt=""
          aria-hidden
          className={cn(size, "hidden dark:block")}
          height={571}
          src="/brand/hostelpalika-mark-light.png"
          width={892}
        />
      ) : null}
    </>
  );
}

/*
 * Column ranges of `hostelpalika-wordmark.png` (1614×229, transparent), measured
 * from the art: the H, the "ostel" after it, the P, and the "alika" after that.
 * Re-measure if the file is ever replaced.
 */
const WORDMARK = { height: 229, width: 1614 };
const WORDMARK_SEGMENTS = [
  { collapses: false, from: 0, ink: "dark", to: 186 },
  { collapses: true, from: 186, ink: "dark", to: 830 },
  { collapses: false, from: 830, ink: "brand", to: 1014 },
  { collapses: true, from: 1014, ink: "brand", to: WORDMARK.width },
] as const;

/**
 * The full "HostelPalika" wordmark that folds into the HP mark.
 *
 * Cut into four windows onto the one image. Folding shrinks "ostel" and
 * "alika" to nothing from their right edge, so the H and the P slide together
 * and what is left reads as the mark — the way Anthropic's wordmark folds into
 * its symbol as the page moves. Always follows the theme: the black half is
 * inverted under `.dark`, the green half is left alone.
 */
export function BrandWordmark({
  className,
  folded = false,
  height = 24,
}: {
  className?: string;
  folded?: boolean;
  /** Rendered height in px; widths follow the art. */
  height?: number;
}) {
  const scale = height / WORDMARK.height;

  return (
    <span
      aria-label={PLATFORM_NAME}
      className={cn("inline-flex shrink-0 items-stretch", className)}
      role="img"
      // Holds the unfolded width even while folded, so the fold plays inside
      // its own box and nothing laid out beside it moves.
      style={{ height, width: WORDMARK.width * scale }}
    >
      {WORDMARK_SEGMENTS.map((segment) => {
        const width = (segment.to - segment.from) * scale;
        const hidden = segment.collapses && folded;

        return (
          <span
            aria-hidden
            className={cn(
              "block h-full bg-no-repeat transition-[width,opacity] duration-500 ease-[cubic-bezier(0.65,0,0.35,1)] motion-reduce:transition-none",
              segment.ink === "dark" && "dark:invert",
            )}
            key={segment.from}
            style={{
              backgroundImage: "url(/brand/hostelpalika-wordmark.webp)",
              backgroundPosition: `${-segment.from * scale}px 0`,
              backgroundSize: `${WORDMARK.width * scale}px ${height}px`,
              opacity: hidden ? 0 : 1,
              width: hidden ? 0 : width,
            }}
          />
        );
      })}
    </span>
  );
}
