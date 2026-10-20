"use client";

import { Plus, RotateCw, Trash2 } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { EmptyState, Input, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { Chip, RowMark } from "@/app/_components/hostel-admin-page-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [adding, setAdding] = useState(false);

  const cooks = resource.data?.cooks ?? [];
  const live = cooks.filter((cook) => cook.status !== "REMOVED");
  const past = cooks.filter((cook) => cook.status === "REMOVED");

  const add = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      // Held before the await: React clears `currentTarget` once the handler
      // returns, so reading it after the request would throw.
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
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
        formElement.reset();
        setAdding(false);

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
    <Panel
      action={
        <Button onClick={() => setAdding(true)} size="sm" type="button" variant="outline">
          <Plus className="size-3.5" />
          Add cook
        </Button>
      }
      title="Cooks"
    >
      {/* A cook can announce that a meal is ready and post photos of it —
          nothing else. No resident records, no money, no complaints. */}
      <p className="mb-3 text-[12.5px] text-muted-foreground">They post that a meal is ready, with photos. Nothing else.</p>

      {message && !adding ? (
        <div className="mb-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-[13.5px]">
          {message}
        </div>
      ) : null}

      {issued ? (
        <div className="mb-3 grid gap-2 rounded-2xl bg-role-team-soft p-4 text-[13.5px]">
          <p className="font-semibold text-foreground">
            {issued.rotated
              ? `New password for ${issued.cookName}. The old one no longer works.`
              : `Sign-in for ${issued.cookName}`}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Sign-in
              </span>
              <code className="break-all font-mono text-[13.5px] text-foreground">
                {issued.credentials.email}
              </code>
            </div>
            <div className="grid gap-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                First-time password
              </span>
              <code className="break-all font-mono text-[13.5px] font-bold text-foreground">
                {issued.credentials.temporaryPassword}
              </code>
            </div>
          </div>
          {/* A copy is emailed to the admin; once dismissed nobody can read it
              back — only a rotation issues a new one. */}
          <p className="text-[12px] text-muted-foreground">Write it down now. It cannot be shown again.</p>
          <div>
            <Button onClick={() => setIssued(null)} size="sm" type="button" variant="outline">
              I have written it down
            </Button>
          </div>
        </div>
      ) : null}

      {resource.state === "loading" ? (
        <LoadingRows />
      ) : live.length === 0 ? (
        <EmptyState label="Nobody has the kitchen yet." />
      ) : (
        <ul className="divide-y divide-border/60">
          {live.map((cook) => (
            <li className="flex flex-wrap items-center gap-3 py-2.5" key={cook.id}>
              <RowMark glyph="chef-hat" />

              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold text-foreground">
                  {cook.name}
                </p>
                <code className="block truncate font-mono text-[12px] text-muted-foreground">
                  {cook.loginEmail}
                </code>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Chip glyph={cook.kind === "CREDENTIAL" ? "key" : "mail"}>
                  {cook.kind === "CREDENTIAL" ? "Sign-in issued" : "Own email"}
                </Chip>
                {cook.invitationPending ? (
                  <Chip tone="warn">
                    {`Not accepted${cook.invitationExpiresAt ? ` · expires ${shortDate(cook.invitationExpiresAt)}` : ""}`}
                  </Chip>
                ) : null}
                {cook.initialPasswordPending ? <Chip tone="warn">First password unused</Chip> : null}
              </div>

              <div className="flex items-center gap-1">
                {/*
                  Rotation is offered only for a generated sign-in. An invited
                  cook's password is on their own account; a button here would
                  promise a reset we are not allowed to perform.
                */}
                {cook.kind === "CREDENTIAL" ? (
                  <Button
                    disabled={busy}
                    onClick={() => void rotate(cook)}
                    size="sm"
                    title="Issue a new first-time password"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCw className="size-3.5" />
                    New password
                  </Button>
                ) : null}
                <Button
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  onClick={() => void remove(cook)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {past.length > 0 ? (
        <div className="mt-3 border-t border-border/60 pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            No longer here
          </p>
          <div className="flex flex-wrap gap-1.5">
            {past.map((cook) => (
              <span
                className="rounded-full bg-muted px-2.5 py-1 text-[12px] text-muted-foreground"
                key={cook.id}
                title={cook.removedAt ? `Removed ${shortDate(cook.removedAt)}` : undefined}
              >
                {/*
                  The frozen label, not the person's name: this is what their
                  announcements and photos are attributed to from here on, and
                  this list is the only place an admin can see it.
                */}
                <span className="font-medium text-foreground">{cook.historicalName || cook.name}</span>
                {` — was ${cook.name}`}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a cook</DialogTitle>
            <DialogDescription>Their name shows beside the food photos and the ready call.</DialogDescription>
          </DialogHeader>
          {message ? <p className="text-[12.5px] text-muted-foreground">{message}</p> : null}
          <form className="grid gap-3" onSubmit={add}>
            <div className="flex gap-1 rounded-xl bg-muted p-1">
              {(
                [
                  { label: "Create a sign-in", value: "CREDENTIAL" },
                  { label: "Invite by email", value: "INVITE" },
                ] as const
              ).map((option) => (
                <button
                  className={cn(
                    "flex-1 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition",
                    mode === option.value
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  key={option.value}
                  onClick={() => setMode(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>

            <Input label="Cook name" name="name" />
            {mode === "INVITE" ? (
              <Input
                hint="Their own account becomes the cook account."
                label="Their email"
                name="email"
                type="email"
              />
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                We make a sign-in and a first-time password, shown once. No email needed.
              </p>
            )}

            <DialogFooter>
              <Button
                className="h-10 rounded-xl bg-brand-teal px-5 text-white hover:bg-brand-teal/90"
                loading={busy}
                type="submit"
              >
                {mode === "CREDENTIAL" ? "Create the sign-in" : "Send the invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Panel>
  );
});
