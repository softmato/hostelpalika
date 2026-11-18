import { useState } from "react";
import { Linking, View } from "react-native";

import { Figures, Quiet, Rows, Section, TintRow } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import { cancelTeamInvite, getTeam, inviteTeamMember, setTeamMemberActive, statusLabel, type TeamMember } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Field team — the agents who sign hostels up (web `platform-team-page`): who is
 * on it, what each brought in, invitations nobody has opened, and every hostel
 * they registered with what is still owed. Cash stays its own figure: a QR
 * payment never touched the agent.
 */
export default function TeamScreen() {
  const dates = useDates();
  const team = useResource(getTeam, { cacheKey: "platform:team" });
  const [open, setOpen] = useState<TeamMember | null>(null);
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const members = team.data?.members ?? [];
  const registrations = team.data?.registrations ?? [];
  const outstanding = registrations.reduce((sum, row) => sum + row.outstanding, 0);
  const cash = members.reduce((sum, row) => sum + row.cashCollected, 0);

  async function invite() {
    setBusy(true);
    try {
      const result = await inviteTeamMember(email, name);
      if (result && !result.sent) throw new Error(result.error ?? "Not sent");
      toastSuccess(`Invitation sent to ${email.trim()}`);
      setName("");
      setEmail("");
      setInviting(false);
      team.refresh();
    } catch (error) {
      toastError("Invitation not sent", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  function toggle(member: TeamMember) {
    const active = member.status === "ACTIVE";
    setOpen(null);
    openConfirm({
      confirmLabel: active ? "Suspend" : "Reinstate",
      destructive: active,
      message: active ? `${member.name} is signed out and cannot register hostels until reinstated.` : `${member.name} can sign in and register hostels again.`,
      onConfirm: async () => {
        try {
          await setTeamMemberActive(member.id, !active);
          toastSuccess(active ? `${member.name} suspended` : `${member.name} reinstated`);
          team.refresh();
        } catch (error) {
          toastError("Not saved", readApiError(error));
        }
      },
      title: active ? `Suspend ${member.name}?` : `Reinstate ${member.name}?`,
    });
  }

  function cancel(id: string, who: string) {
    openConfirm({
      confirmLabel: "Cancel invite",
      destructive: true,
      message: `The link sent to ${who} stops working.`,
      onConfirm: async () => {
        try {
          await cancelTeamInvite(id);
          team.refresh();
        } catch (error) {
          toastError("Not cancelled", readApiError(error));
        }
      },
      title: "Cancel this invitation?",
    });
  }

  return (
    <Screen
      header={<AppBar actions={<Button icon="person-add" label="Invite" onPress={() => setInviting(true)} size="sm" variant="ghost" />} showBack title="Field team" />}
      onRefresh={team.refresh}
      refreshing={team.refreshing}
      scroll
    >
      {team.loading ? (
        <SkeletonRows rows={6} />
      ) : team.error ? (
        <ErrorState message={team.error} onRetry={team.reload} />
      ) : (
        <View className="gap-6 pt-2">
          <Figures
            items={[
              { label: "Agents", value: members.length },
              { label: "Cash held", value: formatMoney(cash) },
              { label: "Still owed", tone: outstanding ? "warning" : undefined, value: formatMoney(outstanding) },
            ]}
          />

          <Section count={members.length} title="Agents">
            {members.length === 0 ? (
              <Quiet icon="person-add" tone="brand">
                No agent yet. Invite one to start.
              </Quiet>
            ) : (
              <Rows>
                {members.map((member) => (
                  <ListRow
                    key={member.id}
                    left={<PersonAvatar image={null} name={member.name} size="sm" />}
                    onPress={() => setOpen(member)}
                    subtitle={`${member.hostelsRegistered} hostels · ${formatMoney(member.cashCollected)} cash${member.status === "ACTIVE" ? "" : ` · ${statusLabel(member.status)}`}`}
                    title={member.name}
                  />
                ))}
              </Rows>
            )}
          </Section>

          {team.data?.invites.length ? (
            <Section count={team.data.invites.length} title="Invited, not joined">
              <Rows>
                {team.data.invites.map((row) => (
                  <TintRow
                    icon="mail"
                    key={row.id}
                    onPress={() => cancel(row.id, row.email)}
                    subtitle={row.expired ? "Link expired" : `Expires ${dates.ago(row.expiresAt)}`}
                    title={row.name || row.email}
                    tone={row.expired ? "danger" : "neutral"}
                  />
                ))}
              </Rows>
            </Section>
          ) : null}

          <Section count={registrations.length} title="Hostels they registered">
            {registrations.length === 0 ? (
              <Quiet tone="neutral">None yet.</Quiet>
            ) : (
              <Rows>
                {registrations.map((row) => (
                  <TintRow
                    icon="hostel"
                    key={`${row.hostelId}:${row.invoiceNumber}`}
                    right={
                      <View className="items-end">
                        <Text className="font-amount text-sm font-bold tabular-nums">{formatMoney(row.paid)}</Text>
                        {row.outstanding > 0 ? <Text className="text-xs text-warning">{`${formatMoney(row.outstanding)} owed`}</Text> : null}
                      </View>
                    }
                    subtitle={[row.agentName, row.planName, row.registeredAt ? dates.date(row.registeredAt) : null].filter(Boolean).join(" · ")}
                    title={row.hostelName}
                    tone={row.outstanding > 0 ? "warning" : "success"}
                  />
                ))}
              </Rows>
            )}
          </Section>
        </View>
      )}

      <Sheet onClose={() => setOpen(null)} open={open !== null} title={open?.name ?? ""}>
        {open ? (
          <View className="gap-4 pb-2">
            <View>
              <FactRow label="Email" value={open.email} />
              <FactRow label="Phone" value={open.phone || "—"} />
              <FactRow label="Hostels" value={String(open.hostelsRegistered)} />
              <FactRow label="Cash collected" value={formatMoney(open.cashCollected)} />
              <FactRow label="Joined" value={open.joinedAt ? dates.date(open.joinedAt) : "—"} />
              <FactRow label="Last sign-in" value={open.lastLoginAt ? dates.ago(open.lastLoginAt) : "Never"} />
            </View>
            <View className="flex-row gap-3">
              {open.phone ? (
                <View className="flex-1">
                  <Button icon="call" label="Call" onPress={() => void Linking.openURL(`tel:${open.phone}`)} variant="outline" />
                </View>
              ) : null}
              <View className="flex-1">
                <Button icon="mail" label="Email" onPress={() => void Linking.openURL(`mailto:${open.email}`)} variant="outline" />
              </View>
            </View>
            <Button
              icon={open.status === "ACTIVE" ? "ban" : "lock-open"}
              label={open.status === "ACTIVE" ? "Suspend" : "Reinstate"}
              onPress={() => toggle(open)}
              variant={open.status === "ACTIVE" ? "danger" : "primary"}
            />
          </View>
        ) : null}
      </Sheet>

      <Sheet onClose={() => setInviting(false)} open={inviting} title="Invite an agent">
        <View className="gap-4 pb-2">
          <Input autoCapitalize="words" label="Name" onChangeText={setName} value={name} />
          <Input autoCapitalize="none" keyboardType="email-address" label="Email" onChangeText={setEmail} value={email} />
          <Text variant="caption">They get a link by email and choose their own password.</Text>
          <Button disabled={!/^\S+@\S+\.\S+$/.test(email.trim())} label="Send invitation" loading={busy} onPress={() => void invite()} />
        </View>
      </Sheet>
    </Screen>
  );
}
