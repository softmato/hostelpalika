import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Camera, ImagePlus } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { GuidedCapture } from "@/components/guided-capture";
import { type PickedImage, uploadApplicantImage } from "@/components/manage/applicant-photo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import {
  type ApplicantDocuments,
  type ApplicantPhoto,
  DOCUMENT_KINDS,
  DOCUMENT_LABELS,
  type DocumentKind,
} from "@/lib/resident-details";
import { toastError } from "@/lib/toast";

/**
 * Citizenship or ID scans on the admission form, one row per document.
 *
 * Their own is always required; the guardian's says "Required" only when the
 * hostel turned it on (Settings → Form details). Each is photographed through
 * the guided camera's document frame or picked from the gallery, and uploaded
 * the moment it is chosen — the same anonymous private upload as the photo.
 */
export function ApplicantDocumentsPicker({
  guardianRequired,
  onChange,
  value,
}: {
  guardianRequired: boolean;
  onChange: (kind: DocumentKind, document: ApplicantPhoto | null) => void;
  value: ApplicantDocuments;
}) {
  const { colors } = useAppTheme();
  const [camera, setCamera] = useState<DocumentKind | null>(null);

  async function attach(kind: DocumentKind, picked: PickedImage) {
    onChange(kind, { uri: picked.uri });

    try {
      onChange(kind, await uploadApplicantImage(picked, DOCUMENT_LABELS[kind]));
    } catch (error) {
      onChange(kind, null);
      toastError("Document not added", readApiError(error, "Try again."));
    }
  }

  async function pickFromGallery(kind: DocumentKind) {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to pick the document.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    const picked = result.canceled ? null : result.assets[0];

    if (picked) {
      await attach(kind, {
        height: picked.height,
        mimeType: picked.mimeType ?? undefined,
        uri: picked.uri,
        width: picked.width,
      });
    }
  }

  return (
    <View className="gap-4">
      {DOCUMENT_KINDS.map((kind, index) => {
        const document = value[kind];
        const uploading = Boolean(document && !document.fileAssetId);
        const required = kind === "APPLICANT_ID" || guardianRequired;

        return (
          <View className={`gap-3 ${index > 0 ? "border-t border-border pt-4" : ""}`} key={kind}>
            <View className="flex-row items-center gap-3">
              <View
                className="items-center justify-center overflow-hidden rounded-xl border border-border bg-muted"
                style={{ height: 52, opacity: uploading ? 0.5 : 1, width: 82 }}
              >
                {document ? (
                  <Image contentFit="cover" source={{ uri: document.uri }} style={{ height: "100%", width: "100%" }} />
                ) : (
                  <Ionicons color={colors.mutedForeground} name="card-outline" size={24} />
                )}
              </View>
              <View className="flex-1 gap-1">
                <Text variant="label">{DOCUMENT_LABELS[kind]}</Text>
                <View className="flex-row">
                  {uploading ? (
                    <Text variant="caption">Uploading…</Text>
                  ) : document ? (
                    <Badge label="Added" tone="success" />
                  ) : (
                    <Badge label={required ? "Required" : "Optional"} tone={required ? "warning" : "neutral"} />
                  )}
                </View>
              </View>
            </View>

            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button
                  disabled={uploading}
                  icon={Camera}
                  label={document ? "Take again" : "Take photo"}
                  onPress={() => setCamera(kind)}
                  size="sm"
                  variant="outline"
                />
              </View>
              <View className="flex-1">
                <Button
                  disabled={uploading}
                  icon={ImagePlus}
                  label="Upload"
                  onPress={() => void pickFromGallery(kind)}
                  size="sm"
                  variant="outline"
                />
              </View>
            </View>
          </View>
        );
      })}

      <GuidedCapture
        onCancel={() => setCamera(null)}
        onConfirm={(uri) => {
          const kind = camera;

          setCamera(null);

          if (kind) {
            void attach(kind, { mimeType: "image/jpeg", uri });
          }
        }}
        shape="document"
        visible={camera !== null}
      />
    </View>
  );
}
