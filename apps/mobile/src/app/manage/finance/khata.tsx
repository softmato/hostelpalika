import { useState } from "react";
import { View } from "react-native";

import { KhataAsks } from "@/components/khata-asks";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import {
  decideKhataAccount,
  type KhataAccount,
  khataIcon,
  type KhataItem,
  khataQuery,
  saveKhataItems,
} from "@/lib/khata-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Khata — the warden's side.
 *
 * Top to bottom in the order things need doing: residents asking to open one,
 * asks waiting at the counter, the open khatas with what each will add to next
 * month's bill, and the price list. Every row opens a sheet; nothing here is a
 * paragraph.
 */

type ItemDraft = { active: boolean; id?: string; name: string; price: string };

const EMPTY_DRAFT: ItemDraft = { active: true, name: "", price: "" };

function room(account: KhataAccount) {
  return account.roomNumber ? `Room ${account.roomNumber}` : undefined;
}

export default function KhataScreen() {
  const query = khataQuery.admin();
  const khata = useResource(query.load, { cacheKey: query.key, topics: query.topics });

  const [request, setRequest] = useState<KhataAccount | null>(null);
  const [account, setAccount] = useState<KhataAccount | null>(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (target: KhataAccount, action: "APPROVE" | "DECLINE" | "CLOSE") => {
    setBusy(action);

    try {
      await decideKhataAccount(target.id, action);
      toastSuccess(
        action === "APPROVE"
          ? `${target.name}'s khata is open`
          : action === "CLOSE"
            ? "Khata closed"
            : "Request declined",
      );
      setRequest(null);
      setAccount(null);
      khata.refresh();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setBusy(null);
    }
  };

  const saveItems = async (items: KhataItem[] | (Omit<KhataItem, "id"> & { id?: string })[]) => {
    setBusy("items");

    try {
      const saved = await saveKhataItems(items);

      khata.setData((current) => (current ? { ...current, items: saved } : current));
      setDraft(null);
      return true;
    } catch (error) {
      toastError("Could not save", readApiError(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    if (!draft || !khata.data) {
      return;
    }

    const price = Number(draft.price);

    if (!draft.name.trim() || !Number.isInteger(price) || price < 1) {
      toastError("Check the item", "A name and a price in whole rupees.");
      return;
    }

    const item = { active: draft.active, id: draft.id, name: draft.name.trim(), price };
    const items = draft.id
      ? khata.data.items.map((row) => (row.id === draft.id ? { ...row, ...item, id: row.id } : row))
      : [...khata.data.items, item];

    if (await saveItems(items)) {
      toastSuccess(draft.id ? "Item saved" : `${item.name} added`);
    }
  };

  const removeDraft = () => {
    const target = draft;

    if (!target?.id || !khata.data) {
      return;
    }

    openConfirm({
      confirmLabel: "Remove",
      destructive: true,
      message: "Residents can no longer ask for it. What was already taken stays on their bill.",
      onConfirm: async () => {
        if (await saveItems(khata.data!.items.filter((row) => row.id !== target.id))) {
          toastSuccess(`${target.name} removed`);
        }
      },
      title: `Remove ${target.name}?`,
    });
  };

  const header = <AppBar accent centerTitle showBack title="Khata" />;

  if (khata.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonRows rows={4} />
        </View>
      </Screen>
    );
  }

  if (khata.error || !khata.data) {
    return (
      <Screen header={header}>
        <ErrorState message={khata.error ?? "Could not load"} onRetry={khata.reload} />
      </Screen>
    );
  }

  const { accounts, items, requests } = khata.data;

  return (
    <Screen
      footer={<Button label="Add an item" onPress={() => setDraft(EMPTY_DRAFT)} />}
      header={header}
      onRefresh={khata.refresh}
      refreshing={khata.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {requests.length > 0 ? (
          <View>
            <SectionHeader title={`Want a khata · ${requests.length}`} />
            <Card padding="px-4 py-1">
              {requests.map((row, index) => (
                <View key={row.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon="person-add-outline"
                    iconBgColor="#007AFF"
                    onPress={() => setRequest(row)}
                    right={<Badge label="New" tone="warning" />}
                    subtitle={room(row)}
                    title={row.name}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        <KhataAsks emptyHidden onChanged={khata.refresh} orders={khata.data} />

        <View>
          <SectionHeader title={`Open khatas · ${accounts.length}`} />
          {accounts.length === 0 ? (
            <EmptyCard description="Residents ask from their app." title="No open khatas" />
          ) : (
            <Card padding="px-4 py-1">
              {accounts.map((row, index) => (
                <View key={row.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon="person-outline"
                    iconBgColor="#34C759"
                    onPress={() => setAccount(row)}
                    subtitle={room(row)}
                    title={row.name}
                    value={row.unbilled > 0 ? formatMoney(row.unbilled) : "—"}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>

        <View>
          <SectionHeader title="Items" />
          {items.length === 0 ? (
            <EmptyCard description="Egg, extra meal, laundry…" title="No items yet" />
          ) : (
            <Card padding="px-4 py-1">
              {items.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon={khataIcon(item.name)}
                    iconBgColor={item.active ? "#AF52DE" : "#8E8E93"}
                    onPress={() =>
                      setDraft({ active: item.active, id: item.id, name: item.name, price: String(item.price) })
                    }
                    right={item.active ? undefined : <Badge label="Off" tone="neutral" />}
                    title={item.name}
                    value={formatMoney(item.price)}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>
      </View>

      <Sheet
        footer={
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button
                disabled={busy !== null && busy !== "DECLINE"}
                label="Don't open"
                loading={busy === "DECLINE"}
                onPress={() => request && void decide(request, "DECLINE")}
                variant="outline"
              />
            </View>
            <View className="flex-1">
              <Button
                disabled={busy !== null && busy !== "APPROVE"}
                label="Open khata"
                loading={busy === "APPROVE"}
                onPress={() => request && void decide(request, "APPROVE")}
              />
            </View>
          </View>
        }
        onClose={() => setRequest(null)}
        open={request !== null}
        title={request?.name ?? ""}
      >
        <Text variant="muted">{request ? (room(request) ?? "Asked to open a khata") : ""}</Text>
      </Sheet>

      <Sheet onClose={() => setAccount(null)} open={account !== null} title={account?.name ?? ""}>
        {account ? (
          <View className="gap-1">
            <SheetRow
              label="Close khata"
              onPress={() => void decide(account, "CLOSE")}
              subtitle={
                account.unbilled > 0
                  ? `${formatMoney(account.unbilled)} still goes on their next bill`
                  : "They can ask to open it again"
              }
            />
          </View>
        ) : null}
      </Sheet>

      <Sheet
        footer={
          <View className="gap-2">
            <Button label="Save" loading={busy === "items"} onPress={() => void saveDraft()} />
            {draft?.id ? (
              <Button label="Remove item" onPress={removeDraft} variant="ghost" />
            ) : null}
          </View>
        }
        onClose={() => setDraft(null)}
        open={draft !== null}
        title={draft?.id ? "Edit item" : "New item"}
      >
        {draft ? (
          <View className="gap-3 pb-2">
            <Input
              label="Item"
              onChangeText={(name) => setDraft((prev) => (prev ? { ...prev, name } : prev))}
              placeholder="Egg"
              value={draft.name}
            />
            <Input
              keyboardType="number-pad"
              label="Price"
              leading={<Text variant="subtitle">Rs</Text>}
              onChangeText={(price) =>
                setDraft((prev) => (prev ? { ...prev, price: price.replace(/\D/g, "") } : prev))
              }
              placeholder="0"
              value={draft.price}
            />
            <Card padding="px-4 py-1">
              <ListRow
                icon="eye-outline"
                iconBgColor="#34C759"
                right={
                  <Toggle
                    accessibilityLabel="Residents can ask for it"
                    onChange={(active) => setDraft((prev) => (prev ? { ...prev, active } : prev))}
                    value={draft.active}
                  />
                }
                title="Residents can ask"
              />
            </Card>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
