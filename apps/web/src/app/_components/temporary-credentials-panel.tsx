"use client";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { Copy, KeyRound, ShieldAlert } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
} from "@/app/_components/shared-ui";
import { field } from "@/app/_components/portal-shared";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { usePortalResource } from "@/lib/portal-query";

const ENDPOINT = "/api/v1/users/temporary-credentials";
const SESSION_ENDPOINT = "/api/v1/auth/me";

type TemporaryCredential = {
  createdAt: string | null;
  expiresAt: string;
  id: string;
  label: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  useCount: number;
  username: string;
};

type CredentialList = { credentials: TemporaryCredential[]; limit: number };

/**
 * Only the one field this panel needs from `/auth/me`: whether the current
 * session was opened with a temporary credential rather than the account's own
 * password.
 */
type SessionSummary = { user: { viaTemporaryCredential?: boolean } };

type IssuedCredential = { password: string; username: string };

/**
 * Tailwind needs the class names whole, so each portal's accent is spelled out
 * rather than interpolated from a role string.
 */
const TONE_CLASSES = {
  admin: {
    button:
      "bg-role-admin focus-visible:outline-role-admin hover:opacity-90 disabled:opacity-60",
    soft: "border-role-admin/25 bg-role-admin/5",
  },
  resident: {
    button:
      "bg-role-resident focus-visible:outline-role-resident hover:opacity-90 disabled:opacity-60",
    soft: "border-role-resident/25 bg-role-resident/5",
  },
} as const;

const EXPIRY_OPTIONS = [
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "1 day" },
  { hours: 24 * 3, label: "3 days" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
];

const STATUS_STYLES: Record<TemporaryCredential["status"], string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  EXPIRED: "bg-muted text-muted-foreground",
  REVOKED: "bg-muted text-muted-foreground",
};

function formatMoment(value: string | null) {
  return value ? formatHostelDateTime(value) : "—";
}

/** One-shot clipboard copy that says so, since the password is never shown again. */
function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      // Clipboard access can be denied; the value is on screen either way.
      .catch(() => setCopied(false));
  }, [value]);

  return (
    <button
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold text-foreground transition hover:bg-muted"
      onClick={copy}
      type="button"
    >
      <Copy aria-hidden="true" className="size-3" />
      {copied ? "Copied" : `Copy ${label}`}
    </button>
  );
}

/**
 * Settings panel for issuing a second, expiring username + password that opens
 * **this same account** — the hand-off credential a hostel owner gives an
 * accountant for a week, or a resident gives a parent for one evening.
 *
 * Identical in both portals because the thing it manages is the account, not
 * the portal; only the accent colour differs.
 */
