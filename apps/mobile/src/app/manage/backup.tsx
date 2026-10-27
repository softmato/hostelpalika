import * as Linking from "expo-linking";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCameraPermissions } from "expo-camera";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { toQR } from "toqr";

import { QrCamera } from "@/components/qr-camera";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import {
  backupFileUrl,
  type BackupOverview,
  type BackupRun,
  backUpNow,
  canMakeKey,
  confirmKit,
  disconnectDrive,
  downloadBackup,
  driveConnectUrl,
  fingerprintOf,
  getBackup,
  keyFromKit,
  keyOnPhone,
  makeKey,
  type OpenedBackup,
  openBackup,
  printKit,
  restoreChunk,
  saveKey,
} from "@/lib/backup";
import { openConfirm } from "@/lib/confirm";
import { downloadToDevice } from "@/lib/documents";
import { toastError, toastSuccess } from "@/lib/toast";
import { recoveryQrText } from "@hostel/backup/sealed-archive";

/**
 * Backup to the owner's Google Drive (docs/FIELD_REVIEW_2026_10_27.md I6–I7).
 *
 * Owner only — the server refuses wardens. Facts first; every word is what is
 * true now ("Last backup … · checked"), nothing about being "safe".
 */
export default function BackupScreen() {
  const backup = useResource<BackupOverview>(getBackup, { cacheKey: "admin:backup" });
  const header = <AppBar accent centerTitle showBack title="Backup" />;

  if (backup.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={4} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (backup.error || !backup.data) {
    return (
      <Screen header={header}>
        <ErrorState message={backup.error ?? "This page could not be loaded."} onRetry={backup.reload} />
      </Screen>
    );
  }

  return <BackupBody data={backup.data} header={header} resource={backup} />;
}

const DRIVE_WORDS: Record<BackupOverview["drive"]["status"], string> = {
  CONNECTED: "Connected",
  ERROR: "Last try failed",
  NOT_CONNECTED: "Not connected",
  QUOTA_FULL: "Drive is full",
  REVOKED: "Access removed",
};

const megabytes = (bytes: number | null) => (bytes ? `${(bytes / 1_048_576).toFixed(1)} MB` : "—");

function BackupBody({
  data,
  header,
  resource,
}: {
  data: BackupOverview;
  header: React.ReactNode;
  resource: { refresh: () => void; refreshing: boolean };
}) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const [phoneKey, setPhoneKey] = useState<Uint8Array | null>(null);
  const [kit, setKit] = useState<ReturnType<typeof makeKey> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreRun, setRestoreRun] = useState<BackupRun | null>(null);
  const lastOk = data.runs.find((run) => run.status === "OK") ?? null;

  useEffect(() => {
    void keyOnPhone(data.hostelId, data.key?.fingerprint ?? null).then(setPhoneKey);
  }, [data.hostelId, data.key?.fingerprint]);

  const newKey = useCallback(() => {
    const start = () => {
      try {
        setKit(makeKey());
      } catch (error) {
        toastError("Could not make a key", readApiError(error));
      }
    };

    if (!data.key) return start();

    openConfirm({
      confirmLabel: "Make a new key",
      destructive: true,
      message: "Backups made so far still need the old recovery kit. New backups will need the new one.",
      onConfirm: start,
      title: "Replace the recovery key?",
    });
  }, [data.key]);

  const kitSaved = useCallback(async () => {
    if (!kit) return;

    try {
      await saveKey(data.hostelId, kit);
      await confirmKit(kit.fingerprint);
      kit.secretKey.fill(0);
      setKit(null);
      toastSuccess("Recovery key saved", `Key ${kit.fingerprint}`);
      resource.refresh();
    } catch (error) {
      toastError("Could not save the key", readApiError(error));
    }
  }, [data.hostelId, kit, resource]);

  const connect = useCallback(async () => {
    setBusy("drive");
    try {
      const result = await WebBrowser.openAuthSessionAsync(await driveConnectUrl(), Linking.createURL("manage/backup"));

      if (result.type === "success" && result.url.includes("drive=connected")) toastSuccess("Google Drive connected");
      else if (result.type === "success") toastError("Drive was not connected", "Google did not allow it. Try again.");
      resource.refresh();
    } catch (error) {
      toastError("Could not open Google", readApiError(error));
    } finally {
      setBusy(null);
    }
  }, [resource]);

  const disconnect = useCallback(() => {
    openConfirm({
      confirmLabel: "Disconnect",
      destructive: true,
      message: "Backups stop. Files already in your Drive stay there.",
      onConfirm: async () => {
        try {
          await disconnectDrive();
          resource.refresh();
        } catch (error) {
          toastError("Could not disconnect", readApiError(error));
        }
      },
      title: "Disconnect Google Drive?",
    });
  }, [resource]);

  const runNow = useCallback(async () => {
    setBusy("run");
    try {
      const result = await backUpNow();

      if (result.ok) toastSuccess("Backup made", result.checked ? "Checked against Drive" : "Not checked");
      else toastError("Backup failed", result.error ?? "");
      resource.refresh();
    } catch (error) {
      toastError("Backup failed", readApiError(error));
    } finally {
      setBusy(null);
    }
  }, [resource]);

  const download = useCallback(async (run: BackupRun) => {
    try {
      await downloadToDevice({
        extension: "hpbk",
        fileName: (run.fileName ?? "backup").replace(/\.hpbk$/, ""),
        label: "Encrypted backup",
        mimeType: "application/octet-stream",
        url: backupFileUrl(run.id),
      });
    } catch (error) {
      toastError("Could not download", readApiError(error));
    }
  }, []);

  if (!data.allowed) {
    return (
      <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
        <View className="gap-5 pt-1">
          <Card className="gap-1">
            <FactRow label="Google Drive backup" value="Pro plan and up" />
            <FactRow label="Your plan" value="Does not include it" />
          </Card>
          <Button label="Open Billing" onPress={() => router.push("/manage/billing")} />
          {data.runs.length > 0 ? <History data={data} onDownload={download} onRestore={setRestoreRun} /> : null}
        </View>
        <RestoreSheet hostelId={data.hostelId} onClose={() => setRestoreRun(null)} phoneKey={phoneKey} run={restoreRun} />
      </Screen>
    );
  }

  const keyWords = !data.key
    ? "Not set up"
    : phoneKey
      ? data.key.kitConfirmedAt
        ? "Kit saved · on this phone"
        : "On this phone · kit not saved"
      : "Not on this phone";

  return (
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      <View className="gap-5 pt-1">
        <View>
          <SectionHeader title="Status" />
          <Card className="gap-1">
            <FactRow
              label="Last backup"
              value={lastOk ? `${dates.dateTime(lastOk.createdAt)} · ${lastOk.checked ? "checked" : "not checked"}` : "None yet"}
            />
            <FactRow
              label="Google Drive"
              value={data.drive.email ? `${DRIVE_WORDS[data.drive.status]} · ${data.drive.email}` : DRIVE_WORDS[data.drive.status]}
            />
            <FactRow label="Recovery key" value={keyWords} />
            {data.key?.fingerprint ? <FactRow label="Key" value={data.key.fingerprint} /> : null}
            {data.drive.error ? (
              <View className="flex-row items-start gap-2 py-2">
                <Badge label={DRIVE_WORDS[data.drive.status]} tone="danger" />
                <Text className="flex-1" variant="body">
                  {data.drive.error}
                </Text>
              </View>
            ) : null}
          </Card>
        </View>

        <View>
          <SectionHeader title="Set up" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="lock-closed"
              iconBgColor={colors.brand}
              onPress={canMakeKey() ? newKey : () => toastError("Update the app", "This version cannot make a recovery key.")}
              subtitle={data.key ? "Make a new key and kit" : "Made on this phone, never sent to us"}
              title={data.key ? "Replace recovery key" : "Set up recovery key"}
            />
            {data.drive.status === "CONNECTED" || data.drive.status === "QUOTA_FULL" || data.drive.status === "ERROR" ? (
              <ListRow
                icon="cloud-offline"
                iconBgColor={colors.destructive}
                onPress={disconnect}
                subtitle="Stop backing up to this Drive"
                title="Disconnect Google Drive"
              />
            ) : (
              <ListRow
                busy={busy === "drive"}
                icon="cloud-upload"
                iconBgColor={colors.brand}
                onPress={data.drive.ready ? connect : () => toastError("Not available yet", "Drive backup is not switched on.")}
                subtitle="A hidden app folder in your own Drive"
                title={data.drive.status === "REVOKED" ? "Reconnect Google Drive" : "Connect Google Drive"}
              />
            )}
          </Card>
        </View>

        {data.key && data.drive.status !== "NOT_CONNECTED" && data.drive.status !== "REVOKED" ? (
          <Button
            disabled={busy === "run"}
            label={busy === "run" ? "Backing up…" : "Back up now"}
            onPress={runNow}
            variant="secondary"
          />
        ) : null}

        <History data={data} onDownload={download} onRestore={setRestoreRun} />
      </View>

      <KitSheet kit={kit} onClose={() => setKit(null)} onSaved={kitSaved} />
      <RestoreSheet hostelId={data.hostelId} onClose={() => setRestoreRun(null)} phoneKey={phoneKey} run={restoreRun} />
    </Screen>
  );
}

