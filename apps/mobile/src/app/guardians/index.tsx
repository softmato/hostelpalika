import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Linking, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import {
  describeInvitation,
  GUARDIAN_PERMISSIONS,
  type GuardianLink,
  type GuardianPermissions,
  grantedLabels,
} from "@/lib/guardian-access";
import { revokeGuardian, updateGuardianPermissions } from "@/lib/guardian-access-api";
import { residentQuery } from "@/lib/resident-queries";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Who can see your record, and exactly how much of it.
 *
 * ## The resident owns this, not the hostel
 *
 * `inviteGuardian`'s own comment says so — "the resident, not an admin, owns
 * this link and the permissions attached to it" — and until this screen existed
 * the app disagreed with the server about that. `profile.tsx` listed guardians
 * as static rows under a footnote saying the hostel invites them, which was
 * wrong about who is in charge as well as being a dead end: `POST`, `PATCH` and
 * `DELETE /resident/guardians` have been live the whole time and nothing on the
 * phone called any of them.
 *
 * ## A guardian is drawn by what they can see, not by their status
 *
 * The status enum has four values and this list only ever contains two of them
 * (`listResidentGuardians` filters to `ACTIVE` and `USED`), so a status pill on
 * every row would carry almost no information. What a resident actually wants to
 * know is *what does my father see*, so the grants are the subtitle and the row
 * expands into the six switches.
 *
 * ## Revoking is the destructive one, and it is not undoable
 *
 * `revokeGuardianAccess` clears the invitation token as well as the status, so
 * re-inviting mints a new access and a new code — the old emailed link is dead
 * either way. The confirm names the action rather than saying OK, per
 * `docs/DESIGN.md` §2, and it names the person.
 */
