"use client";

import { Download, Monitor, Smartphone } from "@/components/icons";
import Image from "next/image";
import { useEffect, useState } from "react";

import { PLATFORM_NAME, PLATFORM_SITE_URL } from "@hostel/shared/brand/brand";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Platform = "desktop" | "android" | "ios";

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// The browser offers its install prompt once per page load, usually before
// this dialog has mounted — so it is caught here, at import, and read later.
let heldPrompt: InstallPromptEvent | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    heldPrompt = event as InstallPromptEvent;
  });
}

const TAB_LABELS: Record<Platform, string> = { android: "Android", desktop: "Desktop", ios: "iPhone" };

/**
 * "Get the app": a QR a field agent holds up for an owner to scan.
 *
 * Android points at `/get-app`, which opens the Play listing — a stable link,
 * so a printed QR survives the listing or APK changing. iPhone
 * points at the installable web app with `?install`, whose sheet walks through
 * Add to Home Screen until the App Store build exists.
 */
export function GetAppDialog({
  className,
  open,
  onOpenChange,
}: {
  className?: string;
  /** Controlled from a menu item: no trigger button of its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [platform, setPlatform] = useState<Platform>("desktop");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [qr, setQr] = useState({ data: "", url: "" });
  // Always the production site: a QR scanned off a dev or preview build must
  // still land on the real one.
  const link = `${PLATFORM_SITE_URL}${platform === "android" ? "/get-app" : "/app?install"}`;

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    setInstallPrompt(heldPrompt);
    /* eslint-enable react-hooks/set-state-in-effect */

    const capture = (event: Event) => setInstallPrompt(event as InstallPromptEvent);
    const done = () => setInstalled(true);

    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", done);

    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", done);
    };
  }, []);

  async function installDesktop() {
    if (!installPrompt) return;

    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;

    heldPrompt = null;
    setInstallPrompt(null);
    if (outcome === "accepted") setInstalled(true);
  }

  useEffect(() => {
    if (platform === "desktop") return;

    void import("qrcode").then(({ toDataURL }) =>
      toDataURL(link, { margin: 1, width: 480 }).then((data) => setQr({ data, url: link })),
    );
  }, [link, platform]);

  const tabs = (
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="tablist">
      {(["desktop", "android", "ios"] as const).map((option) => (
        <button
          aria-selected={platform === option}
          className={cn(
            "rounded-md py-1.5 text-sm font-semibold transition",
            platform === option ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
          )}
          key={option}
          onClick={() => setPlatform(option)}
          role="tab"
          type="button"
        >
          {TAB_LABELS[option]}
        </button>
      ))}
    </div>
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open === undefined ? (
      <DialogTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted",
            className,
          )}
          type="button"
        >
          <Smartphone className="size-4" /> Get the app
        </button>
      </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{platform === "desktop" ? "Install the app" : "Scan to get the app"}</DialogTitle>
          <DialogDescription>
            {platform === "desktop"
              ? "Opens in its own window with a shortcut on this computer — no browser tabs."
              : platform === "android"
              ? `Opens ${PLATFORM_NAME} on Google Play on the phone that scans it.`
              : "Opens the website; tap Share → Add to Home Screen to install it. The iPhone app is coming soon."}
          </DialogDescription>
        </DialogHeader>

        {tabs}

        {platform === "desktop" ? (
          <>
            {/* The shortcut as it will sit on the desktop: icon, name beneath. */}
            <div className="mx-auto flex h-60 w-full items-center justify-center rounded-xl border border-border bg-white">
              <div className="flex w-28 flex-col items-center gap-2 rounded-lg p-2 text-center">
                <Image alt="" className="size-20 rounded-2xl" height={80} priority src="/icon.png" width={80} />
                <span className="text-[13px] font-semibold leading-tight text-neutral-900">
                  {PLATFORM_NAME}
                </span>
              </div>
            </div>
            {installed ? (
              <p className="text-center text-sm font-semibold text-brand-teal">Installed on this computer</p>
            ) : installPrompt ? (
              <button
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-teal text-sm font-bold text-white transition hover:opacity-90"
                onClick={() => void installDesktop()}
                type="button"
              >
                <Download className="size-4" /> Install on this computer
              </button>
            ) : (
              <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
                <Monitor className="size-3.5 shrink-0" />
                Install isn&apos;t offered here. In Chrome or Edge, use the install icon in the address bar.
              </p>
            )}
          </>
        ) : (
          <>
        <div className="mx-auto flex size-60 items-center justify-center rounded-xl border border-border bg-white p-2">
          {qr.url === link && qr.data ? (
            <Image alt={`QR code for ${link}`} height={224} src={qr.data} unoptimized width={224} />
          ) : (
            <div className="size-full animate-pulse rounded-lg bg-muted" />
          )}
        </div>
        <a
          className="block truncate text-center text-xs font-medium text-brand-teal hover:underline"
          href={link}
          rel="noreferrer"
          target="_blank"
        >
          {link}
        </a>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
