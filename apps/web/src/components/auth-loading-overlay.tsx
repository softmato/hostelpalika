"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { BrandMark } from "@/components/brand-mark";
import { ShieldCheck } from "@/components/icons";

/**
 * The portal's first-load screen, styled after Google sign-in's: shown while
 * the account is read on a fresh tab. Only the portal uses it.
 * Portalled to `document.body` so a blurred header cannot trap it. See-through
 * and blurred, so the page behind reads as loaded and only its data is coming.
 */
const noSubscribe = () => () => {};

export function AuthLoadingOverlay({ message, title }: { message: string; title: string }) {
  // Client only: the server has no `document.body` to portal into.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/45 backdrop-blur-md animate-in fade-in duration-300">
      <div className="flex max-w-sm flex-col items-center px-6 text-center">
        <div className="relative mb-8 flex size-20 items-center justify-center rounded-2xl bg-brand-teal/10 text-brand-teal shadow-inner">
          <BrandMark className="h-8 animate-pulse" />
          <div className="absolute -inset-2.5 animate-spin rounded-3xl border-2 border-brand-teal/20 border-t-brand-teal" />
        </div>
        <h3 className="font-heading text-xl font-bold tracking-tight text-foreground">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <div className="mt-8 flex items-center gap-2 rounded-full border border-brand-teal/20 bg-brand-teal/10 px-3 py-1.5 text-[12px] font-semibold text-brand-teal">
          <ShieldCheck className="size-4 animate-bounce" />
          <span>Establishing secure session...</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
