import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  addCook,
  type CookAccount,
  type CookCredentials,
  removeCook,
  updateCook,
} from "@/lib/admin-manage-api";
import { adminQuery, type CookRoster } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Cooks — who is allowed to tell the hostel that food is ready.
 *
 * ## Why this is a screen and not a card at the bottom of Food
 *
 * It was that card. It fitted while a hostel had exactly one cook and the only
 * decisions were a name and a switch. It stopped fitting the moment there were
 * two kinds of cook, a list of them, a rotate, a remove and a history of people
 * who used to be here — that is a screen's worth of decisions, and burying it
 * under the week's menu meant scrolling past twenty-eight meal cells to reach
 * the thing you opened Food for. `manage/food.tsx` now carries a single row
 * pointing here, and this screen owns the job.
 *
 * ## Two ways to give somebody the kitchen
 *
 * - **Create a sign-in.** We mint a short address and a password and show them
 *   once. Nothing is emailed to the cook because there is no mailbox — the
 *   admin reads the two lines out. This is the kitchen-shares-one-phone case.
 * - **Invite by email.** The cook's own address gets a link; opening it turns
 *   their account into the cook account. Exactly what a resident does for a
 *   guardian.
 *
 * The picker defaults to *Create a sign-in*, because most cooks do not have an
 * email they check, and the invite path is one tap away for the ones who do.
 *
 * ## The password is shown once and then it is gone
 *
 * Not a UI choice — only a bcrypt hash is stored, so there is no second read
 * for any screen to make. That is why the credentials sheet has a copy button
 * and stays up until it is dismissed deliberately, and why the answer to "we
 * lost it" is Rotate rather than a reveal.
 *
 * ## Removed cooks stay on the screen
 *
 * Below a divider, greyed, showing the name their past announcements and photos
 * are now filed under. They are not clutter: they are the reason a meal logged
 * two months ago still has somebody's name against it, and the only place an
 * admin can see that the label reads "Previous Sunrise cook".
 */

type Mode = "CREDENTIAL" | "INVITE";

const MODES: { label: string; value: Mode }[] = [
  { label: "Create a sign-in", value: "CREDENTIAL" },
  { label: "Invite by email", value: "INVITE" },
];

/** What the credentials sheet is showing, and which cook it belongs to. */
type Issued = { cookName: string; credentials: CookCredentials; rotated: boolean };

