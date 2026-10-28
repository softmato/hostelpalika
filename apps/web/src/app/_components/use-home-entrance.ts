"use client";

import { useEffect } from "react";

/**
 * The entrance itself is CSS (see `html[data-home-entrance]` in globals.css),
 * switched on by the inline script in the root layout before the first paint,
 * so the server-rendered page never shows itself and then starts over. All that
 * is left here is switching it off once it has played, so a client-side return
 * to the homepage does not replay it.
 */
export function useHomeEntrance() {
  useEffect(() => {
    const timer = window.setTimeout(
      () => document.documentElement.removeAttribute("data-home-entrance"),
      1400,
    );
    return () => window.clearTimeout(timer);
  }, []);
}
