import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { WalletMark, walletLabel } from "@/components/ui/wallet-mark";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  type GatewayConfig,
  GATEWAY_PROVIDERS,
  type GatewayProviderName,
  saveGateway,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { humanizeEnum } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * One payment provider — eSewa, Fonepay or Khalti.
 *
 * A summary, like Payment setup: the switch, a readiness bar, and one row per
 * setting. Each row opens a small sheet that saves only itself.
 *
 * ## Every save re-sends kind and mode
 *
 * The server defaults a missing `accountKind` to MERCHANT and `mode` to SANDBOX
 * rather than keeping what is stored, so a save that changed only the merchant
 * code would silently flip a live gateway back to sandbox. `persist` always
 * carries both.
 *
 * ## Secrets are write-only
 *
 * What comes back is `{ configured, fingerprint, rotatedAt }` — never the key.
 * Blank in the keys sheet means *keep the stored key*, so blank fields are
 * omitted rather than sent empty (the server refuses an empty string).
 *
 * ## Stored but refused
 *
 * A personal wallet can never take online payments. The server says why in
 * `blockedReason` instead of the screen hiding the option.
 */

function isProvider(value: string): value is GatewayProviderName {
  return (GATEWAY_PROVIDERS as readonly string[]).includes(value);
}

type SheetKind = "code" | "keys" | "kind" | "mode";

type Patch = Omit<Parameters<typeof saveGateway>[0], "provider">;

