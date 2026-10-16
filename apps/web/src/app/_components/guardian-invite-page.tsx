"use client";

import { CheckCircle2, ShieldCheck } from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { memo, useCallback, useState } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { browserApi } from "@/lib/browser-api";
import { Message } from "./resident-shared";

type AcceptResult = {
  accountCreated: boolean;
  email: string;
  hostelName: string;
};

/**
 * Public landing for the emailed guardian invitation. The token in the URL is
 * the only credential; everything about the resident stays server-side until
 * the guardian has an account and signs in.
 */
export const GuardianInvitePageContent = memo(function GuardianInvitePageContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<AcceptResult | null>(null);

  const handleAccept = useCallback(async () => {
    setMessage("");

    try {
      const response = await browserApi<AcceptResult>(
        "/api/v1/guardian/accept-invitation",
        { body: JSON.stringify({ token }), method: "POST" },
      );

      setResult(response);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "This invitation could not be accepted.",
      );
    }
  }, [token]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-12">
      <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
        {result ? (
          <div className="space-y-4 text-center">
            <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-role-guardian/10 text-role-guardian">
              <CheckCircle2 className="size-8" />
            </span>
            <h1 className="text-2xl font-bold text-foreground">Invitation accepted</h1>
            <p className="text-sm text-muted-foreground">
              You are now a guardian for a resident at {result.hostelName}.
              {result.accountCreated
                ? " We emailed sign-in details to "
                : " Sign in with your existing account ("}
              {result.email}
              {result.accountCreated ? "." : ")."}
            </p>
            <Link
              className="inline-flex h-11 items-center justify-center rounded-md bg-role-guardian px-6 text-sm font-semibold text-white"
              href="/login"
            >
              Go to sign in
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            <span className="flex size-14 items-center justify-center rounded-full bg-role-guardian/10 text-role-guardian">
              <ShieldCheck className="size-8" />
            </span>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-foreground">Guardian invitation</h1>
              <p className="text-sm text-muted-foreground">
                A resident has invited you as their guardian. Accepting links your account
                to them so you can see only what they chose to share — they can change or
                withdraw that at any time.
              </p>
            </div>
            <Message value={message} />
            {token ? (
              <BusyForm
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleAccept();
                }}
              >
                <SubmitButton className="inline-flex h-11 w-full items-center justify-center rounded-md bg-role-guardian text-sm font-semibold text-white">
                  Accept invitation
                </SubmitButton>
              </BusyForm>
            ) : (
              <p className="text-sm text-destructive">
                This link is missing its invitation token. Open the link from your email
                exactly as it was sent.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
});
