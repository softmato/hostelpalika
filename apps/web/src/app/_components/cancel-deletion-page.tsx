"use client";

import { CheckCircle2, ShieldAlert } from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

import { browserApi } from "@/lib/browser-api";

/**
 * Reached only from the link in the deletion email. The account is suspended,
 * so there is no session to read — the token in the URL is the credential.
 */
export function CancelDeletionPageContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const [message, setMessage] = useState("");
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCancel = useCallback(async () => {
    setBusy(true);
    setMessage("");

    try {
      await browserApi("/api/v1/auth/cancel-account-deletion", {
        body: JSON.stringify({ token }),
        method: "POST",
      });
      setRestored(true);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "This link could not be used. It may have expired.",
      );
    } finally {
      setBusy(false);
    }
  }, [token]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-12">
      <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        {restored ? (
          <div className="space-y-4">
            <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <CheckCircle2 className="size-8" />
            </span>
            <h1 className="text-2xl font-bold text-foreground">Your account is back</h1>
            <p className="text-sm text-muted-foreground">
              The deletion request has been cancelled and nothing was erased. You can
              sign in again straight away.
            </p>
            <Link
              className="inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground"
              href="/login"
            >
              Sign in
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <ShieldAlert className="size-8" />
            </span>
            <h1 className="text-2xl font-bold text-foreground">Keep your account?</h1>
            <p className="text-sm text-muted-foreground">
              Your account is scheduled for permanent deletion. Cancelling stops that and
              restores everything exactly as it was — nothing has been erased yet.
            </p>
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
            <button
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              disabled={busy || !token}
              onClick={handleCancel}
              type="button"
            >
              {busy ? "Cancelling…" : "Cancel deletion and restore my account"}
            </button>
            {token ? null : (
              <p className="text-xs text-muted-foreground">
                This link is missing its token. Open the link from your email again.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