/** Backups by day — the heading outside the card. */
function History({
  data,
  onDownload,
  onRestore,
}: {
  data: BackupOverview;
  onDownload: (run: BackupRun) => void;
  onRestore: (run: BackupRun) => void;
}) {
  const dates = useDates();
  const days = useMemo(() => {
    const groups = new Map<string, BackupRun[]>();

    for (const run of data.runs) {
      const day = dates.date(run.createdAt);

      groups.set(day, [...(groups.get(day) ?? []), run]);
    }

    return [...groups];
  }, [data.runs, dates]);

  if (days.length === 0) return null;

  return (
    <View className="gap-4">
      {days.map(([day, runs]) => (
        <View key={day}>
          <SectionHeader title={day} />
          <Card className="gap-3">
            {runs.map((run) => (
              <View className="gap-2" key={run.id}>
                <View className="flex-row items-center justify-between gap-2">
                  <Text variant="body">{`${dates.dateTime(run.createdAt)} · ${megabytes(run.bytes)}`}</Text>
                  <Badge
                    label={run.status === "FAILED" ? "Failed" : run.checked ? "Checked" : "Not checked"}
                    tone={run.status === "FAILED" ? "danger" : run.checked ? "success" : "warning"}
                  />
                </View>
                {run.error ? <Text className="text-sm text-muted-foreground">{run.error}</Text> : null}
                {run.status === "OK" && run.onDrive ? (
                  <View className="flex-row gap-2">
                    <Button className="flex-1" label="Download" onPress={() => onDownload(run)} size="sm" variant="outline" />
                    <Button className="flex-1" label="Restore" onPress={() => onRestore(run)} size="sm" variant="outline" />
                  </View>
                ) : null}
              </View>
            ))}
          </Card>
        </View>
      ))}
    </View>
  );
}

