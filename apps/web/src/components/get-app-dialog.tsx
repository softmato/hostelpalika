"use client";

import { Smartphone } from "lucide-react";
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

type Platform = "android" | "ios";

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
  const [platform, setPlatform] = useState<Platform>("android");
  const [qr, setQr] = useState({ data: "", url: "" });
  // Always the production site: a QR scanned off a dev or preview build must
  // still land on the real one.
  const link = `${PLATFORM_SITE_URL}${platform === "android" ? "/get-app" : "/app?install"}`;

  useEffect(() => {
    void import("qrcode").then(({ toDataURL }) =>
      toDataURL(link, { margin: 1, width: 480 }).then((data) => setQr({ data, url: link })),
    );
  }, [link]);

  const tabs = (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
      {(["android", "ios"] as const).map((option) => (
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
          {option === "android" ? "Android" : "iPhone"}
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
          <DialogTitle>Scan to get the app</DialogTitle>
          <DialogDescription>
            {platform === "android"
              ? `Opens ${PLATFORM_NAME} on Google Play on the phone that scans it.`
              : "Opens the website; tap Share → Add to Home Screen to install it. The iPhone app is coming soon."}
          </DialogDescription>
        </DialogHeader>

        {tabs}

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
      </DialogContent>
    </Dialog>
  );
}
