"use client";

import { Check, Copy, ShieldCheck } from "@/components/icons";
import { useState } from "react";

import { PublicShell } from "./shared";
import { SiteName } from "@/components/site-config-provider";

/**
 * Where a phone's camera lands after scanning someone's resident QR code.
 *
 * It deliberately shows *no* personal data — the ID alone is not a key to
 * anything readable here. It exists so a scan produces something meaningful for
 * whoever is holding the phone: the ID in large type, ready to be read out or
 * copied into the hostel-admin registration form.
 */
export function ResidentIdSharePage({ residentId }: { residentId: string }) {
  const [copied, setCopied] = useState(false);
  const formatted = residentId.toUpperCase();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the ID is selectable on screen either way.
    }
  }

  return (
    <PublicShell>
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-brand-teal-soft text-brand-teal">
          <ShieldCheck className="size-7" />
        </span>
        <h1 className="mt-5 font-heading text-2xl font-extrabold text-foreground">
          <SiteName /> resident ID
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Give this ID to the hostel and they can fill your registration from the details
          you already saved. Your information stays encrypted — the ID on its own does not
          reveal anything.
        </p>

        <p className="mt-8 select-all break-all font-mono text-3xl font-extrabold tracking-widest text-brand-teal">
          {formatted}
        </p>

        <button
          className="mt-5 inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-bold text-foreground transition hover:bg-muted"
          onClick={handleCopy}
          type="button"
        >
          {copied ? (
            <Check className="size-4 text-success" />
          ) : (
            <Copy className="size-4" />
          )}
          {copied ? "Copied" : "Copy ID"}
        </button>

        <p className="mt-10 text-xs text-muted-foreground">
          Not your ID? It is safe to close this page.
        </p>
      </div>
    </PublicShell>
  );
}