export default function ManageGatewayScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ provider?: string }>();
  const provider = params.provider && isProvider(params.provider) ? params.provider : null;

  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState(false);
  /** The switch's position while its save is in flight. */
  const [switching, setSwitching] = useState<boolean | null>(null);

  const query = adminQuery.gateways();
  const gateways = useResource<GatewayConfig[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const entry = useMemo(
    () => (gateways.data ?? []).find((config) => config.provider === provider) ?? null,
    [gateways.data, provider],
  );

  const persist = async (patch: Patch, done: string) => {
    if (!provider) {
      return false;
    }

    setBusy(true);

    try {
      const next = await saveGateway({
        accountKind: (entry?.accountKind as "MERCHANT" | "PERSONAL" | undefined) ?? "MERCHANT",
        mode: (entry?.mode as "LIVE" | "SANDBOX" | undefined) ?? "SANDBOX",
        provider,
        ...patch,
      });

      gateways.setData(() => next);
      toastSuccess(done);
      setSheet(null);

      return true;
    } catch (error) {
      toastError("Could not save", readApiError(error));

      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (value: boolean) => {
    setSwitching(value);
    await persist({ enabled: value }, value ? "Switched on" : "Switched off");
    setSwitching(null);
  };

  const openSheet = (kind: SheetKind) => {
    setCode(entry?.merchantCode ?? "");
    setSecret("");
    setWebhookSecret("");
    setSheet(kind);
  };

  const title = provider ? walletLabel(provider) : "Provider";
  const header = <AppBar accent centerTitle showBack title={title} />;

  if (!provider) {
    return (
      <Screen header={header}>
        <ErrorState message="That provider does not exist." onRetry={() => router.back()} />
      </Screen>
    );
  }

  if (gateways.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (gateways.error) {
    return (
      <Screen header={header}>
        <ErrorState message={gateways.error} onRetry={gateways.reload} />
      </Screen>
    );
  }

  const merchant = entry?.accountKind !== "PERSONAL";
  const live = entry?.mode === "LIVE";
  const keyed = entry?.secret.configured ?? false;
  const enabled = switching ?? entry?.enabled ?? false;
  const ready = [merchant, keyed, live, entry?.enabled ?? false].filter(Boolean).length;

  const check = (ok: boolean, label: string) => (
    <View className="flex-row items-center gap-1.5" key={label}>
      <Ionicons
        color={ok ? colors.success : colors.mutedForeground}
        name={ok ? "checkmark-circle" : "ellipse-outline"}
        size={16}
      />
      <Text variant="caption">{label}</Text>
    </View>
  );

  return (
    <Screen header={header} onRefresh={gateways.refresh} refreshing={gateways.refreshing} scroll>
      <View className="gap-5 pt-1">
        <Card className="gap-3">
          <View className="flex-row items-center gap-3">
            <WalletMark name={provider} size={48} />
            <View className="flex-1 items-start gap-1">
              <Text variant="label">Offer to residents</Text>
              <Badge
                label={entry?.payable ? "Taking payments" : "Not taking payments"}
                tone={entry?.payable ? "success" : "neutral"}
              />
            </View>
            <Toggle
              accessibilityLabel="Offer this gateway to residents"
              onChange={(value) => void toggle(value)}
              value={enabled}
            />
          </View>

          {entry?.blockedReason ? (
            <Text className="text-warning" variant="caption">
              {entry.blockedReason}
            </Text>
          ) : null}

          <Meter label={`${ready} of 4 ready`} percent={ready * 25} />
          <View className="flex-row flex-wrap gap-x-4 gap-y-1.5">
            {check(merchant, "Merchant account")}
            {check(keyed, "Key installed")}
            {check(live, "Live mode")}
            {check(entry?.enabled ?? false, "Switched on")}
          </View>
        </Card>

        <View>
          <SectionHeader title="Settings" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="briefcase-outline"
              iconBgColor="#007AFF"
              onPress={() => openSheet("kind")}
              subtitle={merchant ? "Merchant" : "Personal — can't take payments"}
              title="Account kind"
            />
            <RowDivider inset />
            <ListRow
              icon="barcode-outline"
              iconBgColor="#FF9500"
              onPress={() => openSheet("code")}
              subtitle={entry?.merchantCode || "Not set"}
              title="Merchant code"
            />
            <RowDivider inset />
            <ListRow
              icon={live ? "flash-outline" : "flask-outline"}
              iconBgColor={live ? "#34C759" : "#AF52DE"}
              onPress={() => openSheet("mode")}
              subtitle={live ? "Live — real money" : "Sandbox — test only"}
              title="Mode"
            />
            <RowDivider inset />
            <ListRow
              icon="key-outline"
              iconBgColor="#FF3B30"
              onPress={() => openSheet("keys")}
              subtitle={
                keyed
                  ? `Installed${entry?.secret.fingerprint ? ` · ${entry.secret.fingerprint}` : ""}`
                  : "No key yet"
              }
              title="Keys"
            />
          </Card>
        </View>

        {entry?.health || entry?.lastVerifiedAt || entry?.lastEventAt ? (
          <Card className="gap-1">
            {entry.health ? (
              <FactRow
                label="Health"
                value={entry.health.detail ?? humanizeEnum(entry.health.status)}
              />
            ) : null}
            {entry.lastVerifiedAt ? (
              <FactRow label="Last checked" value={dates.date(entry.lastVerifiedAt)} />
            ) : null}
            {entry.lastEventAt ? (
              <FactRow label="Last payment" value={dates.date(entry.lastEventAt)} />
            ) : null}
          </Card>
        ) : null}
      </View>

      <Sheet
        footer={
          sheet === "code" || sheet === "keys" ? (
            <Button
              label="Save"
              loading={busy}
              onPress={() =>
                void (sheet === "code"
                  ? persist({ merchantCode: code.trim() }, "Merchant code saved")
                  : persist(
                      {
                        secret: secret.trim() || undefined,
                        webhookSecret: webhookSecret.trim() || undefined,
                      },
                      "Keys saved",
                    ))
              }
            />
          ) : undefined
        }
        onClose={() => setSheet(null)}
        open={sheet !== null}
        title={
          sheet === "kind"
            ? "Account kind"
            : sheet === "mode"
              ? "Mode"
              : sheet === "code"
                ? "Merchant code"
                : "Keys"
        }
      >
        <View className="gap-3 pb-2">
          {sheet === "kind" ? (
            <Card padding="px-0 py-1">
              {(
                [
                  ["MERCHANT", "Merchant", "Registered with the provider"],
                  ["PERSONAL", "Personal", "Stored, but can't take online payments"],
                ] as const
              ).map(([value, label, hint]) => (
                <SheetRow
                  key={value}
                  label={label}
                  onPress={() => void persist({ accountKind: value }, `Set to ${label.toLowerCase()}`)}
                  selected={(entry?.accountKind ?? "MERCHANT") === value}
                  subtitle={hint}
                />
              ))}
            </Card>
          ) : null}

          {sheet === "mode" ? (
            <Card padding="px-0 py-1">
              {(
                [
                  ["SANDBOX", "Sandbox", "Test credentials"],
                  ["LIVE", "Live", "Real money"],
                ] as const
              ).map(([value, label, hint]) => (
                <SheetRow
                  key={value}
                  label={label}
                  onPress={() => void persist({ mode: value }, `${label} mode`)}
                  selected={(entry?.mode ?? "SANDBOX") === value}
                  subtitle={hint}
                />
              ))}
            </Card>
          ) : null}

          {sheet === "code" ? (
            <Input
              hint="eSewa's product code, Fonepay's merchant code. Khalti leaves it empty."
              label="Merchant code"
              onChangeText={setCode}
              value={code}
            />
          ) : null}

          {sheet === "keys" ? (
            <>
              <Input
                label="Signing secret"
                onChangeText={setSecret}
                placeholder={keyed ? "Unchanged" : ""}
                secure
                value={secret}
              />
              <Input
                hint="Only if the provider gives a second key for callbacks. Blank keeps what is stored."
                label="Webhook secret"
                onChangeText={setWebhookSecret}
                placeholder={entry?.webhookSecret.configured ? "Unchanged" : ""}
                secure
                value={webhookSecret}
              />
            </>
          ) : null}
        </View>
      </Sheet>
    </Screen>
  );
}
