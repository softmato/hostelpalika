"use client";

import { useCallback, useEffect, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { PortalPageHeader } from "./portal-dashboard-ui";
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

  return (
    <div className="space-y-6">
      <PortalPageHeader
        description="The field team and every hostel they registered."
        title="Team"
      />

      <TeamInviteBox onSent={() => void load()} />

      <TeamMembersTable
        invites={invites}
        loading={loading}
        members={members}
        onChanged={() => void load()}
      />

      <TeamCommissionPanel />

      <div className="app-card overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-bold text-foreground">Registrations by the team</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Who registered what, what it cost, what was collected and how.
          </p>
        </div>

        {registrations.length === 0 && !loading ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No hostels have been registered by the team yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  {[
                    "Hostel",
                    "Registered by",
                    "Plan",
                    "Price",
                    "Cash",
                    "Online",
                    "Outstanding",
                    "When",
                  ].map((heading) => (
                    <th
                      className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      key={heading}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {registrations.map((row) => (
                  <tr key={row.hostelId}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-foreground">{row.hostelName}</p>
                      <p className="text-xs text-muted-foreground">{row.invoiceNumber}</p>
                    </td>
                    <td className="px-4 py-3 text-foreground">{row.agentName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.planName}</td>
                    <td className="px-4 py-3 tabular-nums text-foreground">
                      {rupees(row.price)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-foreground">
                      {row.cashCollected > 0 ? rupees(row.cashCollected) : "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-foreground">
                      {row.onlineCollected > 0 ? rupees(row.onlineCollected) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 font-semibold tabular-nums",
                        row.outstanding > 0 ? "text-warning" : "text-muted-foreground",
                      )}
                    >
                      {row.outstanding > 0 ? rupees(row.outstanding) : "—"}
                      {row.outstanding > 0 && row.dueBy ? (
                        <span className="block text-[11px] font-normal">
                          due {shortDate(row.dueBy)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {shortDate(row.registeredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
