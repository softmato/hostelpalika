import { useMemo, useState } from "react";
import { Linking, ScrollView, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { readableRole, type Role } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { getPlatformDirectory, type PlatformPerson, setUserBlocked, statusLabel } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Users — the web's People › Users directory: every account and every resident
 * record, by role, searchable by name, phone, email or hostel. A row opens the
 * person in a sheet with call / email, Block / Unblock (superadmin; signs them
 * out everywhere and refuses every sign-in), and for a resident room, fee and
 * guardian. The list is capped server-side (`LIST_LIMIT`); search narrows it.
 */

const ADMIN_ROLES = ["SUPERADMIN", "PLATFORM_MODERATOR"];

const ROLE_ORDER = ["HOSTEL_ADMIN", "WARDEN", "RESIDENT", "COOK", "GUARDIAN", "SERVICE_PROVIDER", "TEAM_MEMBER", "PUBLIC", "SUPERADMIN", "PLATFORM_MODERATOR"];
const SHOWN = 150;

export default function PlatformUsersScreen() {
  const dates = useDates();
  const directory = useResource(getPlatformDirectory, { cacheKey: "platform:users" });
  const [role, setRole] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<PlatformPerson | null>(null);
  const isSuper = useAppSelector((state) => state.auth.account?.role) === "SUPERADMIN";
  const canBlock = (person: PlatformPerson) =>
    isSuper && !person.id.startsWith("resident:") && !ADMIN_ROLES.includes(person.role) && person.status !== "ARCHIVED";

  function toggleBlock(person: PlatformPerson) {
    const blocked = person.status === "SUSPENDED";
    // The confirm host draws beneath a bottom sheet: close it first.
    setOpen(null);
    openConfirm({
      confirmLabel: blocked ? "Unblock" : "Block",
      destructive: !blocked,
      message: blocked
        ? `${person.name} can sign in again.`
        : `${person.name} is signed out on every device and cannot sign in until you unblock them.`,
      onConfirm: async () => {
        try {
          await setUserBlocked(person.id, !blocked);
          toastSuccess(blocked ? `${person.name} unblocked` : `${person.name} blocked`);
          directory.refresh();
        } catch (error) {
          toastError(blocked ? "Not unblocked" : "Not blocked", readApiError(error));
        }
      },
      title: blocked ? `Unblock ${person.name}?` : `Block ${person.name}?`,
    });
  }

  const roles = useMemo(() => {
    const counts = directory.data?.roleCounts ?? {};
    const rank = (key: string) => (ROLE_ORDER.includes(key) ? ROLE_ORDER.indexOf(key) : ROLE_ORDER.length);
    return Object.keys(counts).sort((a, b) => rank(a) - rank(b));
  }, [directory.data]);

  const people = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (directory.data?.people ?? []).filter(
      (person) =>
        (role === "all" || person.role === role) &&
        (!needle || [person.name, person.phone, person.email, person.hostelName].some((value) => value?.toLowerCase().includes(needle))),
    );
  }, [directory.data, role, search]);

  return (
    <Screen
      header={<AppBar showBack subtitle={directory.data ? `${directory.data.total} people` : undefined} title="Users" />}
      onRefresh={directory.refresh}
      refreshing={directory.refreshing}
      scroll
    >
      <View className="gap-4">
        <Input onChangeText={setSearch} placeholder="Search name, phone, email, hostel" value={search} />

        <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
          <Chip label={`All · ${directory.data?.total ?? 0}`} onPress={() => setRole("all")} tone={role === "all" ? "brand" : "neutral"} />
          {roles.map((key) => (
            <Chip
              key={key}
              label={`${readableRole(key as Role)} · ${directory.data?.roleCounts[key] ?? 0}`}
              onPress={() => setRole(key)}
              tone={role === key ? "brand" : "neutral"}
            />
          ))}
        </ScrollView>

        {directory.loading ? (
          <SkeletonRows rows={8} />
        ) : directory.error ? (
          <ErrorState message={directory.error} onRetry={directory.reload} />
        ) : people.length === 0 ? (
          <EmptyCard description="Try another name, phone or hostel." title="No match" />
        ) : (
          <>
            <Card padding="px-4 py-1">
              {people.slice(0, SHOWN).map((person, index) => (
                <View key={person.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    left={<PersonAvatar image={null} name={person.name} size="sm" />}
                    onPress={() => setOpen(person)}
                    right={person.status !== "ACTIVE" ? <Badge label={person.status === "SUSPENDED" ? "Blocked" : statusLabel(person.status)} tone={person.status === "SUSPENDED" ? "danger" : "warning"} /> : undefined}
                    subtitle={[readableRole(person.role as Role), person.hostelName, person.phone].filter(Boolean).join(" · ")}
                    title={person.name}
                  />
                </View>
              ))}
            </Card>
            {people.length > SHOWN ? (
              <Text className="text-center text-xs" variant="muted">
                {`Showing ${SHOWN} of ${people.length}. Search to narrow.`}
              </Text>
            ) : null}
          </>
        )}
      </View>

      <Sheet onClose={() => setOpen(null)} open={open !== null} tall title={open?.name ?? ""}>
        {open ? (
          <View className="gap-4 pb-2">
            <View className="flex-row items-center gap-3">
              <PersonAvatar image={null} name={open.name} size="lg" />
              <View className="min-w-0 flex-1 gap-1">
                <View className="flex-row flex-wrap gap-2">
                  <Badge label={readableRole(open.role as Role)} tone="info" />
                  <Badge label={open.status === "SUSPENDED" ? "Blocked" : statusLabel(open.status)} tone={open.status === "ACTIVE" ? "success" : open.status === "SUSPENDED" ? "danger" : "warning"} />
                  {open.isDemoData ? <Badge label="Demo" tone="neutral" /> : null}
                </View>
                {open.hostelName ? (
                  <Text numberOfLines={1} variant="muted">
                    {open.hostelCount > 1 ? `${open.hostelName} +${open.hostelCount - 1}` : open.hostelName}
                  </Text>
                ) : null}
              </View>
            </View>

            <View className="flex-row gap-3">
              {open.phone ? (
                <View className="flex-1">
                  <Button icon="call" label="Call" onPress={() => void Linking.openURL(`tel:${open.phone}`)} variant="outline" />
                </View>
              ) : null}
              {open.email ? (
                <View className="flex-1">
                  <Button icon="mail" label="Email" onPress={() => void Linking.openURL(`mailto:${open.email}`)} variant="outline" />
                </View>
              ) : null}
            </View>

            {canBlock(open) ? (
              <Button
                icon={open.status === "SUSPENDED" ? "lock-open" : "ban"}
                label={open.status === "SUSPENDED" ? "Unblock account" : "Block account"}
                onPress={() => toggleBlock(open)}
                variant={open.status === "SUSPENDED" ? "primary" : "danger"}
              />
            ) : null}

            <Card>
              {open.phone ? <FactRow label="Phone" value={open.phone} /> : null}
              {open.email ? <FactRow label="Email" value={open.email} /> : null}
              <FactRow label="Joined" value={open.createdAt ? dates.date(open.createdAt) : "—"} />
              <FactRow label="Last sign-in" value={open.lastLoginAt ? dates.ago(open.lastLoginAt) : "Never"} />
            </Card>

            {open.role === "RESIDENT" ? (
              <View>
                <SectionHeader title="Stay" />
                <Card>
                  {open.stayType ? <FactRow label="Room type" value={open.stayType} /> : null}
                  {open.moveInDate ? <FactRow label="Moved in" value={dates.date(open.moveInDate)} /> : null}
                  {open.residentStatus ? <FactRow label="Status" value={statusLabel(open.residentStatus)} /> : null}
                  {open.feeStatus ? <FactRow label="Fee" value={`${statusLabel(open.feeStatus)}${open.feeMonth ? ` · ${open.feeMonth}` : ""}`} /> : null}
                  <FactRow label="App" value={statusLabel(open.activationStatus || "NOT_GENERATED")} />
                  {open.guardian ? <FactRow label="Guardian" value={`${open.guardian.name} · ${open.guardian.phone}`} /> : null}
                  {open.emergencyContact ? <FactRow label="Emergency" value={`${open.emergencyContact.name} · ${open.emergencyContact.phone}`} /> : null}
                </Card>
              </View>
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
