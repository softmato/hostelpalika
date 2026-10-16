"use client";

import {
  Loader2,
  MailX,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Trash2,
  UserMinus,
  Users,
} from "@/components/icons";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";
import { useConfirm } from "./confirm-dialog";
import {
  ROLE_LABELS,
  rupees,
  shortDate,
  type TeamInvite,
  type TeamMember,
} from "./platform-team-types";

/**
 * The roster, and the four things a superadmin can do to a row.
 *
 * ## Suspend, remove, delete — three words that are not synonyms
 *
 * The screen offers all three rather than one "remove", because the superadmin
 * standing in front of it wants a different one on different days and picking
 * wrong is expensive in both directions:
 *
 * - **Suspend** stops the sign-in today and keeps everything attributed. This
 *   is the one for an unfinished reconciliation or somebody on leave.
 * - **Remove from team** ends the platform grant and gives the account back the
 *   role it had before the invitation took it over — the row says which, so
 *   "returns to warden" and "returns to nothing" are visibly different choices.
 * - **Delete account** destroys the row. Offered only where the server said it
 *   is possible: no hostel filed, no payment collected, no earlier account
 *   underneath. Anywhere else it would be a button that answers 409, so it is
 *   simply not there, and the menu says why.
 *
 * Every one of them is confirmed through `useConfirm` rather than fired on
 * click. They all end somebody's access, and two of them do it in a way a
 * mis-click cannot walk back.
 *
 * ## Pending invitations sit under the roster
 *
 * An address that has been invited and not yet accepted is not a member and
 * must not be counted as one — but it is the answer to "did that send go
 * anywhere", which is the next thing anybody asks. It gets its own list, where
 * a typo can be withdrawn rather than waiting a week to expire.
 */

type Props = {
  invites: TeamInvite[];
  loading: boolean;
  members: TeamMember[];
  onChanged: () => void;
};

function statusTone(status: string) {
  if (status === "ACTIVE") {
    return "bg-success/10 text-success";
  }

  if (status === "SUSPENDED") {
    return "bg-destructive/10 text-destructive";
  }

  return "bg-muted text-muted-foreground";
}

