"use client";

import { CheckCircle2, ShieldCheck, TriangleAlert } from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { LoadingRows, Panel } from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";

type ChangeRow = { from: string; label: string; to: string };

type ChangePreview = {
  expiresAt: string;
  key: string;
  label: string;
  rows: ChangeRow[];
  sentTo: string;
  status: string;
};

const CLOSED: Record<string, string> = {
  APPLIED: "This change is already saved.",
  CANCELLED: "This change was cancelled.",
  EXPIRED: "This link has expired. Make the change again.",
  SUPERSEDED: "A newer change replaced this one. Use the link in the latest email.",
};

/** Where to go back to after confirming, per setting. */
const RETURN_TO: Record<string, { href: string; label: string }> = {
  bookings: { href: "/platform/bookings?tab=settings", label: "Back to booking settings" },
  "collection-qr": { href: "/platform/settings", label: "Back to settings" },
};

/**
 * The page behind the confirm link in a settings-change email.
 *
 * Signed in as the superadmin who asked, it shows old and new side by side and
 * applies nothing until the button is pressed — opening a link is not consent,
 * and mail scanners open links.
 */
export function PlatformSettingChangeConfirmPageContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";

  const [change, setChange] = useState<ChangePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;

    browserApi<{ change: ChangePreview }>(
      `/api/v1/platform/setting-changes/confirm?token=${encodeURIComponent(token)}`,
    )
      .then((data) => {
        if (active) setChange(data.change);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "This link could not be opened.");
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError("");

    try {
      await browserApi("/api/v1/platform/setting-changes/confirm", {
        body: JSON.stringify({ token }),
        method: "POST",
      });
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  }, [token]);

  const back = RETURN_TO[change?.key ?? ""] ?? { href: "/platform/dashboard", label: "Back to dashboard" };
  const closed = change && change.status !== "PENDING" ? CLOSED[change.status] : null;

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4">
      <Panel title="Confirm a settings change">
        {!change && !error ? <LoadingRows /> : null}

        {done ? (
          <div className="grid justify-items-start gap-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
              Saved. The change to {change?.label} is live.
            </p>
            <Link className="text-sm font-semibold text-primary" href={back.href}>
              {back.label}
            </Link>
          </div>
        ) : null}

        {!done && change ? (
          <div className="grid gap-4">
            <p className="flex items-center gap-2 text-sm text-foreground">
              <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
              Change to <span className="font-semibold">{change.label}</span>
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Setting</th>
                    <th className="py-2 pr-3 font-medium">Now</th>
                    <th className="py-2 font-medium">New</th>
                  </tr>
                </thead>
                <tbody>
                  {change.rows.map((row) => (
                    <tr className="border-t border-border" key={row.label}>
                      <td className="py-2 pr-3 text-muted-foreground">{row.label}</td>
                      <td className="py-2 pr-3 text-muted-foreground line-through">{row.from}</td>
                      <td className="py-2 font-semibold text-foreground">{row.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {closed ? (
              <p className="flex items-center gap-2 text-sm text-foreground">
                <TriangleAlert aria-hidden="true" className="size-4 text-warning" />
                {closed}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void confirm()}
                  type="button"
                >
                  {busy ? "Saving…" : "Confirm change"}
                </button>
                <Link className="text-sm font-semibold text-muted-foreground" href={back.href}>
                  Not now
                </Link>
              </div>
            )}
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-destructive" role="alert">
            <TriangleAlert aria-hidden="true" className="size-4" />
            {error}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
