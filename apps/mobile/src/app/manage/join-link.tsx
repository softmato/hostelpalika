import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useState } from "react";
import { Linking, Share, View } from "react-native";

import { ActionCard, ActionCell } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CardRow, ListRow } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { saveDataUrlToDevice } from "@/lib/documents";
import { type JoinLink, updateJoinLink } from "@/lib/join-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Residents → Join link (docs/EXISTING_RESIDENTS.md, "Join link").
 *
 * The link and QR a hostel sends to its residents' WhatsApp group, so each
 * person adds themself and the warden only checks. The QR straddles the green
 * block the way the reference apps put the thing a screen is about; the ways to
 * send it are a tile grid; the limits are a card under it.
 */
export default function JoinLinkScreen() {
  const { colors } = useAppTheme();
  const query = adminQuery.joinLink();
  const link = useResource<JoinLink>(query.load, { cacheKey: query.key, topics: query.topics });
  const [cap, setCap] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const data = link.data;

  async function save(patch: { cap?: number; enabled?: boolean; renew?: true }) {
    setSaving(true);

    try {
      const next = await updateJoinLink(patch);

      link.setData(() => next);
      setCap(null);
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  const header = <AppBar showBack title="Join link" />;

  if (link.loading) {
    return (
      <Screen header={header} scroll>
        <SkeletonCard />
      </Screen>
    );
  }

  if (link.error || !data) {
    return (
      <Screen header={header}>
        <ErrorState message={link.error ?? "The join link could not be loaded."} onRetry={link.reload} />
      </Screen>
    );
  }

  const message = `Already living here? Add yourself as a resident on HostelPalika — choose your room and tell us what rent is paid. We check it before adding you.\n${data.url}`;
  const full = data.used >= data.cap;

  return (
    <Screen header={header} onRefresh={link.refresh} refreshing={link.refreshing} scroll>
      <View className="gap-5">
        <View className="-mt-1">
          <View className="items-center rounded-b-3xl bg-primary px-5 pb-28 pt-4">
            <Text className="text-center text-sm text-primary-foreground/85">
              Residents open it, choose their room and say what rent is paid. You check and add.
            </Text>
          </View>
          <View className="-mt-24 items-center">
            <View className="items-center gap-2 rounded-3xl bg-card p-4" style={{ elevation: 3 }}>
              {data.qrDataUrl ? (
                <Image
                  accessibilityLabel="QR code for the join link"
                  source={{ uri: data.qrDataUrl }}
                  style={{ height: 180, opacity: data.enabled ? 1 : 0.3, width: 180 }}
                />
              ) : null}
              <Text className="max-w-[240px] text-center text-xs" selectable variant="muted">
                {data.url}
              </Text>
            </View>
          </View>
        </View>

        {!data.enabled || full ? (
          <Card className="flex-row items-center gap-3 bg-warning-soft">
            <Text className="flex-1 text-sm font-semibold">
              {!data.enabled
                ? "Paused — nobody can send a new request."
                : "Full — nobody new can send. Allow more below."}
            </Text>
          </Card>
        ) : null}

        <ActionCard>
          <ActionCell
            glyph={colors.primary}
            icon="logo-whatsapp"
            label="WhatsApp"
            onPress={() =>
              void Linking.openURL(`whatsapp://send?text=${encodeURIComponent(message)}`).catch(() =>
                Share.share({ message }).catch(() => null),
              )
            }
            tone="brand"
          />
          <ActionCell
            glyph={colors.primary}
            icon="share-social-outline"
            label="Share"
            onPress={() => void Share.share({ message }).catch(() => null)}
            tone="brand"
          />
          <ActionCell
            glyph={colors.primary}
            icon="copy-outline"
            label="Copy link"
            onPress={async () => {
              await Clipboard.setStringAsync(data.url);
              toastSuccess("Link copied");
            }}
            tone="brand"
          />
          <ActionCell
            glyph={colors.primary}
            icon="qr-code-outline"
            label="Save QR"
            onPress={async () => {
              if (!data.qrDataUrl) return;

              try {
                await saveDataUrlToDevice({
                  dataUrl: data.qrDataUrl,
                  fileName: "hostel-join-link-qr",
                  label: "Join QR",
                });
              } catch (error) {
                toastError("Could not save that", readApiError(error));
              }
            }}
            tone="brand"
          />
        </ActionCard>

        <View>
          <SectionHeader
            subtitle="Fixing and sending again is the same request"
            title="How many can send"
          />
          <Card className="gap-4">
            <Meter
              label={`${data.used} of ${data.cap} used`}
              percent={Math.min(100, Math.round((data.used / Math.max(data.cap, 1)) * 100))}
            />
            <View className="flex-row items-end gap-3">
              <View className="flex-1">
                <Input
                  hint="Your residents plus a few spare"
                  keyboardType="number-pad"
                  label="Allow up to"
                  onChangeText={(text) => setCap(text.replace(/[^\d]/g, ""))}
                  value={cap ?? String(data.cap)}
                />
              </View>
              <Button
                disabled={saving || cap === null || !Number(cap) || Number(cap) === data.cap}
                label="Save"
                onPress={() => void save({ cap: Number(cap) })}
                size="sm"
              />
            </View>
          </Card>
        </View>

        <Card padding="px-4 py-1">
          <ListRow
            right={
              <Toggle
                accessibilityLabel="Link is on"
                onChange={(enabled) => void save({ enabled })}
                value={data.enabled}
              />
            }
            subtitle={data.enabled ? "Anyone with the link can send" : "Paused — turn on to take requests"}
            title="Link is on"
          />
        </Card>

        <CardRow
          icon="refresh-outline"
          onPress={() =>
            openConfirm({
              confirmLabel: "Make new link",
              destructive: true,
              message:
                "The old link and QR stop working at once, wherever they were shared. Requests already sent stay.",
              onConfirm: () => save({ renew: true }),
              title: "Make a new link?",
            })
          }
          subtitle="Use it if the link reached people it should not"
          title="Make a new link"
          tone="warning"
        />
      </View>
    </Screen>
  );
}
