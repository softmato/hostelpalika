import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { adoptRoleChange } from "@/lib/auth-session";
import { openConfirm } from "@/lib/confirm";
import { downloadToDevice } from "@/lib/documents";
import {
  getHeldFileLink,
  getHeldFiles,
  type HeldFiles,
  type HeldHostel,
  reclaimHostel,
} from "@/lib/registration-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { PLATFORM_NAME } from "@hostel/brand/brand";

function size(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const RECORD_ORDER = ["excel", "csv", "json"] as const;
const RECORD_LABELS = {
  csv: { label: "All CSV files", note: "Every section, one .zip" },
  excel: { label: "Excel workbook", note: "Every section, one sheet each" },
  json: { label: "JSON", note: "For other software" },
} as const;

/** `photo.jpg` → `["photo", "jpg"]`, for the downloader's separate name and extension. */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");

  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, "bin"];
}

/**
 * A hostel the owner took off the platform, still claimable while its data is
 * held (docs/HOSTEL_LEAVE_PLATFORM.md). Shown on Profile, which is where a
 * former owner lands: leaving made them a public account again. Its original
 * files come down either way the owner prefers — all at once as a ZIP, or
 * picked one by one.
 */
export function HeldHostelCard({ hostel }: { hostel: HeldHostel }) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const [files, setFiles] = useState<HeldFiles | null>(null);
  const [picking, setPicking] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  // Loaded with the card, for the records buttons — the first thing an owner leaving needs.
  const overview = useResource<HeldFiles>(
    useCallback(() => getHeldFiles(hostel.requestId), [hostel.requestId]),
    { cacheKey: `account:held-files:${hostel.requestId}` },
  );
  const allRecords = (overview.data?.files ?? []).filter((file) => file.record);
  const records = allRecords
    .filter((file) => file.record !== "section")
    .sort(
      (a, b) =>
        RECORD_ORDER.indexOf(a.record as (typeof RECORD_ORDER)[number]) -
        RECORD_ORDER.indexOf(b.record as (typeof RECORD_ORDER)[number]),
    );
  // One CSV per section, Residents and Payments first.
  const sections = allRecords
    .filter((file) => file.record === "section")
    .sort((a, b) => (a.section?.order ?? 99) - (b.section?.order ?? 99));

  const claim = () =>
    openConfirm({
      confirmLabel: "Claim it back",
      message: `${hostel.hostelName} comes back on ${PLATFORM_NAME} exactly as you left it — portal, residents and data.`,
      onConfirm: async () => {
        try {
          await reclaimHostel(hostel.requestId);
          toastSuccess("Your hostel is back", hostel.hostelName);

          if (!(await adoptRoleChange())) {
            router.replace("/(admin)");
          }
        } catch (error) {
          toastError("Could not claim it back", readApiError(error));
        }
      },
      title: `Claim ${hostel.hostelName} back?`,
    });

  const loadFiles = async (fresh = false) => {
    if (files && !fresh) return files;

    setLoadingFiles(true);

    try {
      const loaded = await getHeldFiles(hostel.requestId);
      setFiles(loaded);
      return loaded;
    } catch (error) {
      toastError("Could not load your files", readApiError(error));
      return null;
    } finally {
      setLoadingFiles(false);
    }
  };

  /** Every part, one after another — each lands through the global downloader. */
  const downloadAll = async () => {
    // Fresh each time: the counts left change with every download.
    setFiles(null);
    const loaded = await loadFiles(true);

    if (!loaded?.parts.length) {
      if (loaded) toastSuccess("No files to download", "Nothing was uploaded");
      return;
    }

    const open = loaded.parts.filter((part) => part.left > 0);

    if (open.length === 0) {
      toastError("Downloaded 3 times today", "You can download your files again tomorrow.");
      return;
    }

    for (const part of open) {
      await downloadToDevice({
        extension: "zip",
        fileName: loaded.parts.length > 1 ? `${hostel.hostelName} files part ${part.part}` : `${hostel.hostelName} files`,
        label: loaded.parts.length > 1 ? `Files, part ${part.part} of ${loaded.parts.length}` : "Your files",
        mimeType: "application/zip",
        url: `${API_BASE_URL}/api/v1/account/hostel-leave/${hostel.requestId}/files/zip?part=${part.part}`,
      }).catch((error) => toastError("Download failed", readApiError(error)));
    }
  };

  const downloadOne = async (file: HeldFiles["files"][number]) => {
    try {
      const [name, extension] = splitName(file.name);

      await downloadToDevice({
        // A presigned R2 link: no token on it, or R2 refuses the signature.
        authenticated: false,
        extension,
        fileName: name,
        label: file.name,
        mimeType: "application/octet-stream",
        url: await getHeldFileLink(hostel.requestId, file.id),
      });
    } catch (error) {
      toastError("Download failed", readApiError(error));
    }
  };

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
          <Glyph color={colors.primary} name="business" size={22} />
        </View>
        <View className="flex-1">
          <Text numberOfLines={1} variant="label">
            {hostel.hostelName}
          </Text>
          <Text variant="caption">
            {hostel.canClaim
              ? `Held until ${dates.date(hostel.holdUntil)}`
              : `Files until ${dates.date(hostel.filesUntil)} · can no longer be claimed back`}
          </Text>
        </View>
      </View>
      {hostel.canClaim ? <Button icon="refresh" label="Claim hostel back" onPress={claim} /> : null}
      {records.length > 0 ? (
        <View className="gap-2 rounded-2xl bg-brand-soft p-3">
          <Text variant="label">Your records</Text>
          <Text variant="caption">Residents, rooms, bills, payments, expenses and more — from your first day.</Text>
          {records.map((file) => (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-3 rounded-xl border border-border bg-card p-3 active:opacity-70"
              key={file.id}
              onPress={() => void downloadOne(file)}
            >
              <Glyph color={colors.primary} name="download" size={18} />
              <View className="flex-1">
                <Text variant="label">{RECORD_LABELS[file.record as keyof typeof RECORD_LABELS].label}</Text>
                <Text variant="caption">{`${RECORD_LABELS[file.record as keyof typeof RECORD_LABELS].note} · ${size(file.sizeBytes)}`}</Text>
              </View>
            </Pressable>
          ))}
          {sections.length > 0 ? (
            <>
              <Text className="pt-1" variant="label">
                Or one CSV at a time
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {sections.map((file) => (
                  <Pressable
                    accessibilityLabel={`Download ${file.section?.label ?? file.name} CSV`}
                    accessibilityRole="button"
                    className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 active:opacity-70"
                    key={file.id}
                    onPress={() => void downloadOne(file)}
                  >
                    <Glyph color={colors.primary} name="download" size={14} />
                    <Text variant="caption">{file.section?.label ?? file.name}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          icon="download"
          label="All files"
          loading={loadingFiles && !picking}
          onPress={() => void downloadAll()}
          variant="outline"
        />
        <Button
          className="flex-1"
          icon="list"
          label="Choose files"
          onPress={() => {
            setPicking(true);
            void loadFiles();
          }}
          variant="outline"
        />
      </View>

      <Sheet onClose={() => setPicking(false)} open={picking} tall title="Your files">
        {files ? (
          <ScrollView>
            <Text className="pb-2" variant="caption">
              {`${files.files.length} files · ${size(files.totalBytes)} · tap one to download · ${files.fileLinksLeft} left today`}
            </Text>
            {files.files.filter((row) => !row.record).map((file, index, uploads) => (
              <View key={file.id}>
                {/* A heading where the group changes — the server sends them in group order. */}
                {uploads[index - 1]?.group !== file.group ? (
                  <Text className="pb-1 pt-4" variant="label">
                    {`${file.group} · ${uploads.filter((row) => row.group === file.group).length}`}
                  </Text>
                ) : null}
              <Pressable
                accessibilityRole="button"
                className="flex-row items-center gap-3 border-b border-border py-3 active:opacity-70"
                onPress={() => void downloadOne(file)}
              >
                <Glyph
                  color={file.group === "Records" ? colors.primary : colors.mutedForeground}
                  name={file.group === "Records" ? "download" : "document-text"}
                  size={18}
                />
                <Text className="flex-1" numberOfLines={1} variant="body">
                  {file.name}
                </Text>
                <Text variant="caption">{size(file.sizeBytes)}</Text>
              </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : (
          <Text variant="muted">Loading your files…</Text>
        )}
      </Sheet>
    </Card>
  );
}
