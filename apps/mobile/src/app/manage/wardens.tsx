import { useCallback, useMemo, useState } from "react";
import { Linking, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Avatar } from "@/components/ui/avatar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  createWarden,
  DEFAULT_WARDEN_PERMISSIONS,
  type ManagedWarden,
  removeWarden,
  updateWarden,
  PROOF_WAIVER,
  WARDEN_PERMISSIONS,
  type WardenPermission,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Wardens — who else runs the hostel, and exactly what each may do.
 *
 * ## Owner-only, by role rather than by grant
 *
 * Every route here is `requireHostelAdminPrincipal`. A warden cannot be given
 * the power to create wardens, which is the one permission that would otherwise
 * let a grant escalate into ownership.
 *
 * ## Permissions are the whole point of the screen
 *
 * The sixteen flags are what make the difference between a night warden and a
 * bookkeeper, and three of them — reversing a payment, editing the fee schedule,
 * changing where money is paid — used to be one flag called `verifyPayments`. A
 * new warden could rewrite any payment amount on the day they were created. They
 * are separate now and off by default, and this screen groups them so that stays
 * obvious rather than being sixteen identical switches.
 *
 * ## `verifyPayments` may still arrive
 *
 * It is retired but still stored on rows the migration has not reached, and the
 * server accepts it on input for one release. So an unknown key is **kept** and
 * sent back rather than dropped: an edit form that quietly discards it would
 * strip a live warden's payment access the first time somebody changed their
 * name.
 */

const PERMISSION_LABELS: Record<WardenPermission, { hint: string; label: string }> = {
  approvePayments: {
    hint: "Accept or reject a resident's payment proof.",
    label: "Approve payments",
  },
  editHostelProfile: {
    hint: "Change the public listing, its photos and its address.",
    label: "Edit the hostel",
  },
  manageFeeSchedule: {
    hint: "Change what residents are billed. Off by default.",
    label: "Fee schedules",
  },
  manageFood: { hint: "Edit the weekly menu and the cook portal.", label: "Food" },
  manageMaintenance: { hint: "Raise and close repair requests.", label: "Maintenance" },
  manageNotices: { hint: "Publish and expire notices.", label: "Notices" },
  managePaymentProfile: {
    hint: "Change where money is paid. Off by default.",
    label: "Payment setup",
  },
  manageRooms: { hint: "Change room types, beds and vacancies.", label: "Rooms" },
  manageStock: {
    hint: "Add what was bought, send to a branch, tap Got it, count what is left.",
    label: "Stock",
  },
  recordCash: { hint: "Mark an invoice settled in cash.", label: "Record cash" },
  recordExpenses: {
    hint: "Add money they spend for the hostel. They never see the hostel's totals.",
    label: "Add expenses",
  },
  registerResidents: { hint: "Admit and move out residents.", label: "Residents" },
  reversePayments: {
    hint: "Undo a settled payment. Off by default.",
    label: "Reverse payments",
  },
  updateComplaints: { hint: "Reply to and resolve complaints.", label: "Answer complaints" },
  updateNightStatus: { hint: "Override a resident's night status.", label: "Set night status" },
  viewComplaints: { hint: "Read the complaints queue.", label: "See complaints" },
  viewNightStatus: { hint: "See who is accounted for tonight.", label: "See roll call" },
  viewPayments: { hint: "Read invoices and the ledger.", label: "See payments" },
};

/**
 * Offered on its own row with a *Recommended* mark, pre-ticked, rather than as
 * one more chip: the warden who does the shopping is the usual case, and an
 * owner skimming the chips should not have to find it
 * (docs/EXPENSES_PLAN.md §1).
 */
const RECOMMENDED: WardenPermission = "recordExpenses";

/** The three that change what is owed or who gets paid. */
const SENSITIVE: WardenPermission[] = [
  "reversePayments",
  "manageFeeSchedule",
  "managePaymentProfile",
];