export default function GuardiansScreen() {
  /*
    Through the registry, so the list is cached under its own key and a resident
    who opens a guardian, edits a switch and comes back paints instead of
    reloading. `residents` is the topic because a guardian accepting their
    invitation goes through `registerOrUpgradeUserByEmail` — a change to this
    resident's people that they did not make themselves.
  */
  const query = residentQuery.guardians();
  const guardians = useResource<GuardianLink[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [editing, setEditing] = useState<GuardianLink | null>(null);

  const header = <AppBar showBack title="Guardians" />;

  if (guardians.loading) {
    return (
      <Screen header={header}>
        <SkeletonRows rows={3} />
      </Screen>
    );
  }

  if (guardians.error || !guardians.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={guardians.error ?? "Your guardians could not be loaded."}
          onRetry={guardians.reload}
        />
      </Screen>
    );
  }

  const rows = guardians.data;

  return (
    <Screen
      header={header}
      onRefresh={guardians.refresh}
      refreshing={guardians.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {rows.length === 0 ? (
          <EmptyState
            action={
              <Button
                label="Invite a guardian"
                onPress={() => router.push("/guardians/new")}
              />
            }
            description="Invite a parent or guardian and they get their own sign-in, showing only what you choose to share."
            title="Nobody is linked yet"
          />
        ) : (
          <>
            <View>
              <SectionHeader
                subtitle={rows.length === 1 ? "1 person" : `${rows.length} people`}
                title="Linked to your account"
              />
              <Card>
                {rows.map((link, index) => (
                  <View key={link.accessId}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <GuardianRow link={link} onPress={() => setEditing(link)} />
                  </View>
                ))}
              </Card>
            </View>

            <Button
              label="Invite another guardian"
              onPress={() => router.push("/guardians/new")}
              variant="outline"
            />
          </>
        )}
      </View>

      <PermissionSheet
        link={editing}
        onClose={() => setEditing(null)}
        onChanged={(accessId, permissions) =>
          guardians.setData(
            (current) =>
              current?.map((row) =>
                row.accessId === accessId ? { ...row, permissions } : row,
              ) ?? current,
          )
        }
        onRevoked={() => {
          setEditing(null);
          void guardians.refresh();
        }}
      />
    </Screen>
  );
}

function GuardianRow({ link, onPress }: { link: GuardianLink; onPress: () => void }) {
  const pending = describeInvitation(link);
  const granted = grantedLabels(link.permissions);

  return (
    <ListRow
      icon="shield-outline"
      onPress={onPress}
      right={
        pending ? (
          <Badge label="Pending" tone="warning" />
        ) : granted.length === 0 ? (
          <Badge label="Nothing shared" tone="neutral" />
        ) : undefined
      }
      /*
        The pending line wins the subtitle when there is one: "expires in 2 days"
        is something to act on, and what they can see is moot until they are in.
      */
      subtitle={pending ?? describeGrants(granted)}
      title={`${link.name} · ${link.relation}`}
    />
  );
}

/** Full list up to three, then the count — a row has one line to spend. */
function describeGrants(granted: string[]) {
  if (granted.length === 0) {
    return "Nothing shared yet";
  }

  if (granted.length <= 2) {
    return granted.join(" · ");
  }

  return `${granted[0]} and ${granted.length - 1} more`;
}

/**
 * The six switches, in a sheet.
 *
 * A sheet rather than a pushed screen because it is one object's settings and
 * the resident is comparing it against the row underneath — NOTES: "row overflow
 * opens a bottom sheet". It is also where Revoke lives, which is the only
 * destructive control in this feature and should not be one tap from a list.
 *
 * ## Each switch is its own request
 *
 * `guardianPermissionsUpdateSchema` is `.partial()`, so one flag can be sent
 * alone — which matters here because this sheet may sit open while the same
 * resident changes something from the web. Sending all six would write back five
 * values this screen read minutes ago.
 *
 * The flip is optimistic and reverts on failure. The server returns its own full
 * set afterwards, and that is what the row settles on.
 */
function PermissionSheet({
  link,
  onChanged,
  onClose,
  onRevoked,
}: {
  link: GuardianLink | null;
  /** The server's settled permissions, for the row this sheet is editing. */
  onChanged: (accessId: string, permissions: GuardianPermissions) => void;
  onClose: () => void;
  onRevoked: () => void;
}) {
  /*
   * The draft is **keyed by `accessId`**, not a bare permission object.
   *
   * This component is not remounted per guardian — the same sheet is reused for
   * whoever the list last tapped — so an unkeyed draft would survive the close
   * and paint the previous guardian's switches onto the next one. Which is the
   * single worst bug this screen could have: it would show a resident that their
   * uncle can see the rent when it is their mother who can.
   */
  const [draft, setDraft] = useState<{
    accessId: string;
    permissions: GuardianPermissions;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const permissions =
    link && draft?.accessId === link.accessId ? draft.permissions : link?.permissions;

  const setFlag = useCallback(
    async (key: keyof GuardianPermissions, next: boolean) => {
      if (!link || !permissions) {
        return;
      }

      const accessId = link.accessId;

      setDraft({ accessId, permissions: { ...permissions, [key]: next } });
      setBusy(key);

      try {
        const stored = await updateGuardianPermissions(accessId, { [key]: next });

        // Settle on the server's answer, not ours — and hand the list the same
        // answer, so the row behind this sheet moves without re-reading it.
        setDraft({ accessId, permissions: stored });
        onChanged(accessId, stored);
      } catch (caught) {
        setDraft({ accessId, permissions });
        toastError("That did not save", readApiError(caught));
      } finally {
        setBusy(null);
      }
    },
    [link, onChanged, permissions],
  );

  const revoke = useCallback(() => {
    if (!link) {
      return;
    }

    openConfirm({
      confirmLabel: "Revoke access",
      destructive: true,
      message:
        "They lose their sign-in immediately, and the link in their invitation email stops working. Inviting them again sends a new one.",
      onConfirm: async () => {
        try {
          await revokeGuardian(link.accessId);
          toastSuccess(`${link.name} no longer has access.`);
          onRevoked();
        } catch (caught) {
          toastError("Could not revoke that", readApiError(caught));
        }
      },
      title: `Revoke ${link.name}'s access?`,
    });
  }, [link, onRevoked]);

  const pending = link ? describeInvitation(link) : null;

  return (
    <Sheet
      onClose={() => {
        setDraft(null);
        onClose();
      }}
      open={Boolean(link)}
      title={link ? `${link.name} · ${link.relation}` : "Guardian"}
    >
      {link && permissions ? (
        <View className="gap-4">
          <View className="flex-row flex-wrap gap-2">
            {link.phone ? (
              <Chip
                icon="call-outline"
                label={link.phone}
                onPress={() => void Linking.openURL(`tel:${link.phone}`)}
                tone="brand"
              />
            ) : null}
            {link.email ? <Chip icon="mail-outline" label={link.email} /> : null}
          </View>

          {pending ? (
            <Card className="gap-1">
              <Text variant="label">{pending}</Text>
              <Text variant="muted">
                They cannot see anything until they open the link in their email.
                What you set here is waiting for them when they do.
              </Text>
            </Card>
          ) : null}

          <View className="gap-1">
            <Text variant="label">What they can see</Text>
            <Text variant="caption">
              Each line is separate. Nothing else is shared.
            </Text>
          </View>

          <Card>
            {GUARDIAN_PERMISSIONS.map((field, index) => (
              <View key={field.key}>
                {index > 0 ? <RowDivider /> : null}
                <ListRow
                  right={
                    <Toggle
                      accessibilityLabel={field.label}
                      disabled={busy === field.key}
                      onChange={(next) => void setFlag(field.key, next)}
                      value={permissions[field.key]}
                    />
                  }
                  title={field.label}
                />
              </View>
            ))}
          </Card>

          <Button label="Revoke access" onPress={revoke} variant="danger" />
        </View>
      ) : null}
    </Sheet>
  );
}
