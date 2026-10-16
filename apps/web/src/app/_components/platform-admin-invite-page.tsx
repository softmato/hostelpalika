"use client";

import { CheckCircle2, ShieldCheck, ShieldHalf, Users } from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { memo, useCallback, useEffect, useState } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { browserApi } from "@/lib/browser-api";
import { Role } from "@/lib/roles";
import { Message } from "./resident-shared";

type Invitation = {
  email: string;
  expiresAt: string;
  role: string;
  roleLabel: string;
};

type AcceptResult = {
  accountCreated: boolean;
  email: string;
  roleLabel: string;
};

/**
 * Public landing for the emailed platform admin invitation — the sibling of
 * `cook-invite-page.tsx` and `guardian-invite-page.tsx`, and deliberately the
 * same shape, because it is the same problem: an emailed link that grants a
 * role on an address the recipient already controls.
 *
 * One button, and nothing to fill in. The link arrived in their mailbox and
 * they opened it; a name and a password on top of that would be asking them to
 * prove something already proved and to invent a credential they do not need —
 * Google sign-in matches the account this creates by email and carries the role
 * straight through.
 *
 * What it *does* show, before the button rather than after it, is which address
 * and which grade. Accepting a superadmin invitation and accepting a moderator
 * invitation are very different things to have done.
 */
export const PlatformAdminInvitePageContent = memo(
  function PlatformAdminInvitePageContent() {
    const searchParams = useSearchParams();
    const token = searchParams.get("token")?.trim() ?? "";

    const [invitation, setInvitation] = useState<Invitation | null>(null);
    const [loadError, setLoadError] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [message, setMessage] = useState("");
    const [result, setResult] = useState<AcceptResult | null>(null);

    useEffect(() => {
      if (!token) {
        return;
      }

      let cancelled = false;

      void (async () => {
        try {
          const response = await browserApi<{ invitation: Invitation }>(
            `/api/v1/platform-admin/invitation?token=${encodeURIComponent(token)}`,
          );

          if (!cancelled) {
            setInvitation(response.invitation);
          }
        } catch (error) {
          if (!cancelled) {
            setLoadError(
              error instanceof Error
                ? error.message
                : "This invitation could not be opened.",
            );
          }
        } finally {
          if (!cancelled) {
            setLoaded(true);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [token]);

    // Derived rather than tracked: a link with no token never loads anything,
    // so "loading" is exactly "there is a token and the read has not settled".
    const loading = Boolean(token) && !loaded;

    const isSuperadmin = invitation?.role === Role.SUPERADMIN;
    /*
     * A field agent signs in the ordinary way — email and password — so their
     * acceptance sets one. An admin's does not: that account is created without
     * a password at all and finishes at Google sign-in, so offering a password
     * box would be offering a credential nothing would ever check.
     */
    const isAgent = invitation?.role === Role.PLATFORM_AGENT;

    const handleAccept = useCallback(async () => {
      setMessage("");

      try {
        const response = await browserApi<AcceptResult>(
          "/api/v1/platform-admin/accept-invitation",
          { body: JSON.stringify({ token }), method: "POST" },
        );

        setResult(response);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "This invitation could not be accepted.",
        );
      }
    }, [token]);

    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-12">
        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          {result ? (
            <div className="space-y-4 text-center">
              <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-role-platform-soft text-role-platform">
                <CheckCircle2 className="size-8" />
              </span>
              <h1 className="text-2xl font-bold text-foreground">Invitation accepted</h1>
              <p className="text-sm text-muted-foreground">
                {result.email} is now {result.roleLabel.toLowerCase()} on the platform.{" "}
                Sign in with Google using that address.
              </p>
              <Link
                className="inline-flex h-11 items-center justify-center rounded-md bg-role-platform px-6 text-sm font-semibold text-white"
                href="/login"
              >
                Go to sign in
              </Link>
            </div>
          ) : (
            <div className="space-y-5">
              <span className="flex size-14 items-center justify-center rounded-full bg-role-platform-soft text-role-platform">
                {isSuperadmin ? (
                  <ShieldCheck className="size-8" />
                ) : isAgent ? (
                  <Users className="size-8" />
                ) : (
                  <ShieldHalf className="size-8" />
                )}
              </span>
              <div className="space-y-2">
                <h1 className="text-2xl font-bold text-foreground">
                  {invitation
                    ? `${invitation.roleLabel} invitation`
                    : "Platform invitation"}
                </h1>
                {invitation ? (
                  <p className="text-sm text-muted-foreground">
                    You have been invited to the platform team as a{" "}
                    <strong className="text-foreground">{invitation.roleLabel}</strong>,
                    on <strong className="text-foreground">{invitation.email}</strong>.{" "}
                    {isSuperadmin
                      ? "A superadmin can see and change everything on the platform, including who else holds admin access."
                      : isAgent
                        ? "A team member registers hostels on their owners' behalf and collects the first payment. It does not open the platform admin portal."
                        : "A platform moderator handles approvals, verification and moderation, and can read the reports."}
                  </p>
                ) : null}
              </div>

              {loading ? (
                <div className="h-20 animate-pulse rounded-md bg-muted" />
              ) : null}

              {!token ? (
                <p className="text-sm text-destructive">
                  This link is missing its invitation token. Open the link from your email
                  exactly as it was sent.
                </p>
              ) : null}

              {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}

              <Message value={message} />

              {invitation ? (
                <BusyForm
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleAccept();
                  }}
                >
                  <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                    Accepting takes effect straight away. Afterwards, sign in with
                    Google using {invitation.email}
                    {isAgent ? " and open /team" : ""} — there is no password to set
                    up.
                  </p>
                  <SubmitButton className="inline-flex h-11 w-full items-center justify-center rounded-md bg-role-platform text-sm font-semibold text-white">
                    Yes, accept this invitation
                  </SubmitButton>
                </BusyForm>
              ) : null}
            </div>
          )}
        </div>
      </main>
    );
  },
);