function Qr({ text, size }: { size: number; text: string }) {
  const { colors } = useAppTheme();
  const modules = useMemo(() => toQR(text), [text]);
  const width = Math.sqrt(modules.length);
  const cell = size / (width + 8);

  return (
    <Svg height={size} width={size}>
      <Rect fill={colors.background} height={size} width={size} />
      {Array.from(modules, (on, index) =>
        on ? (
          <Rect
            fill={colors.foreground}
            height={cell}
            key={index}
            width={cell}
            x={(4 + (index % width)) * cell}
            y={(4 + Math.floor(index / width)) * cell}
          />
        ) : null,
      )}
    </Svg>
  );
}

/** The recovery kit: the code to write on paper, and the same as a QR. */
function KitSheet({
  kit,
  onClose,
  onSaved,
}: {
  kit: ReturnType<typeof makeKey> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const groups = kit?.code.split(" ") ?? [];

  return (
    <Sheet
      footer={<Button label="I have it on paper" onPress={onSaved} />}
      onClose={onClose}
      open={Boolean(kit)}
      tall
      title="Recovery kit"
    >
      {kit ? (
        <View className="gap-4">
          <Card className="gap-1">
            <FactRow label="Key" value={kit.fingerprint} />
            <FactRow label="Opens" value="Every backup made with this key" />
            <FactRow label="Lost with the phone" value="Backups cannot be opened" />
          </Card>
          <View className="flex-row flex-wrap justify-between gap-y-2">
            {groups.map((group, index) => (
              <View className="w-[23%] items-center rounded-lg bg-muted py-2" key={index}>
                <Text className="text-xs text-muted-foreground">{index + 1}</Text>
                <Text className="font-mono text-base font-semibold text-foreground">{group}</Text>
              </View>
            ))}
          </View>
          <View className="items-center">
            <Qr size={220} text={recoveryQrText(kit.code)} />
          </View>
          <Button
            label="Print the kit"
            onPress={() => printKit(kit).catch((error) => toastError("Could not print", readApiError(error)))}
            variant="outline"
          />
        </View>
      ) : null}
    </Sheet>
  );
}

type Stage = "key" | "scan" | "opening" | "preview" | "restoring";

/** Download → key → verify → decrypt on this phone → preview → confirm → add missing rows. */
function RestoreSheet({
  hostelId,
  onClose,
  phoneKey,
  run,
}: {
  hostelId: string;
  onClose: () => void;
  phoneKey: Uint8Array | null;
  run: BackupRun | null;
}) {
  const dates = useDates();
  const [stage, setStage] = useState<Stage>("key");
  const [code, setCode] = useState("");
  const [opened, setOpened] = useState<OpenedBackup | null>(null);
  const [progress, setProgress] = useState("");
  const [permission, requestPermission] = useCameraPermissions();
  // The camera reports every frame; only the first good read opens the backup.
  const scanned = useRef(false);

  // Reset on the way out, so the next backup opens at the key step.
  const close = useCallback(() => {
    setStage("key");
    setCode("");
    setOpened(null);
    onClose();
  }, [onClose]);

  const open = useCallback(
    async (secretKey: Uint8Array) => {
      if (!run) return;
      if (run.keyFingerprint && fingerprintOf(secretKey) !== run.keyFingerprint) {
        toastError("Wrong recovery key", `This backup needs key ${run.keyFingerprint}.`);
        return;
      }

      setStage("opening");
      try {
        const file = await downloadBackup(run);

        setOpened(await openBackup(file, run, hostelId, secretKey));
        setStage("preview");
      } catch (error) {
        toastError("Could not open the backup", readApiError(error));
        setStage("key");
      }
    },
    [hostelId, run],
  );

  const restore = useCallback(() => {
    if (!run || !opened) return;

    openConfirm({
      confirmLabel: "Restore",
      message: "Rows missing now are added back. Rows that still exist are left as they are; nothing is deleted.",
      onConfirm: async () => {
        setStage("restoring");
        let added = 0;
        let refused = 0;

        try {
          for (const [index, chunk] of opened.chunks.entries()) {
            setProgress(`${index + 1} of ${opened.chunks.length}`);

            const result = await restoreChunk(run.id, chunk);

            added += result.added;
            refused += result.refused;
          }

          toastSuccess("Restore finished", `${added} rows added back${refused ? ` · ${refused} not added` : ""}`);
          close();
        } catch (error) {
          toastError("Restore stopped", `${added} rows added before: ${readApiError(error)}`);
          setStage("preview");
        }
      },
      pin: true,
      title: "Restore from this backup?",
    });
  }, [close, opened, run]);

  const counts = Object.entries(opened?.counts ?? {}).filter(([, count]) => count > 0);

  return (
    <Sheet onClose={close} open={Boolean(run)} tall title="Restore">
      {run ? (
        <View className="gap-4">
          <Card className="gap-1">
            <FactRow label="Backup" value={dates.dateTime(run.createdAt)} />
            {run.keyFingerprint ? <FactRow label="Needs key" value={run.keyFingerprint} /> : null}
          </Card>

          {stage === "key" ? (
            <View className="gap-3">
              {phoneKey ? <Button label="Use the key on this phone" onPress={() => void open(phoneKey)} /> : null}
              <Input
                autoCapitalize="characters"
                label="Recovery code"
                multiline
                onChangeText={setCode}
                placeholder="14 groups of 4"
                value={code}
              />
              <Button
                disabled={code.replace(/\s/g, "").length < 56}
                label="Use this code"
                onPress={() => {
                  const key = keyFromKit(code);

                  if (key) void open(key);
                  else toastError("That code is not right", "Check each group against your kit.");
                }}
                variant={phoneKey ? "outline" : "primary"}
              />
              <Button
                label="Scan the kit's QR"
                onPress={async () => {
                  if (!permission?.granted && !(await requestPermission()).granted) {
                    toastError("Camera not allowed", "Type the code instead.");
                    return;
                  }

                  scanned.current = false;
                  setStage("scan");
                }}
                variant="outline"
              />
            </View>
          ) : null}

          {stage === "scan" ? (
            <View className="gap-3">
              <View className="aspect-square w-full overflow-hidden rounded-2xl bg-black">
                <QrCamera
                  active
                  onCode={(data) => {
                    const key = scanned.current ? null : keyFromKit(data);

                    if (!key) return;
                    scanned.current = true;
                    void open(key);
                  }}
                  style={{ flex: 1 }}
                  torch={false}
                />
              </View>
              <Button label="Type the code instead" onPress={() => setStage("key")} variant="outline" />
            </View>
          ) : null}

          {stage === "opening" ? <SkeletonCard rows={3} /> : null}

          {stage === "preview" || stage === "restoring" ? (
            <View className="gap-3">
              <SectionHeader title="In this backup" />
              <Card className="gap-1">
                {counts.map(([name, count]) => (
                  <FactRow key={name} label={name} value={String(count)} />
                ))}
              </Card>
              <Button
                disabled={stage === "restoring"}
                label={stage === "restoring" ? `Restoring ${progress}` : "Restore missing rows"}
                onPress={restore}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}
