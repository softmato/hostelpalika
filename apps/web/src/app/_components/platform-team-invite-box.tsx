"use client";

import { Loader2, Plus, Send, Trash2 } from "@/components/icons";
import { useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import type { TeamInviteResult } from "./platform-team-types";

/**
 * The invite box on the superadmin's Team tab.
 *
 * ## A batch is the normal case, not the advanced one
 *
 * A field team is hired in groups, and the list of who started this week
 * already exists somewhere — a WhatsApp message, a spreadsheet column, an
 * email. So the box takes that list in whatever shape it arrives:
 *
 * - several rows, added with **Add another**;
 * - several addresses typed into one row, separated by commas, semicolons,
 *   spaces or newlines;
 * - a paste of any of the above, which is split into rows on arrival so the
 *   superadmin can see and correct what they just dropped in rather than
 *   trusting a single field that has scrolled sideways.
 *
 * All three land in the same place, because the split happens at send time as
 * well as on paste. The paste handler is a courtesy; `expandAddresses` is the
 * rule.
 *
 * ## Sending is not all-or-nothing
 *
 * Each address reports its own outcome. A batch of ten where the fourth is
 * refused sends the other nine, rather than refusing the lot and making
 * somebody find the bad row by hand.
 */

/** Matches the server's cap. Beyond this it stops being a form and needs a preview. */
const MAX_INVITATIONS = 20;

type Row = { email: string; id: string; name: string };

function blankRow(): Row {
  return { email: "", id: crypto.randomUUID(), name: "" };
}

/**
 * Every address in a blob of text, in the order they were written.
 *
 * Commas, semicolons and whitespace all separate, because a list copied out of
 * a mail client uses one, a spreadsheet another and a chat message the third,
 * and asking which one this is would be a worse question than accepting all of
 * them. `Name <a@b.com>` is reduced to the address, which is the shape a
 * copied mail header arrives in.
 */
export function expandAddresses(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((token) => {
      const angled = token.match(/<([^>]+)>/);

      return (angled ? angled[1] : token).trim();
    })
    .filter(Boolean);
}

export function TeamInviteBox({ onSent }: { onSent: () => void }) {
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<TeamInviteResult[] | null>(null);
  const [error, setError] = useState("");

  function updateRow(id: string, patch: Partial<Row>) {
    setRows((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }

  /**
   * Turns a multi-address paste into rows.
   *
   * Only intercepts when the paste actually holds more than one address —
   * pasting a single address into a field must keep behaving like a paste,
   * including replacing whatever was selected.
   */
  function handlePaste(row: Row, text: string) {
    const addresses = expandAddresses(text);

    if (addresses.length < 2) {
      return false;
    }

    setRows((prev) => {
      const index = prev.findIndex((entry) => entry.id === row.id);
      const expanded = addresses.map((email, offset) => ({
        email,
        id: offset === 0 ? row.id : crypto.randomUUID(),
        // The typed name belongs to the row that was pasted into, and to
        // nobody else in the list — it would be a wrong name, not a blank one.
        name: offset === 0 ? row.name : "",
      }));

      return [...prev.slice(0, index), ...expanded, ...prev.slice(index + 1)];
    });

    return true;
  }

  /**
   * Every address currently in the form, deduplicated, with each one's name
   * where the row carried exactly one address.
   */
  function collectInvitations() {
    const seen = new Set<string>();
    const invitations: { email: string; name?: string }[] = [];

    for (const row of rows) {
      const addresses = expandAddresses(row.email);
      const name = row.name.trim();

      for (const email of addresses) {
        const key = email.toLowerCase();

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        invitations.push({
          email,
          // A row that split into several addresses cannot claim one name for
          // all of them, so the name only rides along when it is unambiguous.
          ...(name && addresses.length === 1 ? { name } : {}),
        });
      }
    }

    return invitations;
  }

  async function send() {
    const invitations = collectInvitations();

    if (invitations.length === 0) {
      setError("Add at least one address.");

      return;
    }

    if (invitations.length > MAX_INVITATIONS) {
      setError(
        `That is ${invitations.length} addresses. Send at most ${MAX_INVITATIONS} at a time.`,
      );

      return;
    }

    setSending(true);
    setError("");

    try {
      const result = await browserApi<{ results: TeamInviteResult[] }>(
        "/api/v1/platform/admins/invites",
        {
          body: JSON.stringify({ invitations, role: "PLATFORM_AGENT" }),
          method: "POST",
        },
      );

      setResults(result.results);
      setRows([blankRow()]);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the invitations.");
    } finally {
      setSending(false);
    }
  }

  const pending = collectInvitations().length;

  return (
    <div className="app-card p-5">
      <h2 className="text-sm font-bold text-foreground">Invite team members</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        They accept the emailed link, then sign in with Google on that address at{" "}
        <code className="rounded bg-muted px-1">/team</code>. Paste or type several
        addresses at once — an address already used by a resident, warden, cook or service
        provider is fine, and that account moves onto the team.
      </p>

      <div className="mt-4 space-y-2">
        {rows.map((row, index) => (
          <div className="flex gap-2" key={row.id}>
            <input
              aria-label={`Email ${index + 1}`}
              className="input-field flex-1"
              onChange={(event) => updateRow(row.id, { email: event.target.value })}
              onPaste={(event) => {
                if (handlePaste(row, event.clipboardData.getData("text"))) {
                  event.preventDefault();
                }
              }}
              placeholder="name@example.com, another@example.com"
              type="text"
              value={row.email}
            />
            <input
              aria-label={`Name ${index + 1}`}
              className="input-field w-40"
              onChange={(event) => updateRow(row.id, { name: event.target.value })}
              placeholder="Name (optional)"
              value={row.name}
            />
            {rows.length > 1 ? (
              <button
                aria-label={`Remove row ${index + 1}`}
                className="rounded-lg border border-border p-2.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                onClick={() =>
                  setRows((prev) => prev.filter((entry) => entry.id !== row.id))
                }
                type="button"
              >
                <Trash2 className="size-4" />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-teal hover:underline"
          onClick={() => setRows((prev) => [...prev, blankRow()])}
          type="button"
        >
          <Plus className="size-3.5" /> Add another
        </button>

        {pending > 1 ? (
          <span
            className={cn(
              "text-xs font-medium",
              pending > MAX_INVITATIONS ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {pending} addresses
          </span>
        ) : null}

        <button
          className="ml-auto inline-flex items-center gap-2 rounded-lg bg-brand-teal px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
          disabled={sending}
          onClick={send}
          type="button"
        >
          {sending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {pending > 1 ? `Send ${pending} invitations` : "Send invitation"}
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-xs font-medium text-destructive">{error}</p>
      ) : null}

      {results ? (
        <ul className="mt-3 space-y-1 text-xs">
          {results.map((result, index) => (
            <li
              className={cn(
                "flex items-center justify-between gap-3 rounded-lg px-3 py-2",
                result.sent
                  ? "bg-success/10 text-success"
                  : "bg-destructive/10 text-destructive",
              )}
              // Indexed because the same address can legitimately appear twice
              // in a result set the server built from a list somebody pasted.
              key={`${result.email}-${index}`}
            >
              <span className="font-semibold">{result.email}</span>
              <span className="text-right">
                {result.sent
                  ? result.delivered
                    ? "Invitation sent"
                    : "Created, but the email did not send"
                  : result.error}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