function MemberActions({
  member,
  onChanged,
}: {
  member: TeamMember;
  onChanged: () => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const suspended = member.status === "SUSPENDED";
  const returnsTo = member.previousRole
    ? (ROLE_LABELS[member.previousRole] ?? member.previousRole.toLowerCase())
    : "a public account";

  async function run(label: string, request: () => Promise<unknown>, success: string) {
    setBusy(true);

    try {
      await request();
      toast.success(success);
      onChanged();
    } catch (error) {
      toast.error({
        description: error instanceof Error ? error.message : undefined,
        title: `Could not ${label}.`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function suspend() {
    const confirmed = await confirm({
      actionLabel: "Suspend",
      description: `${member.name} will be signed out of every device and will not be able to sign in. The ${member.hostelsRegistered} hostel${member.hostelsRegistered === 1 ? "" : "s"} they registered stay attributed to them. You can lift this at any time.`,
      title: `Suspend ${member.name}?`,
      tone: "destructive",
    });

    if (!confirmed) {
      return;
    }

    await run(
      "suspend this member",
      () =>
        browserApi(`/api/v1/platform/team/members/${member.id}`, {
          body: JSON.stringify({ action: "SUSPEND" }),
          method: "PATCH",
        }),
      `${member.name} is suspended.`,
    );
  }

  async function reinstate() {
    await run(
      "reinstate this member",
      () =>
        browserApi(`/api/v1/platform/team/members/${member.id}`, {
          body: JSON.stringify({ action: "REINSTATE" }),
          method: "PATCH",
        }),
      `${member.name} can sign in again.`,
    );
  }

  async function remove() {
    const confirmed = await confirm({
      actionLabel: "Remove from team",
      description: `${member.name} loses access to the team desk and their account goes back to ${returnsTo}. Everything they registered and collected stays on the books under their name. Sending them a fresh invitation puts them back.`,
      title: `Remove ${member.name} from the team?`,
      tone: "destructive",
    });

    if (!confirmed) {
      return;
    }

    await run(
      "remove this member",
      () =>
        browserApi(`/api/v1/platform/team/members/${member.id}?mode=remove`, {
          method: "DELETE",
        }),
      `${member.name} is off the team.`,
    );
  }

  async function destroy() {
    const confirmed = await confirm({
      actionLabel: "Delete permanently",
      description: `The account for ${member.email} is deleted outright and the address becomes free to invite again. Nothing on the platform points at it — no hostels, no payments — so nothing else changes. This cannot be undone.`,
      title: `Delete ${member.name}?`,
      tone: "destructive",
    });

    if (!confirmed) {
      return;
    }

    await run(
      "delete this account",
      () =>
        browserApi(`/api/v1/platform/team/members/${member.id}?mode=delete`, {
          method: "DELETE",
        }),
      `${member.email} is deleted.`,
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${member.name}`}
          className="rounded-lg border border-border p-1.5 text-muted-foreground transition hover:bg-muted disabled:opacity-50"
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MoreHorizontal className="size-4" />
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-64">
          {suspended ? (
            <DropdownMenuItem onSelect={() => void reinstate()}>
              <PlayCircle className="size-4" /> Reactivate
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void suspend()}>
              <PauseCircle className="size-4" /> Suspend
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => void remove()} variant="destructive">
            <UserMinus className="size-4" /> Remove from team
          </DropdownMenuItem>

          {member.deletable ? (
            <DropdownMenuItem onSelect={() => void destroy()} variant="destructive">
              <Trash2 className="size-4" /> Delete account
            </DropdownMenuItem>
          ) : (
            /*
             * Shown disabled rather than hidden. "Why can I delete that one and
             * not this one" is a real question, and an absent item answers it
             * with silence — the books are the reason, and the reason is short
             * enough to just say.
             */
            <DropdownMenuItem disabled>
              <Trash2 className="size-4" />
              <span className="text-xs">
                Cannot delete —{" "}
                {member.previousRole
                  ? "has an account from before the team"
                  : "hostels or payments point at this account"}
              </span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {confirmDialog}
    </>
  );
}

function PendingInvites({
  invites,
  onChanged,
}: {
  invites: TeamInvite[];
  onChanged: () => void;
}) {
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  async function withdraw(invite: TeamInvite) {
    setWithdrawing(invite.id);

    try {
      await browserApi(`/api/v1/platform/admins/invites/${invite.id}`, {
        method: "DELETE",
      });
      toast.success(`The invitation to ${invite.email} is withdrawn.`);
      onChanged();
    } catch (error) {
      toast.error({
        description: error instanceof Error ? error.message : undefined,
        title: "Could not withdraw that invitation.",
      });
    } finally {
      setWithdrawing(null);
    }
  }

  if (invites.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-border">
      <div className="px-5 py-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Invited, not yet accepted ({invites.length})
        </h3>
      </div>

      <ul className="divide-y divide-border">
        {invites.map((invite) => (
          <li
            className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
            key={invite.id}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-foreground">
                {invite.name || invite.email}
              </p>
              {invite.name ? (
                <p className="truncate text-xs text-muted-foreground">{invite.email}</p>
              ) : null}
            </div>

            <span
              className={cn(
                "text-xs",
                invite.expired ? "font-semibold text-warning" : "text-muted-foreground",
              )}
            >
              {invite.expired
                ? `Expired ${shortDate(invite.expiresAt)}`
                : `Sent ${shortDate(invite.invitedAt)} · expires ${shortDate(invite.expiresAt)}`}
            </span>

            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              disabled={withdrawing === invite.id}
              onClick={() => void withdraw(invite)}
              type="button"
            >
              {withdrawing === invite.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <MailX className="size-3.5" />
              )}
              Withdraw
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TeamMembersTable({ invites, loading, members, onChanged }: Props) {
  return (
    <div className="app-card overflow-hidden">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-bold text-foreground">
          Members{members.length > 0 ? ` (${members.length})` : ""}
        </h2>
      </div>

      {loading ? (
        <div className="space-y-2 p-5">
          {[0, 1].map((row) => (
            <div className="h-9 animate-pulse rounded bg-muted" key={row} />
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="p-8 text-center">
          <Users className="mx-auto size-7 text-muted-foreground/40" />
          <p className="mt-2 text-sm text-muted-foreground">
            Nobody has accepted a team invitation yet.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {["Member", "Hostels", "Cash collected", "Joined", "Status"].map(
                  (heading) => (
                    <th
                      className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      key={heading}
                    >
                      {heading}
                    </th>
                  ),
                )}
                <th className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((member) => (
                <tr key={member.id}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-foreground">{member.name}</p>
                    <p className="text-xs text-muted-foreground">{member.email}</p>
                    {member.previousRole ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Was a{" "}
                        {ROLE_LABELS[member.previousRole] ??
                          member.previousRole.toLowerCase()}{" "}
                        before joining
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-foreground">
                    {member.hostelsRegistered}
                  </td>
                  <td className="px-4 py-3 font-semibold tabular-nums text-foreground">
                    {rupees(member.cashCollected)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {shortDate(member.joinedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold",
                        statusTone(member.status),
                      )}
                    >
                      {member.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <MemberActions member={member} onChanged={onChanged} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PendingInvites invites={invites} onChanged={onChanged} />
    </div>
  );
}
