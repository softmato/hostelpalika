"use client";

import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { ShieldCheck } from "@/components/icons";
import { useSessionStore } from "@/stores/session-store";

/** If `/auth/me` never answers, the splash gives up rather than hold the portal hostage. */
const GIVE_UP_MS = 6000;
const FADE_MS = 200;

/**
 * The portal's first-load screen, styled after Google sign-in's.
 *
 * It is rendered **in the server HTML** (no portal, no mount gate), so it is
 * already on screen at first paint and the half-built page behind never shows
 * un-covered. It leaves once the session store has the account — which a move
 * between portal pages already has, so those never see it at all.
 *
 * The scrim is a translucent wash with a blur: whitish over the light theme,
 * darkish over the dark one. Mount it once, at the top of the portal shell, not
 * inside the header: a blurred ancestor would trap a `fixed` child.
 */
export function PortalBootSplash() {
  const resolved = useSessionStore((state) => state.status === "resolved");
  const [gaveUp, setGaveUp] = useState(false);
  const [gone, setGone] = useState(false);
  const done = resolved || gaveUp;

  useEffect(() => {
    const timer = window.setTimeout(() => setGaveUp(true), GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setGone(true), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [done]);

  if (gone) return null;

  return (
    <div
      aria-busy={!done}
      aria-live="polite"
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-white/60 backdrop-blur-xl transition-opacity dark:bg-black/55 ${
        done ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <div className="flex max-w-sm flex-col items-center px-6 text-center">
        <div className="relative mb-8 flex size-20 items-center justify-center rounded-2xl bg-brand-teal/10 text-brand-teal ring-1 ring-brand-teal/20">
          <BrandMark className="h-8" />
          <div className="absolute -inset-2.5 animate-spin rounded-3xl border-2 border-brand-teal/15 border-t-brand-teal [animation-duration:1.1s]" />
        </div>
        <h3 className="font-heading text-xl font-bold tracking-tight text-foreground">
          Opening your portal
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Please wait while we secure your connection and load your workspace.
        </p>
        <div className="mt-8 flex items-center gap-2 rounded-full border border-brand-teal/30 bg-brand-teal/10 px-3 py-1.5 text-[12px] font-semibold text-brand-teal dark:border-brand-teal/40 dark:bg-brand-teal/15">
          <ShieldCheck className="size-4" />
          <span>Establishing secure session...</span>
        </div>
      </div>
    </div>
  );
}
