import { useCallback, useMemo, useState } from "react";
import { Linking, ScrollView, View } from "react-native";

import { Quiet, Rows, TintRow } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { listProviders, moderateProvider, type PlatformProvider, type ProviderStatus, statusLabel } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Service providers — plumbers, electricians and the rest who apply to be listed
 * (web `platform-service-providers-page`). Pending first; approve lists them,
 * reject needs a reason, hide takes an approved one off the directory.
 */

const FILTERS: { key: ProviderStatus | "ALL"; label: string }[] = [
  { key: "PENDING_APPROVAL", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "HIDDEN", label: "Hidden" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
];

const TONE = { APPROVED: "success", HIDDEN: "neutral", INACTIVE: "neutral", PENDING_APPROVAL: "warning", REJECTED: "danger" } as const;

export default function ProvidersScreen() {
  const dates = useDates();
  const [filter, setFilter] = useState<ProviderStatus | "ALL">("PENDING_APPROVAL");
  const [search, setSearch] = useState("");
  const load = useCallback(() => listProviders(filter === "ALL" ? undefined : filter), [filter]);
  const list = useResource(load, { cacheKey: `platform:providers:${filter}` });
  const [open, setOpen] = useState<PlatformProvider | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (list.data ?? []).filter((row) => !needle || [row.fullName, row.phone, row.area, row.category, row.city].some((value) => value?.toLowerCase().includes(needle)));
  }, [list.data, search]);

  function close() {
    setOpen(null);
    setRejecting(false);
    setReason("");
  }

  async function act(provider: PlatformProvider, action: "approve" | "hide" | "reject") {
    if (action === "reject" && reason.trim().length < 2) {
      toastError("Say why", "The provider reads this.");
      return;
    }
    setBusy(true);
    try {
      await moderateProvider(provider.id, action, action === "reject" ? reason : undefined);
      toastSuccess(`${provider.fullName} ${action === "approve" ? "approved" : action === "hide" ? "hidden" : "rejected"}`);
      close();
      list.refresh();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen header={<AppBar showBack title="Service providers" />} onRefresh={list.refresh} refreshing={list.refreshing} scroll>
      <View className="gap-4">
        <Input onChangeText={setSearch} placeholder="Search name, trade, area" value={search} />
        <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
          {FILTERS.map((entry) => (
            <Chip key={entry.key} label={entry.label} onPress={() => setFilter(entry.key)} tone={filter === entry.key ? "brand" : "neutral"} />
          ))}
        </ScrollView>
        {list.loading ? (
          <SkeletonRows rows={5} />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : rows.length === 0 ? (
          <Quiet>{filter === "PENDING_APPROVAL" ? "No application is waiting." : "No provider here."}</Quiet>
        ) : (
          <Rows>
            {rows.map((row) => (
              <TintRow
                icon="build"
                key={row.id}
                onPress={() => setOpen(row)}
                subtitle={[(row.categories ?? [row.category]).join(", "), row.area].filter(Boolean).join(" · ")}
                title={row.fullName}
                tone={TONE[row.status] ?? "neutral"}
                value={filter === "ALL" ? statusLabel(row.status) : undefined}
              />
            ))}
          </Rows>
        )}
      </View>

      <Sheet onClose={close} open={open !== null} tall title={open?.fullName ?? ""}>
        {open ? (
          <View className="gap-4 pb-2">
            {open.description ? <Text>{open.description}</Text> : null}
            <View>
              <FactRow label="Trade" value={(open.categories ?? [open.category]).join(", ")} />
              <FactRow label="Area" value={[open.area, open.city].filter(Boolean).join(", ")} />
              <FactRow label="Experience" value={open.experience || "—"} />
              <FactRow label="Available" value={open.availability || "—"} />
              <FactRow label="Status" value={statusLabel(open.status)} />
              {open.createdAt ? <FactRow label="Applied" value={dates.date(open.createdAt)} /> : null}
            </View>
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button icon="call" label="Call" onPress={() => void Linking.openURL(`tel:${open.phone}`)} variant="outline" />
              </View>
              {open.email ? (
                <View className="flex-1">
                  <Button icon="mail" label="Email" onPress={() => void Linking.openURL(`mailto:${open.email}`)} variant="outline" />
                </View>
              ) : null}
            </View>

            {rejecting ? <Input label="Why (they read this)" maxLength={800} multiline onChangeText={setReason} value={reason} /> : null}

            {open.status === "PENDING_APPROVAL" ? (
              <View className="flex-row gap-3">
                <View className="flex-1">
                  {rejecting ? (
                    <Button disabled={busy} label="Send rejection" loading={busy} onPress={() => void act(open, "reject")} variant="danger" />
                  ) : (
                    <Button disabled={busy} label="Reject" onPress={() => setRejecting(true)} variant="outline" />
                  )}
                </View>
                {!rejecting ? (
                  <View className="flex-1">
                    <Button disabled={busy} label="Approve" loading={busy} onPress={() => void act(open, "approve")} />
                  </View>
                ) : null}
              </View>
            ) : open.status === "APPROVED" ? (
              <Button disabled={busy} icon="eye-off" label="Hide from directory" loading={busy} onPress={() => void act(open, "hide")} variant="outline" />
            ) : open.status === "HIDDEN" || open.status === "REJECTED" ? (
              <Button disabled={busy} label="Approve" loading={busy} onPress={() => void act(open, "approve")} />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