type Draft = { email: string; name: string; permissions: string[]; phone: string };

const BLANK_DRAFT: Draft = {
  email: "",
  name: "",
  permissions: [...DEFAULT_WARDEN_PERMISSIONS],
  phone: "",
};

export default function ManageWardensScreen() {
  const dates = useDates();
  const query = adminQuery.wardens();
  const wardens = useResource<ManagedWarden[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [inviting, setInviting] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [editing, setEditing] = useState<ManagedWarden | null>(null);
  /** The warden whose actions sheet is open. */
  const [acting, setActing] = useState<ManagedWarden | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => wardens.data ?? [], [wardens.data]);
  const { refresh } = wardens;

  const invite = useCallback(async () => {
    const email = draft.email.trim();
    const name = draft.name.trim();

    if (name.length < 1) {
      toastError("Name them", "The person's name, as they would sign it.");
      return;
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      toastError("Check the email", "The invitation and their login both go there.");
      return;
    }

    setBusy(true);

    try {
      await createWarden({
        email,
        name,
        permissions: draft.permissions as WardenPermission[],
        phone: draft.phone.trim() || undefined,
      });
      toastSuccess("Warden invited", "Their sign-in details have been emailed.");
      setInviting(false);
      setDraft(BLANK_DRAFT);
      await refresh();
    } catch (error) {
      toastError("Could not invite", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [draft, refresh]);

  const savePermissions = useCallback(async () => {
    if (!editing) {
      return;
    }

    setBusy(true);

    try {
      await updateWarden(editing.id, { permissions });
      toastSuccess("Permissions saved");
      setEditing(null);
      await refresh();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [editing, permissions, refresh]);

  const setStatus = useCallback(
    async (warden: ManagedWarden, status: "ACTIVE" | "SUSPENDED") => {
      setBusy(true);

      try {
        await updateWarden(warden.id, { status });
        toastSuccess(status === "ACTIVE" ? "Reactivated" : "Suspended");
        setActing(null);
        await refresh();
      } catch (error) {
        toastError("Could not change that", readApiError(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    (warden: ManagedWarden) => {
      setActing(null);
      openConfirm({
        confirmLabel: "Remove",
        destructive: true,
        message: "They lose access to this hostel. They can be invited back later.",
        onConfirm: async () => {
          try {
            await removeWarden(warden.id);
            toastSuccess("Removed");
            await refresh();
          } catch (error) {
            toastError("Could not remove", readApiError(error));
          }
        },
        title: `Remove ${warden.name}?`,
      });
    },
    [refresh],
  );

  const openPermissions = useCallback((warden: ManagedWarden) => {
    setActing(null);
    setEditing(warden);
    // The stored array verbatim, including any retired key. Sending back a
    // filtered copy is how a migration-pending warden loses payment access.
    setPermissions([...warden.permissions]);
  }, []);

  const toggle = useCallback((key: string, on: boolean) => {
    setPermissions((prev) =>
      on ? [...new Set([...prev, key])] : prev.filter((entry) => entry !== key),
    );
  }, []);

  if (wardens.loading) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Wardens" />}>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (wardens.error) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Wardens" />}>
        <ErrorState message={wardens.error} onRetry={wardens.reload} />
      </Screen>
    );
  }

  const retired = permissions.filter(
    (key) => key !== PROOF_WAIVER && !(WARDEN_PERMISSIONS as readonly string[]).includes(key),
  );

  return (
    <Screen
      floating={
        <FloatingButton
          icon="person-add-outline"
          label="Invite a warden"
          onPress={() => {
            setDraft(BLANK_DRAFT);
            setInviting(true);
          }}
        />
      }
      header={<AppBar accent centerTitle showBack title="Wardens" />}
      onRefresh={wardens.refresh}
      refreshing={wardens.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        {rows.length === 0 ? (
          <EmptyCard
            description="Each warden gets their own login."
            title="No wardens yet"
          />
        ) : null}

        {rows.length > 0 ? (
          <Card padding="px-4 py-1">
            {rows.map((warden, index) => (
              <View key={warden.id}>
                {index > 0 ? <RowDivider inset /> : null}
                <ListRow
                  left={<Avatar name={warden.name} size="sm" />}
                  onPress={() => setActing(warden)}
                  right={<StatusPill status={warden.status} />}
                  subtitle={`${countKnown(warden.permissions)} of ${WARDEN_PERMISSIONS.length} permissions${
                    warden.permissions.some((key) => (SENSITIVE as string[]).includes(key))
                      ? " · money"
                      : ""
                  }`}
                  title={warden.name}
                />
              </View>
            ))}
          </Card>
        ) : null}
      </View>

      {/* ------------------------------------------------------------------ */}
      <Sheet onClose={() => setActing(null)} open={acting !== null} title={acting?.name ?? ""}>
        {acting ? (
          <View className="gap-4 pb-2">
            <View className="flex-row items-center gap-3">
              <Avatar name={acting.name} size="md" />
              <View className="flex-1">
                <Text numberOfLines={1} variant="caption">
                  {acting.email}
                </Text>
                {acting.status === "INVITED" ? (
                  <Text variant="caption">{`Invited ${dates.date(acting.createdAt)} · not signed in yet`}</Text>
                ) : null}
              </View>
              <StatusPill status={acting.status} />
            </View>

            <Meter
              label={`${countKnown(acting.permissions)} of ${WARDEN_PERMISSIONS.length} permissions`}
              percent={Math.round((countKnown(acting.permissions) / WARDEN_PERMISSIONS.length) * 100)}
            />

            {acting.phone ? (
              <Button
                label={`Call ${acting.phone}`}
                onPress={() => void Linking.openURL(`tel:${acting.phone}`)}
                variant="outline"
              />
            ) : null}

            <Card padding="px-4 py-1">
              <ListRow
                icon="key-outline"
                iconBgColor="#007AFF"
                onPress={() => openPermissions(acting)}
                title="Permissions"
              />
              <RowDivider inset />
              <ListRow
                busy={busy}
                icon={acting.status === "SUSPENDED" ? "play-outline" : "pause-outline"}
                iconBgColor="#FF9500"
                onPress={() =>
                  void setStatus(acting, acting.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED")
                }
                title={acting.status === "SUSPENDED" ? "Reactivate" : "Suspend"}
              />
              <RowDivider inset />
              <ListRow
                icon="trash-outline"
                iconBgColor="#FF3B30"
                onPress={() => remove(acting)}
                title="Remove"
              />
            </Card>
          </View>
        ) : null}
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={<Button label="Send the invite" loading={busy} onPress={() => void invite()} />}
        onClose={() => setInviting(false)}
        open={inviting}
        title="Invite a warden"
      >
        <View className="gap-3 pb-2">
          <Input
            autoCapitalize="words"
            label="Name"
            onChangeText={(name) => setDraft((prev) => ({ ...prev, name }))}
            value={draft.name}
          />
          <Input
            autoCapitalize="none"
            hint="Their login and the invite go here."
            keyboardType="email-address"
            label="Email"
            onChangeText={(email) => setDraft((prev) => ({ ...prev, email }))}
            value={draft.email}
          />
          <Input
            keyboardType="phone-pad"
            label="Phone"
            onChangeText={(phone) => setDraft((prev) => ({ ...prev, phone }))}
            value={draft.phone}
          />

          <View className="flex-row items-center justify-between gap-3 rounded-xl border border-brand/30 bg-brand-soft p-3">
            <View className="flex-1 gap-1">
              <View className="flex-row items-center gap-2">
                <Text variant="label">{PERMISSION_LABELS[RECOMMENDED].label}</Text>
                <Badge label="Recommended" tone="success" />
              </View>
              <Text variant="caption">Turn on if this warden buys things for the hostel.</Text>
            </View>
            <Toggle
              accessibilityLabel={PERMISSION_LABELS[RECOMMENDED].label}
              onChange={(on) =>
                setDraft((prev) => ({
                  ...prev,
                  permissions: on
                    ? [...prev.permissions.filter((entry) => entry !== RECOMMENDED), RECOMMENDED]
                    : prev.permissions.filter((entry) => entry !== RECOMMENDED),
                }))
              }
              value={draft.permissions.includes(RECOMMENDED)}
            />
          </View>

          <ProofRule
            onChange={(waived) =>
              setDraft((prev) => ({
                ...prev,
                permissions: waived
                  ? [...prev.permissions.filter((entry) => entry !== PROOF_WAIVER), PROOF_WAIVER]
                  : prev.permissions.filter((entry) => entry !== PROOF_WAIVER),
              }))
            }
            waived={draft.permissions.includes(PROOF_WAIVER)}
          />

          <Text variant="label">What they may do</Text>

          <View className="flex-row flex-wrap gap-2">
            {WARDEN_PERMISSIONS.filter((key) => key !== RECOMMENDED).map((key) => (
              <Chip
                key={key}
                label={PERMISSION_LABELS[key].label}
                onPress={() =>
                  setDraft((prev) => ({
                    ...prev,
                    permissions: prev.permissions.includes(key)
                      ? prev.permissions.filter((entry) => entry !== key)
                      : [...prev.permissions, key],
                  }))
                }
                tone={draft.permissions.includes(key) ? "brand" : "neutral"}
              />
            ))}
          </View>
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={<Button label="Save" loading={busy} onPress={() => void savePermissions()} />}
        onClose={() => setEditing(null)}
        open={editing !== null}
        title={editing ? editing.name : ""}
      >
        <View className="gap-3 pb-2">
          {retired.length > 0 ? (
            <View className="gap-1 rounded-xl border border-warning/40 bg-warning-soft p-3">
              <Text variant="label">Older permission still on this account</Text>
              <Text variant="caption">
                {`${retired.join(", ")} — retired, and kept exactly as it is. Saving does not strip it.`}
              </Text>
            </View>
          ) : null}

          {WARDEN_PERMISSIONS.map((key) => (
            <View
              className="flex-row items-center justify-between gap-3 border-b border-border pb-3"
              key={key}
            >
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text variant="label">{PERMISSION_LABELS[key].label}</Text>
                  {SENSITIVE.includes(key) ? <Badge label="Money" tone="warning" /> : null}
                  {key === RECOMMENDED ? <Badge label="Recommended" tone="success" /> : null}
                </View>
                <Text variant="caption">{PERMISSION_LABELS[key].hint}</Text>
              </View>
              <Toggle
                accessibilityLabel={PERMISSION_LABELS[key].label}
                onChange={(on) => toggle(key, on)}
                value={permissions.includes(key)}
              />
            </View>
          ))}

          <ProofRule
            onChange={(waived) => toggle(PROOF_WAIVER, waived)}
            waived={permissions.includes(PROOF_WAIVER)}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

/**
 * "Bill photo needed" — on by default for every warden, new or existing. Stored
 * as the waiver {@link PROOF_WAIVER}, so the switch is that key's opposite.
 */
function ProofRule({ onChange, waived }: { onChange: (waived: boolean) => void; waived: boolean }) {
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
      <View className="flex-1 gap-1">
        <Text variant="label">Bill photo needed</Text>
        <Text variant="caption">Every expense they add must have a photo.</Text>
      </View>
      <Toggle accessibilityLabel="Bill photo needed" onChange={(on) => onChange(!on)} value={!waived} />
    </View>
  );
}

/** Current permissions only — a retired key still stored is not one of them. */
function countKnown(permissions: string[]) {
  return permissions.filter((key) => (WARDEN_PERMISSIONS as readonly string[]).includes(key))
    .length;
}
