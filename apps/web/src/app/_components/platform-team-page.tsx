"use client";

import { useCallback, useEffect, useState } from "react";

import { Banknote, Building2, Clock3, UserPlus, Users } from "@/components/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { ShareBar } from "./platform-page-ui";
import { MetricCard, PortalPageHeader, RoleButton } from "./portal-dashboard-ui";
import { EmptyState, Panel } from "./shared-ui";
import { TeamCommissionPanel } from "./platform-team-commission";
import { TeamInviteBox } from "./platform-team-invite-box";
import { TeamMembersTable } from "./platform-team-members-table";
import {
  rupees,
  shortDate,
  type TeamInvite,
  type TeamMember,
  type TeamRegistration,
} from "./platform-team-types";

/**
 * The superadmin's Team tab.
 *
 * Answers the two questions the notes ask of it, in that order: who is on the
 * field team, and — for every hostel any of them registered — how much was paid,
 * by which method, and when.
 *
 * This file is the composition and the money table. The two halves that carry
 * their own state live next door: `platform-team-invite-box.tsx` (which takes a
 * batch, and explains why) and `platform-team-members-table.tsx` (the roster,
 * its row actions, and the invitations nobody has opened yet).
 *
 * ## Cash has its own column, everywhere
 *
 * The same reason as on the agent's own desk: a Fonepay payment went to the
 * platform's merchant account and never touched the agent, so folding it into
 * one "collected" figure would overstate what any individual is answerable for.
 */

type TeamPayload = {
  invites: TeamInvite[];
  members: TeamMember[];
  registrations: TeamRegistration[];
};

export function PlatformTeamPage() {
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [registrations, setRegistrations] = useState<TeamRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);

  // Stable, because it is what the invite box and every row action call to
  // refresh — a new identity each render would reach them as a changed prop.
  const load = useCallback(async () => {
    try {
      const result = await browserApi<TeamPayload>("/api/v1/platform/team");

      setInvites(result.invites);
      setMembers(result.members);
      setRegistrations(result.registrations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = registrations.reduce(
    (sum, row) => ({
      cash: sum.cash + row.cashCollected,
      online: sum.online + row.onlineCollected,
      outstanding: sum.outstanding + row.outstanding,
      price: sum.price + row.price,
    }),
    { cash: 0, online: 0, outstanding: 0, price: 0 },
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        actions={
          <RoleButton onClick={() => setInviting(true)} tone="team" type="button">
            <UserPlus className="size-4" />
            Invite
          </RoleButton>
        }
        description="The field team and every hostel they registered."
        title="Team"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Users} label="Members" value={members.length} />
        <MetricCard icon={Building2} label="Hostels registered" value={registrations.length} />
        {/* Cash and online stay apart: online went to the platform's merchant
            account, never through the agent. */}
        <MetricCard icon={Banknote} label="Cash collected" note={`${rupees(totals.online)} online`} value={rupees(totals.cash)} />
        <MetricCard
          icon={Clock3}
          label="Outstanding"
          tone={totals.outstanding > 0 ? "amber" : "teal"}
          value={rupees(totals.outstanding)}
        />
      </div>

      <TeamMembersTable
        invites={invites}
        loading={loading}
        members={members}
        onChanged={() => void load()}
      />

      <TeamCommissionPanel />

      <Panel title="Registrations">
        {registrations.length > 0 ? (
          <div className="mb-4 max-w-md">
            <ShareBar label="Rs collected" part={totals.cash + totals.online} total={totals.price} />
          </div>
        ) : null}

        {registrations.length === 0 && !loading ? (
          <EmptyState label="No hostels have been registered by the team yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-[13px]">
              <thead>
                <tr className="border-b border-border text-left">
                  {["Hostel", "Registered by", "Plan", "Price", "Cash", "Online", "Outstanding", "When"].map(
                    (heading) => (
                      <th
                        className="px-3 py-2.5 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground"
                        key={heading}
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {registrations.map((row) => (
                  <tr key={row.hostelId}>
                    <td className="px-3 py-3">
                      <p className="text-[13.5px] font-semibold text-foreground">{row.hostelName}</p>
                      <p className="text-[12px] text-muted-foreground">{row.invoiceNumber}</p>
                    </td>
                    <td className="px-3 py-3 text-foreground">{row.agentName}</td>
                    <td className="px-3 py-3 text-muted-foreground">{row.planName}</td>
                    <td className="px-3 py-3 tabular-nums text-foreground">{rupees(row.price)}</td>
                    <td className="px-3 py-3 tabular-nums text-foreground">
                      {row.cashCollected > 0 ? rupees(row.cashCollected) : "—"}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-foreground">
                      {row.onlineCollected > 0 ? rupees(row.onlineCollected) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-3 font-semibold tabular-nums",
                        row.outstanding > 0 ? "text-warning" : "text-muted-foreground",
                      )}
                    >
                      {row.outstanding > 0 ? rupees(row.outstanding) : "—"}
                      {row.outstanding > 0 && row.dueBy ? (
                        <span className="block text-[11px] font-normal">due {shortDate(row.dueBy)}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{shortDate(row.registeredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Dialog onOpenChange={setInviting} open={inviting}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Invite team members</DialogTitle>
            <DialogDescription>
              They accept the emailed link and sign in with Google at /team; an existing account moves onto the team.
            </DialogDescription>
          </DialogHeader>
          <TeamInviteBox onSent={() => void load()} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
