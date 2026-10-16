"use client";

import { ChefHat, KeyRound, Mail, RotateCw, Trash2 } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { EmptyState, Input, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

/**
 * The kitchen roster — who may tell residents that food is ready.
 *
 * ## What this replaced
 *
 * A collapsed "See cook credentials" panel on the Food page, holding one login,
 * one password status and an enable/disable button. That was the whole feature
 * while a hostel could have exactly one cook. It now has a list, two ways of
 * granting access, a rotation and a removal that renames a departed cook's
 * history — so the panel became a section of its own, mirroring `manage/cook`
 * on mobile.
 *
 * ## The password appears once
 *
 * Only a bcrypt hash is stored. There is no endpoint that can read a password
 * back, for this page or for anybody, so the plaintext is held in component
 * state for exactly as long as the admin leaves the row open, and the answer to
 * "we lost it" is Rotate.
 */

type CookAccount = {
  addedAt?: string;
  credentialIssuedAt?: string;
  historicalName?: string;
  id: string;
  initialPasswordPending: boolean;
  invitationExpiresAt?: string;
  invitationPending: boolean;
  kind: "CREDENTIAL" | "INVITE";
  loginEmail: string;
  name: string;
  removedAt?: string;
  status: "INVITED" | "ACTIVE" | "REMOVED";
};

type Credentials = { email: string; temporaryPassword: string };

type Issued = { cookName: string; credentials: Credentials; rotated: boolean };

function shortDate(value?: string) {
  return value ? new Date(value).toLocaleDateString() : "";
}

export const HostelAdminCooksPanel = memo(function HostelAdminCooksPanel() {
  const invalidate = useInvalidateResources();
  const resource = usePortalResource<{ cooks: CookAccount[]; portalEnabled: boolean }>(
    hostelAdminEndpoints.cooks,
    { errorMessage: "Could not load the kitchen roster." },
  );

  const [mode, setMode] = useState<"CREDENTIAL" | "INVITE">("CREDENTIAL");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [issued, setIssued] = useState<Issued | null>(null);

  const cooks = resource.data?.cooks ?? [];
  const live = cooks.filter((cook) => cook.status !== "REMOVED");
  const past = cooks.filter((cook) => cook.status === "REMOVED");

  const add = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const form = new FormData(event.currentTarget);
      const name = String(form.get("name") ?? "").trim();
      const email = String(form.get("email") ?? "").trim();

      if (name.length < 2) {
        setMessage("Give the cook a name — it is what residents see beside the food.");
        return;
      }

      setBusy(true);
      setMessage("");

      try {
        const result = await browserApi<{ cook: CookAccount; credentials?: Credentials }>(
          hostelAdminEndpoints.cooks,
          {
            body: JSON.stringify(
              mode === "CREDENTIAL" ? { kind: "CREDENTIAL", name } : { email, kind: "INVITE", name },
            ),
            method: "POST",
          },
        );

        invalidate(hostelAdminEndpoints.cooks);
        invalidate(hostelAdminEndpoints.cookPortal);
        event.currentTarget.reset();

        if (result.credentials) {
          setIssued({ cookName: name, credentials: result.credentials, rotated: false });
          setMessage("");
        } else {
          setMessage(`Invitation sent to ${email}. It expires in seven days.`);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not add that cook.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate, mode],
  );

  const rotate = useCallback(
    async (cook: CookAccount) => {
      setBusy(true);
      setMessage("");

      try {
        const result = await browserApi<{ credentials?: Credentials }>(
          `${hostelAdminEndpoints.cooks}/${cook.id}`,
          { body: JSON.stringify({ rotate: true }), method: "PATCH" },
        );

        invalidate(hostelAdminEndpoints.cooks);

        if (result.credentials) {
          setIssued({ cookName: cook.name, credentials: result.credentials, rotated: true });
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not issue a password.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  const remove = useCallback(
    async (cook: CookAccount) => {
      const confirmed = window.confirm(
        cook.kind === "CREDENTIAL"
          ? `Remove ${cook.name}? This sign-in is deleted and cannot be used again. Everything they already announced stays, filed under "previous cook".`
          : `Remove ${cook.name}? They stop being a cook here; their own account is untouched. Everything they already announced stays, filed under "previous cook".`,
      );

      if (!confirmed) {
        return;
      }

      setBusy(true);
      setMessage("");

      try {
        const result = await browserApi<{ cook: CookAccount }>(
          `${hostelAdminEndpoints.cooks}/${cook.id}`,
          { method: "DELETE" },
        );

        invalidate(hostelAdminEndpoints.cooks);
        invalidate(hostelAdminEndpoints.cookPortal);
        setMessage(
          result.cook.historicalName
            ? `Removed. Their past announcements now read "${result.cook.historicalName}".`
            : "Removed.",
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not remove that cook.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  return (
    <Panel title="Cooks">
      <p className="mb-3 text-sm text-muted-foreground">
        A cook can announce that a meal is ready and post photos of it — nothing else.
        No resident records, no money, no complaints.
      </p>

      {message ? (
        <div className="mb-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {message}
        </div>
      ) : null}

      {issued ? (
        <div className="mb-3 grid gap-2 rounded-lg border border-role-admin/40 bg-role-admin/5 p-3 text-sm">
          <p className="font-semibold text-foreground">
            {issued.rotated
              ? `New password for ${issued.cookName}. The old one no longer works.`
              : `Sign-in for ${issued.cookName}`}
          </p>
          <div className="grid gap-0.5">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Sign-in
            </span>
            <code className="break-all font-mono text-sm text-foreground">
              {issued.credentials.email}
            </code>
          </div>
          <div className="grid gap-0.5">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              First-time password
            </span>
            <code className="break-all font-mono text-sm font-bold text-foreground">
              {issued.credentials.temporaryPassword}
            </code>
          </div>
          <p className="text-xs text-muted-foreground">
            Write it down now. A copy has been emailed to you, and once this is
            dismissed nobody can read it back — only a rotation issues a new one.
          </p>
          <div>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted/50"
              onClick={() => setIssued(null)}
              type="button"
            >
              I have written it down
            </button>
          </div>
        </div>
      ) : null}

      {resource.state === "loading" ? (
        <LoadingRows />
      ) : live.length === 0 ? (
        <EmptyState label="Nobody has the kitchen yet." />
      ) : (
        <ul className="grid gap-2">
          {live.map((cook) => (
            <li
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
              key={cook.id}
            >
              <ChefHat className="size-4 shrink-0 text-role-admin" />

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {cook.name}
                </p>
                <code className="block truncate font-mono text-xs text-muted-foreground">
                  {cook.loginEmail}
                </code>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                  {cook.kind === "CREDENTIAL" ? (
                    <KeyRound className="size-3" />
                  ) : (
                    <Mail className="size-3" />
                  )}
                  {cook.kind === "CREDENTIAL" ? "Sign-in issued" : "Own email"}
                </span>
                {cook.invitationPending ? (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-warning">
                    Not accepted
                    {cook.invitationExpiresAt
                      ? ` · expires ${shortDate(cook.invitationExpiresAt)}`
                      : ""}
                  </span>
                ) : null}
                {cook.initialPasswordPending ? (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-warning">
                    First password unused
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-1.5">
                {/*
                  Rotation is offered only for a generated sign-in. An invited
                  cook's password is on their own account; a button here would
                  promise a reset we are not allowed to perform.
                */}
                {cook.kind === "CREDENTIAL" ? (
                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted/50 disabled:opacity-60"
                    disabled={busy}
                    onClick={() => void rotate(cook)}
                    title="Issue a new first-time password"
                    type="button"
                  >
                    <RotateCw className="size-3" />
                    New password
                  </button>
                ) : null}
                <button
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void remove(cook)}
                  type="button"
                >
                  <Trash2 className="size-3" />
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {past.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            No longer here
          </p>
          <ul className="grid gap-1 text-sm text-muted-foreground">
            {past.map((cook) => (
              <li key={cook.id}>
                {/*
                  The frozen label, not the person's name: this is what their
                  announcements and photos are attributed to from here on, and
                  this list is the only place an admin can see it.
                */}
                <span className="text-foreground">
                  {cook.historicalName || cook.name}
                </span>
                {` — was ${cook.name}`}
                {cook.removedAt ? `, removed ${shortDate(cook.removedAt)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form className="mt-3 grid gap-3 border-t border-border pt-3" onSubmit={add}>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { hint: "We make the login. No email needed.", label: "Create a sign-in", value: "CREDENTIAL" },
              { hint: "They accept from their own inbox.", label: "Invite by email", value: "INVITE" },
            ] as const
          ).map((option) => (
            <button
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-semibold transition",
                mode === option.value
                  ? "border-role-admin bg-role-admin/10 text-role-admin"
                  : "border-border text-muted-foreground hover:bg-muted/50",
              )}
              key={option.value}
              onClick={() => setMode(option.value)}
              title={option.hint}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            hint="Shown to residents beside food photos and the ready announcement."
            label="Cook name"
            name="name"
          />
          {mode === "INVITE" ? (
            <Input
              hint="They open the link and their own account becomes the cook account."
              label="Their email"
              name="email"
              type="email"
            />
          ) : (
            <p className="self-end text-xs text-muted-foreground">
              A short sign-in and a first-time password are generated and shown here
              once. The cook needs no email at all.
            </p>
          )}
        </div>

        <div>
          <Button
            className="h-11 bg-role-admin px-5 text-sm font-semibold text-white hover:bg-role-admin/85"
            loading={busy}
            type="submit"
          >
            {mode === "CREDENTIAL" ? "Create the sign-in" : "Send the invitation"}
          </Button>
        </div>
      </form>
    </Panel>
  );
});
