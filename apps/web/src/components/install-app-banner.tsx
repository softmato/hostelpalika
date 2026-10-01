"use client";

import { Download, X } from "lucide-react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { useSiteConfig } from "@/components/site-config-provider";

const DISMISS_KEY = "install-banner-dismissed";

/** Where the installable app lives; `?install` opens its own install sheet. */
const APP_INSTALL_HREF = "/app?install";

type Platform = "android" | "ios" | null;

type InstallPromptEvent = Event & { prompt(): Promise<void> };

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The phone install nudge on the public site.
 *
 * What installs is the phone app itself, exported for the web at `/app` — the
 * same screens as the Android build (see `app/manifest.ts`). On Android the
 * browser's own install prompt is held and fired by "Install"; where the
 * browser has not offered one, and on iPhone (no install API, only Share → Add
 * to Home Screen), "Install" opens `/app`, whose own sheet finishes the job.
 * One button on both platforms until the store apps are live.
 */
export function InstallAppBanner() {
  const { identity } = useSiteConfig();
  /*
   * A join link opens here, in the browser, because `/join/` is outside the
   * app's `/app` scope. Sending its "Install" to `/app` dropped the token: an
   * installed app opened on its home with nothing to do. So on a join link the
   * button opens the same link inside the app, installed or not.
   */
  const pathname = usePathname();
  const appHref = pathname?.startsWith("/join/") ? `/app${pathname}` : null;
  const [platform, setPlatform] = useState<Platform>(null);
  const [visible, setVisible] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const agent = navigator.userAgent;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const detected: Platform = /iPhone|iPad|iPod/i.test(agent)
      ? "ios"
      : /Android/i.test(agent)
        ? "android"
        : null;
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", capture);

    if (detected && !standalone) {
      // One-shot sync from the browser environment after mount; not derivable during SSR.
      /* eslint-disable react-hooks/set-state-in-effect */
      setPlatform(detected);
      setVisible(!readDismissed());
      /* eslint-enable react-hooks/set-state-in-effect */
    }

    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);

  if (!platform || !visible) {
    return null;
  }

  function dismiss() {
    setVisible(false);

    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Private mode: the banner simply comes back next visit.
    }
  }

  async function install() {
    if (appHref) {
      window.location.href = appHref;
      return;
    }

    if (!installPrompt) {
      window.location.href = APP_INSTALL_HREF;
      return;
    }

    await installPrompt.prompt();
    setInstallPrompt(null);
    setVisible(false);
  }

  return (
    <div className="fixed inset-x-3 bottom-3 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-xl">
      <Image alt="" className="size-10 shrink-0 rounded-xl" height={40} src="/icon.png" width={40} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-bold text-foreground">
          {appHref ? `Open in ${identity.siteName}` : `Install ${identity.siteName}`}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {appHref ? "Send your details from the app" : "Add the app to your home screen"}
        </span>
      </span>
      <button
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white"
        onClick={() => void install()}
        type="button"
      >
        <Download className="size-3.5" /> {appHref ? "Open" : "Install"}
      </button>
      <button
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        onClick={dismiss}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
