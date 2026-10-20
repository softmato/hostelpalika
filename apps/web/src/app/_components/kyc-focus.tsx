"use client";

import { ArrowLeft, Check } from "@/components/icons";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { API_WRITE_EVENT, browserApi } from "@/lib/browser-api";

type KycSteps = { kyc: { steps: { done: boolean; key: string }[] } };

async function stepDone(key: string) {
  const data = await browserApi<KycSteps>("/api/v1/hostel-admin/kyc");

  return data.kyc.steps.find((step) => step.key === key)?.done ?? false;
}

/**
 * Arriving from Hostel KYC (`?kyc=<step>`): rings the part of the page that
 * step fills in, scrolls to it, puts the cursor in its first field and keeps a
 * way back. Once a save finishes a step that was still open, it heads back to
 * KYC by itself. Pages mark that part with `data-kyc="<step>"` (space
 * separated when one block answers several steps).
 */
export function KycFocus({ kycHref }: { kycHref: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const step = useSearchParams().get("kyc");
  // The page that finished its step; the pill says so only while still on it.
  const [returnedFrom, setReturnedFrom] = useState<string | null>(null);
  const returning = returnedFrom === pathname;

  useEffect(() => {
    const key = step;
    let target: HTMLElement | undefined;

    if (!key || pathname.endsWith("/kyc")) return;

    const started = Date.now();
    // The block may sit behind a load or a tab the page opens itself, so look
    // for a visible one for a few seconds before giving up.
    const timer = window.setInterval(() => {
      target = [...document.querySelectorAll<HTMLElement>(`[data-kyc~="${CSS.escape(key)}"]`)].find(
        (element) => element.offsetParent !== null,
      );

      if (!target && Date.now() - started < 5000) return;
      window.clearInterval(timer);
      if (!target) return;

      target.classList.add("kyc-focus");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      (target.matches("button, input, textarea, select")
        ? target
        : target.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea, select")
      )?.focus({ preventScroll: true });
    }, 120);

    // Only a step that was open on arrival sends them back: changing a done
    // one keeps them here until they choose to leave.
    let wasOpen = false;
    let settle = 0;
    let leave = 0;
    void stepDone(key).then((done) => (wasOpen = !done), () => undefined);

    // A save is often an upload then an attach; wait for the writes to settle.
    const onWrite = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (!wasOpen) return;
        void stepDone(key).then((done) => {
          if (!done) return;
          wasOpen = false;
          setReturnedFrom(pathname);
          leave = window.setTimeout(() => router.push(kycHref), 900);
        }, () => undefined);
      }, 700);
    };

    window.addEventListener(API_WRITE_EVENT, onWrite);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(settle);
      window.clearTimeout(leave);
      window.removeEventListener(API_WRITE_EVENT, onWrite);
      target?.classList.remove("kyc-focus");
    };
  }, [kycHref, pathname, router, step]);

  if (!step || pathname.endsWith("/kyc")) return null;

  return (
    <Link
      className="fixed bottom-6 left-1/2 z-40 inline-flex h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background shadow-lg transition hover:opacity-90"
      href={kycHref}
    >
      {returning ? <Check className="size-4" /> : <ArrowLeft className="size-4" />}
      {returning ? "Saved — back to KYC…" : "Back to KYC"}
    </Link>
  );
}