export const TemporaryCredentialsPanel = memo(function TemporaryCredentialsPanel({
  tone,
}: {
  tone: "admin" | "resident";
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const styles = TONE_CLASSES[tone];

  /*
   * The whole panel is owner-only, so it asks the session what it is before
   * asking for the list. The signal is the session's own flag rather than the
   * text of the 403 the list would answer with: the guard's wording is free to
   * change, and a panel that reads prose to decide what to render breaks
   * silently when it does.
   */
  const session = usePortalResource<SessionSummary>(SESSION_ENDPOINT, {
    errorMessage: "Could not confirm which login you are using.",
  });
  const borrowedSession = session.data?.user.viaTemporaryCredential === true;

  // Idle while the session is still resolving, and never asked for at all on a
  // borrowed login — that request could only 403, and it would light up the
  // panel's error state on the way to a screen that explains itself. A session
  // lookup that *failed* still asks: the API is the authority on who may read
  // this, so its answer is the one worth rendering.
  const resource = usePortalResource<CredentialList>(
    session.state !== "loading" && !borrowedSession ? ENDPOINT : null,
    { errorMessage: "Could not load temporary logins." },
  );

  const credentials = resource.data?.credentials ?? [];
  const limit = resource.data?.limit ?? 5;
  const activeCount = credentials.filter(
    (credential) => credential.status === "ACTIVE",
  ).length;

  const create = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      // `currentTarget` is null by the time the await resolves, so the form is
      // read — and reset — while the event is still live.
      const form = event.currentTarget;
      const data = new FormData(form);

      event.preventDefault();
      setBusy(true);
      setMessage("");
      setIssued(null);

      try {
        const result = await browserApi<{
          credential: TemporaryCredential;
          password: string;
        }>(ENDPOINT, {
          body: JSON.stringify({
            expiresInHours: Number(field(data, "expiresInHours")),
            label: field(data, "label") || undefined,
            username: field(data, "username"),
          }),
          method: "POST",
        });

        setIssued({
          password: result.password,
          username: result.credential.username,
        });
        form.reset();
        await resource.refreshAsync();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not create a temporary login.",
        );
      } finally {
        setBusy(false);
      }
    },
    [resource],
  );

  const revoke = useCallback(
    async (credential: TemporaryCredential) => {
      if (
        !window.confirm(
          `Revoke "${credential.username}"? Anyone signed in with it is signed out immediately.`,
        )
      ) {
        return;
      }

      setBusy(true);
      setMessage("");

      try {
        await browserApi(`${ENDPOINT}/${credential.id}`, { method: "DELETE" });
        setMessage(`"${credential.username}" was revoked.`);
        // A revoked credential's password can never be shown again, so a
        // still-visible hand-off box for it would be misleading.
        setIssued((current) =>
          current?.username === credential.username ? null : current,
        );
        await resource.refreshAsync();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not revoke this login.",
        );
      } finally {
        setBusy(false);
      }
    },
    [resource],
  );

  /*
   * Both early exits sit below every hook: `borrowedSession` flips once the
   * session resolves, and a return placed above the callbacks would change the
   * hook order between those two renders.
   */
  if (session.state === "loading") {
    return (
      <Panel title="Temporary access logins">
        <LoadingRows />
      </Panel>
    );
  }

  /*
   * The panel is owner-only, and the API says so with a 403. Rather than render
   * a form every button of which would fail, it explains why it is closed — a
   * borrower who did not realise which login they used otherwise reads this as
   * a broken page.
   */
  if (borrowedSession) {
    return (
      <Panel title="Temporary access logins">
        <div className={cn("flex items-start gap-2 rounded-lg border p-3", styles.soft)}>
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p className="text-sm text-muted-foreground">
            You are signed in with a temporary access login. Sign in with the
            account&apos;s own email and password to create or revoke these.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      action={
        <span className="text-[12px] font-medium text-muted-foreground">
          {activeCount} of {limit} active
        </span>
      }
      title="Temporary access logins"
    >
      <div className="grid gap-4">
        {/* The long explanation lives here, closed: what it is, and where the password comes from. */}
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Let someone into this account for a while with their own username and password.
            It expires on its own and you can revoke it any time.
          </span>
        </p>

        {message ? (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            {message}
          </div>
        ) : null}

        {issued ? (
          <div className={cn("grid gap-2 rounded-lg border p-3", styles.soft)}>
            <p className="text-[12px] font-semibold text-foreground">
              Copy the password now — it cannot be shown again.
            </p>
            <dl className="grid gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <dt className="text-muted-foreground">Username</dt>
                <dd className="font-mono font-semibold text-foreground">
                  {issued.username}
                </dd>
                <CopyButton label="username" value={issued.username} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <dt className="text-muted-foreground">Password</dt>
                <dd className="font-mono font-semibold break-all text-foreground">
                  {issued.password}
                </dd>
                <CopyButton label="password" value={issued.password} />
              </div>
            </dl>
          </div>
        ) : null}

        <form className="grid gap-2" onSubmit={create}>
          <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[1.2fr_0.9fr_1.2fr_auto]">
            <Input label="Username" name="username" placeholder="e.g. accountant-oct" required />
            <Select defaultValue="24" label="Expires after" name="expiresInHours">
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Input label="Note" name="label" placeholder="Optional — who is it for?" />
            <button
              className={cn(
                "h-10 rounded-md px-4 text-sm font-semibold text-white transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60",
                styles.button,
              )}
              disabled={busy || activeCount >= limit}
              type="submit"
            >
              {busy ? "Working…" : "Create login"}
            </button>
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            {activeCount >= limit
              ? `Limit of ${limit} active logins reached. Revoke one to add another.`
              : "Letters, digits, dots and dashes. The password is generated and shown once. It cannot change your password or manage logins."}
          </p>
        </form>

        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="Temporary logins could not be loaded." />
        ) : null}

        {resource.state === "ready" && credentials.length === 0 ? (
          <EmptyState label="No temporary logins yet." />
        ) : null}

        {credentials.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-semibold">Username</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold">Expires</th>
                  <th className="py-2 pr-3 font-semibold">Last used</th>
                  <th className="py-2 pr-3 font-semibold">Note</th>
                  <th className="py-2 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {credentials.map((credential) => (
                  <tr className="border-b border-border/60" key={credential.id}>
                    <td className="py-2.5 pr-3 font-mono font-semibold text-foreground">
                      {credential.username}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                          STATUS_STYLES[credential.status],
                        )}
                      >
                        {credential.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">
                      {formatMoment(credential.expiresAt)}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">
                      {credential.lastUsedAt
                        ? `${formatMoment(credential.lastUsedAt)} (${credential.useCount}×)`
                        : "Never"}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">
                      {credential.label || "—"}
                    </td>
                    <td className="py-2.5 text-right">
                      {credential.status === "ACTIVE" ? (
                        <button
                          className="rounded-md border border-border px-2.5 py-1.5 text-[12px] font-semibold text-foreground transition hover:bg-muted disabled:opacity-60"
                          disabled={busy}
                          onClick={() => void revoke(credential)}
                          type="button"
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Panel>
  );
});