export default function ManageCookScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  const query = adminQuery.cooks();
  const roster = useResource<CookRoster>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<Mode>("CREDENTIAL");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [editing, setEditing] = useState<CookAccount | null>(null);
  const [editedName, setEditedName] = useState("");
  /** The cook whose actions sheet is open. */
  const [acting, setActing] = useState<CookAccount | null>(null);

  const cooks = useMemo(() => roster.data?.cooks ?? [], [roster.data]);
  const live = cooks.filter((cook) => cook.status !== "REMOVED");
  const past = cooks.filter((cook) => cook.status === "REMOVED");
  const { refresh, setData } = roster;

  const openAdd = useCallback(() => {
    setMode("CREDENTIAL");
    setName("");
    setEmail("");
    setAdding(true);
  }, []);

  const submit = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (trimmedName.length < 2) {
      toastError("Name them", "What residents will see beside the food.");
      return;
    }

    if (mode === "INVITE" && !/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      toastError("Check the email", "The invitation goes to this address.");
      return;
    }

    setBusy(true);

    try {
      const result = await addCook(
        mode === "CREDENTIAL"
          ? { kind: "CREDENTIAL", name: trimmedName }
          : { email: trimmedEmail, kind: "INVITE", name: trimmedName },
      );

      setAdding(false);

      if (result.credentials) {
        // Straight into the sheet. This response is the only place the password
        // will ever exist — a toast that disappears in four seconds is not
        // where you put something that cannot be fetched again.
        setIssued({
          cookName: trimmedName,
          credentials: result.credentials,
          rotated: false,
        });
      } else {
        toastSuccess("Invitation sent", `${trimmedEmail} has seven days to accept.`);
      }

      await refresh();
    } catch (error) {
      toastError("Could not add that cook", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [email, mode, name, refresh]);

  const rotate = useCallback(
    (cook: CookAccount) => {
      setActing(null);
      openConfirm({
        confirmLabel: "Issue a new one",
        message: "The current password stops working and they are signed out everywhere.",
        onConfirm: async () => {
          try {
            const result = await updateCook(cook.id, { rotate: true });

            if (result.credentials) {
              setIssued({ cookName: cook.name, credentials: result.credentials, rotated: true });
            }

            setData((current) =>
              current
                ? {
                    ...current,
                    cooks: current.cooks.map((row) => (row.id === result.cook.id ? result.cook : row)),
                  }
                : current,
            );
          } catch (error) {
            toastError("Could not rotate", readApiError(error));
          }
        },
        title: `New password for ${cook.name}?`,
      });
    },
    [setData],
  );

  const rename = useCallback(async () => {
    if (!editing) {
      return;
    }

    setBusy(true);

    try {
      // The renamed cook comes back from the PATCH, so the row changes under
      // the sheet as it closes rather than a refresh later.
      const { cook } = await updateCook(editing.id, { name: editedName.trim() });

      setData((current) =>
        current
          ? {
              ...current,
              cooks: current.cooks.map((row) => (row.id === cook.id ? cook : row)),
            }
          : current,
      );
      toastSuccess("Name saved");
      setEditing(null);
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [editedName, editing, setData]);

  const remove = useCallback(
    (cook: CookAccount) => {
      setActing(null);
      openConfirm({
        confirmLabel: "Remove",
        destructive: true,
        message: "Their past meals and photos stay, under “previous cook”.",
        onConfirm: async () => {
          try {
            const removed = await removeCook(cook.id);

            toastSuccess(
              "Removed",
              removed.historicalName ? `Past work now reads “${removed.historicalName}”.` : undefined,
            );
            await refresh();
          } catch (error) {
            toastError("Could not remove", readApiError(error));
          }
        },
        title: `Remove ${cook.name}?`,
      });
    },
    [refresh],
  );

  const copy = useCallback(async (value: string, what: string) => {
    await Clipboard.setStringAsync(value);
    toastSuccess(`${what} copied`);
  }, []);

  if (roster.loading) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Cooks" />} scroll>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (roster.error) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Cooks" />}>
        <ErrorState message={roster.error} onRetry={roster.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      floating={
        <FloatingButton icon="person-add-outline" label="Add a cook" onPress={openAdd} />
      }
      header={<AppBar accent centerTitle showBack title="Cooks" />}
      onRefresh={roster.refresh}
      refreshing={roster.refreshing}
      scroll
    >
      <View className="gap-6 pt-1">
        <View>
          <SectionHeader title="In the kitchen" />

          {live.length === 0 ? (
            <EmptyCard
              description="They can announce meals and post food photos."
              title="Nobody has the kitchen"
            />
          ) : (
            <Card padding="px-4 py-1">
              {live.map((cook, index) => (
                <View key={cook.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    left={<Avatar name={cook.name} size="sm" />}
                    onPress={() => setActing(cook)}
                    right={
                      cook.invitationPending ? (
                        <Badge label="Invite pending" tone="warning" />
                      ) : cook.initialPasswordPending ? (
                        <Badge label="Not signed in" tone="warning" />
                      ) : (
                        <Badge label="Active" tone="success" />
                      )
                    }
                    subtitle={cook.loginEmail}
                    title={cook.name}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>

        {past.length > 0 ? (
          <View>
            <SectionHeader title="No longer here" />
            <Card padding="px-4 py-1">
              {past.map((cook, index) => (
                <View key={cook.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon="time-outline"
                    subtitle={
                      cook.removedAt
                        ? `Was ${cook.name} · removed ${dates.date(cook.removedAt)}`
                        : `Was ${cook.name}`
                    }
                    title={cook.historicalName || cook.name}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}
      </View>

      <Sheet onClose={() => setActing(null)} open={acting !== null} title={acting?.name ?? ""}>
        {acting ? (
          <View className="gap-4 pb-2">
            <Pressable
              accessibilityLabel="Copy the sign-in"
              className="flex-row items-center gap-3 rounded-xl bg-muted p-3 active:opacity-70"
              onPress={() => void copy(acting.loginEmail, "Sign-in")}
            >
              <Text className="flex-1 font-mono" numberOfLines={1} variant="label">
                {acting.loginEmail}
              </Text>
              <Ionicons color={colors.mutedForeground} name="copy-outline" size={18} />
            </Pressable>

            <Card className="gap-1">
              {acting.addedAt ? <FactRow label="Added" value={dates.date(acting.addedAt)} /> : null}
              {acting.kind === "CREDENTIAL" && acting.credentialIssuedAt ? (
                <FactRow label="Password issued" value={dates.date(acting.credentialIssuedAt)} />
              ) : null}
              {acting.invitationPending && acting.invitationExpiresAt ? (
                <FactRow label="Link expires" value={dates.date(acting.invitationExpiresAt)} />
              ) : null}
            </Card>

            <Card padding="px-4 py-1">
              <ListRow
                icon="create-outline"
                iconBgColor="#007AFF"
                onPress={() => {
                  setEditing(acting);
                  setEditedName(acting.name);
                  setActing(null);
                }}
                title="Rename"
              />
              {/* Only a generated sign-in has a password of ours to rotate. */}
              {acting.kind === "CREDENTIAL" ? (
                <>
                  <RowDivider inset />
                  <ListRow
                    icon="key-outline"
                    iconBgColor="#FF9500"
                    onPress={() => rotate(acting)}
                    title="New password"
                  />
                </>
              ) : null}
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

      <Sheet
        footer={
          <Button
            label={mode === "CREDENTIAL" ? "Create the sign-in" : "Send the invitation"}
            loading={busy}
            onPress={() => void submit()}
          />
        }
        onClose={() => setAdding(false)}
        open={adding}
        title="Add a cook"
      >
        <View className="gap-3 pb-2">
          <Segmented
            onChange={(value) => setMode(value as Mode)}
            options={MODES}
            value={mode}
          />

          <Input
            hint="Residents see it beside the food."
            label="Cook's name"
            onChangeText={setName}
            placeholder="Who runs the kitchen"
            value={name}
          />

          {mode === "INVITE" ? (
            <Input
              autoCapitalize="none"
              hint="The link lasts seven days."
              keyboardType="email-address"
              label="Their email"
              onChangeText={setEmail}
              placeholder="cook@gmail.com"
              value={email}
            />
          ) : (
            <Text variant="caption">
              We show a sign-in and password once. No email needed.
            </Text>
          )}
        </View>
      </Sheet>

      <Sheet
        footer={<Button label="I have written it down" onPress={() => setIssued(null)} />}
        onClose={() => setIssued(null)}
        open={issued !== null}
        title={issued?.rotated ? "New password" : "Their sign-in"}
      >
        <View className="gap-3 pb-2">
          <Text variant="muted">
            {issued?.rotated
              ? `${issued.cookName}'s old password no longer works. Give them these.`
              : `Give these to ${issued?.cookName}.`}
          </Text>

          <Card className="gap-3">
            <Pressable
              accessibilityLabel="Copy the sign-in address"
              onPress={() =>
                issued ? void copy(issued.credentials.email, "Sign-in") : undefined
              }
            >
              <FactRow
                label="Sign-in"
                value={
                  <Text className="font-mono" variant="label">
                    {issued?.credentials.email}
                  </Text>
                }
              />
            </Pressable>

            <Pressable
              accessibilityLabel="Copy the password"
              onPress={() =>
                issued
                  ? void copy(issued.credentials.temporaryPassword, "Password")
                  : undefined
              }
            >
              <FactRow
                label="Password"
                value={
                  <Text className="font-mono" variant="label">
                    {issued?.credentials.temporaryPassword}
                  </Text>
                }
              />
            </Pressable>

            <Text variant="caption">Tap either line to copy it.</Text>
          </Card>

          <Text variant="caption">
            Also emailed to you. Lost it later? Issue a new one.
          </Text>
        </View>
      </Sheet>

      <Sheet
        footer={
          <Button label="Save" loading={busy} onPress={() => void rename()} />
        }
        onClose={() => setEditing(null)}
        open={editing !== null}
        title="Rename"
      >
        <View className="gap-3 pb-2">
          <Input
            hint="Their sign-in stays the same."
            label="Cook's name"
            onChangeText={setEditedName}
            value={editedName}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
