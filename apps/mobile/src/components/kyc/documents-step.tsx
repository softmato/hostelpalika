import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph } from "@/components/ui/glyph";
import { isPdfReceipt, PdfPreview, readRemotePdf } from "@/components/receipt-preview";
import { StepSection } from "@/components/step-flow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { addKycDocument, removeKycDocument, type HostelKyc } from "@/lib/admin-api";
import { openConfirm } from "@/lib/confirm";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer, viewerSourceFor } from "@/lib/asset-viewer";
import { pickDocument, type PickedDocument } from "@/lib/document-picker";
import { BadgeTone } from "@/lib/status";
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";

const DOCUMENTS = [
  {
    caption: "Citizenship, passport or licence",
    label: "Your ID",
    match: (type: string) => !/pan|vat/i.test(type),
    type: "Owner ID proof",
  },
  {
    caption: "",
    label: "PAN / VAT",
    match: (type: string) => /pan|vat/i.test(type),
    type: "PAN / VAT document",
  },
] as const;

const DOCUMENT_STATUS: Record<HostelKyc["documents"][number]["status"], { label: string; tone: BadgeTone }> = {
  APPROVED: { label: "Verified", tone: "success" },
  PENDING: { label: "In review", tone: "warning" },
  REJECTED: { label: "Add again", tone: "danger" },
};

export function DocumentsStep({ data, onSaved }: { data: HostelKyc; onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState("");
  useKycDraft({ dirty: false, busy: Boolean(busy), save: async () => true });

  async function upload(type: string, label: string, source: "camera" | "file") {
    let asset: PickedDocument | null = null;

    try {
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) { toastError("Permission needed", "Allow the camera to photograph the document."); return; }
        const picked = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
        asset = picked.canceled ? null : picked.assets[0];
      } else {
        asset = await pickDocument();
      }
    } catch (error) {
      toastError("Could not open that", readApiError(error));
      return;
    }

    if (!asset) return;

    setBusy(type);

    try {
      const uploaded = await uploadPublicFile(asset, { label });

      if (!uploaded.claimToken || !uploaded.fileAssetId) throw new Error("Upload failed");

      await addKycDocument({
        claimToken: uploaded.claimToken,
        documentType: type,
        fileAssetId: uploaded.fileAssetId,
      });
      await onSaved();
      toastSuccess(`${label} added`);
    } catch (error) {
      toastError("Upload failed", readApiError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <View className="gap-4">
      {DOCUMENTS.map((doc) => {
        const rows = data.documents.filter((row) => doc.match(row.type));
        const viewable = rows.filter((row) => row.fileAssetId);

        return (
          <StepSection caption={doc.caption} key={doc.type} title={doc.label}>
            <View className="gap-3">
              {rows.map((row, at) => (
                <DocumentRow
                  key={`${row.type}-${at}`}
                  onRemove={row.canRemove ? () => openConfirm({
                    confirmLabel: "Remove",
                    destructive: true,
                    message: "You can upload it again any time.",
                    title: `Remove ${doc.label.toLowerCase()}?`,
                    onConfirm: async () => {
                      try { await removeKycDocument(row.id); await onSaved(); toastSuccess("Removed"); }
                      catch (error) { toastError("Could not remove it", readApiError(error)); }
                    },
                  }) : undefined}
                  onOpen={() =>
                    openAssetViewer(
                      viewable.map((item) => ({
                        assetId: item.fileAssetId ?? undefined,
                        caption: DOCUMENT_STATUS[item.status]?.label,
                        mimeType: item.mimeType ?? undefined,
                        title: item.fileName ?? item.type,
                      })),
                      Math.max(0, viewable.indexOf(row)),
                    )
                  }
                  row={row}
                />
              ))}
              <View className="flex-row gap-2">
                <Button className="flex-1" disabled={Boolean(busy)} icon="camera" label={busy === doc.type ? "Uploading…" : "Camera"} onPress={() => void upload(doc.type, doc.label, "camera")} variant="secondary" />
                <Button className="flex-1" disabled={Boolean(busy)} icon="document-upload" label="Upload file" onPress={() => void upload(doc.type, doc.label, "file")} variant="ghost" />
              </View>
            </View>
          </StepSection>
        );
      })}

      <View className="flex-row items-center gap-2">
        <Glyph color={colors.mutedForeground} name="lock-closed" size={18} />
        <Text variant="muted">Only you and our team see these</Text>
      </View>
    </View>
  );
}

/** One file across the whole row: the page itself, big enough to read, then where it stands. */
function DocumentRow({ onOpen, onRemove, row }: { onOpen: () => void; onRemove?: () => void; row: HostelKyc["documents"][number] }) {
  const { colors } = useAppTheme();
  const token = useAppSelector((state) => state.auth.accessToken);
  const status = DOCUMENT_STATUS[row.status] ?? DOCUMENT_STATUS.PENDING;
  const pdf = isPdfReceipt(row.mimeType ?? undefined);
  const source =
    row.fileAssetId && !pdf
      ? viewerSourceFor({ assetId: row.fileAssetId }, { baseUrl: API_BASE_URL, token })
      : null;

  return (
    <View className="gap-2">
      {pdf && row.fileAssetId ? (
        <PdfPreview height={200} label={`Open ${row.fileName ?? row.type}`} onPress={onOpen} read={() => readRemotePdf({ assetId: row.fileAssetId ?? undefined })} />
      ) : (
        <Pressable
          accessibilityLabel={`Open ${row.fileName ?? row.type}`}
          accessibilityRole="imagebutton"
          className="h-[200px] items-center justify-center overflow-hidden rounded-xl bg-muted active:opacity-80"
          disabled={!row.fileAssetId}
          onPress={onOpen}
        >
          {/* Under the image, so a file that will not load still reads as a document. */}
          <Glyph color={colors.mutedForeground} name="document-text" size={32} />
          {source ? (
            <Image
              cachePolicy="memory-disk"
              contentFit="contain"
              source={source}
              style={{ height: "100%", left: 0, position: "absolute", top: 0, width: "100%" }}
              transition={150}
            />
          ) : null}
        </Pressable>
      )}
      <View className="flex-row items-center gap-2">
        <Badge label={status.label} tone={status.tone} />
        <Text className={`flex-1 ${row.status === "REJECTED" ? "text-destructive" : ""}`} numberOfLines={2} variant="caption">
          {row.status === "REJECTED" && row.rejectionReason ? row.rejectionReason : row.fileName ?? row.type}
        </Text>
        {onRemove ? (
          <Pressable accessibilityLabel={`Remove ${row.fileName ?? row.type}`} accessibilityRole="button" className="size-9 items-center justify-center rounded-full active:opacity-70" hitSlop={8} onPress={onRemove}>
            <Glyph color={colors.destructive} name="trash" size={18} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
