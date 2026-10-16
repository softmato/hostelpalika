"use client";

import { CheckCircle2, Loader2, MailWarning } from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type VerifyState = "verifying" | "verified" | "error" | "missing";

export function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [state, setState] = useState<VerifyState>(token ? "verifying" : "missing");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/v1/auth/verify-email", {
          body: JSON.stringify({ token }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json();

        if (cancelled) {
          return;
        }

        if (payload.success) {
          setState("verified");
        } else {
          setState("error");
          setMessage(payload.message ?? "Verification failed.");
        }
      } catch {
        if (!cancelled) {
          setState("error");
          setMessage("Could not reach the server. Please try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 text-center shadow-lg sm:p-10">
        {state === "verifying" ? (
          <>
            <Loader2 className="mx-auto size-10 animate-spin text-brand-teal" />
            <h1 className="mt-6 text-2xl font-bold text-foreground">
              Verifying your email…
            </h1>
            <p className="mt-2 text-muted-foreground">This only takes a moment.</p>
          </>
        ) : null}

        {state === "verified" ? (
          <>
            <CheckCircle2 className="mx-auto size-10 text-emerald-600" />
            <h1 className="mt-6 text-2xl font-bold text-foreground">Email verified</h1>
            <p className="mt-2 text-muted-foreground">
              Your account is active. You can now log in.
            </p>
            <Link
              className="mt-6 inline-block rounded-lg bg-brand-teal px-6 py-3 text-sm font-semibold text-white"
              href="/login"
            >
              Go to login
            </Link>
          </>
        ) : null}

        {state === "error" || state === "missing" ? (
          <>
            <MailWarning className="mx-auto size-10 text-red-500" />
            <h1 className="mt-6 text-2xl font-bold text-foreground">
              Verification failed
            </h1>
            <p className="mt-2 text-muted-foreground">
              {state === "missing"
                ? "This link is missing its verification token."
                : (message ?? "The link is invalid or has expired.")}
            </p>
            <p className="mt-4 text-sm text-muted-foreground">
              You can request a new verification email from the login page.
            </p>
            <Link
              className="mt-6 inline-block rounded-lg bg-brand-teal px-6 py-3 text-sm font-semibold text-white"
              href="/login"
            >
              Back to login
            </Link>
          </>
        ) : null}
      </div>
    </main>
  );
}
