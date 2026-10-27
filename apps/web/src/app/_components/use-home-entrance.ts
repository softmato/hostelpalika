"use client";

import { useLayoutEffect, type RefObject } from "react";

// Kept for this document's lifetime, including client-side route remounts.
let entranceClaimed = false;

/** Only the homepage's initial document load may play this entrance. */
export function useHomeEntrance(pageRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const page = pageRef.current;
    const shell = page?.closest("main");
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;

    if (
      !shell ||
      !navigation ||
      new URL(navigation.name).pathname !== "/" ||
      window.location.pathname !== "/" ||
      navigation.type === "back_forward" ||
      entranceClaimed
    ) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const animations: Animation[] = [];
    const reveal = (element: Element, x: number, y: number, delay: number) => {
      animations.push(element.animate(
        [
          { opacity: 0, transform: `translate3d(${x}px, ${y}px, 0)` },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ],
        {
          delay,
          duration: 650,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          // Restore normal styles after completion; no permanent compositor layers.
          fill: "backwards",
        },
      ));
    };

    const groups = [
      { name: "logo", x: -28, y: 0, delay: 0 },
      { name: "actions", x: 28, y: 0, delay: 60 },
      { name: "art-left", x: -24, y: 0, delay: 100 },
      { name: "art-right", x: 24, y: 0, delay: 100 },
      { name: "chip", x: 0, y: 12, delay: 100 },
      { name: "headline", x: 0, y: 18, delay: 160 },
      { name: "search", x: 0, y: 20, delay: 240 },
      { name: "trust", x: 0, y: 12, delay: 320 },
    ];

    // Strict Mode cancels its first setup before this frame. Claim only when
    // playback actually starts, so remounts and restored routes cannot replay it.
    const frame = requestAnimationFrame(() => {
      if (entranceClaimed) return;
      entranceClaimed = true;
      if (reducedMotion.matches || typeof Element.prototype.animate !== "function") return;

      groups.forEach(({ name, x, y, delay }) => {
        shell.querySelectorAll(`[data-home-entrance="${name}"]`).forEach((element) => {
          reveal(element, x, y, delay);
        });
      });
      shell.querySelectorAll('[data-home-entrance="nav"] > *').forEach((element, index) => {
        reveal(element, 0, -16, 30 + index * 25);
      });
    });

    const cancel = () => animations.forEach((animation) => animation.cancel());
    const handleMotionChange = () => {
      if (reducedMotion.matches) cancel();
    };
    reducedMotion.addEventListener("change", handleMotionChange);
    return () => {
      cancelAnimationFrame(frame);
      cancel();
      reducedMotion.removeEventListener("change", handleMotionChange);
    };
  }, [pageRef]);
}
