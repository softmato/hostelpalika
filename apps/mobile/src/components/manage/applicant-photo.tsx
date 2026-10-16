import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { View } from "react-native";

import { GuidedCapture } from "@/components/guided-capture";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { prepareEvidenceForUpload } from "@/lib/evidence-image";
import { uploadPublicFile } from "@/lib/public-uploads";
import type { ApplicantPhoto } from "@/lib/resident-details";
import { toastError } from "@/lib/toast";

export type PickedImage = { height?: number; mimeType?: string; uri: string; width?: number };

/**
 * Up through the anonymous private upload, kept to 1600px so a phone photo
 * never meets the 5 MB cap. Resolves with the id and claim token the form sends.
 */
export async function uploadApplicantImage(picked: PickedImage, label: string): Promise<ApplicantPhoto> {
  const file = await prepareEvidenceForUpload({ mimeType: picked.mimeType ?? "image/jpeg", ...picked });
  const uploaded = await uploadPublicFile(
    { fileName: file.fileName ?? "photo.jpg", mimeType: file.mimeType ?? "image/jpeg", uri: file.uri },
    { label, visibility: "private" },
  );

  if (!uploaded.fileAssetId || !uploaded.claimToken) {
    throw new Error(`The ${label.toLowerCase()} did not upload.`);
  }

  return { claimToken: uploaded.claimToken, fileAssetId: uploaded.fileAssetId, uri: picked.uri };
}

/**
 * The face on the admission form — taken with the guided face camera the ID
 * card uses, or picked from the gallery with a square crop.
 *
 * Uploaded the moment it is chosen, through the anonymous private upload, so it
 * works for the person filling the Form QR with no account as well as for the
 * warden. `value` without a `fileAssetId` is "still uploading"; the screen
 * holds its send button on that.
 */
export function ApplicantPhotoPicker({
  onChange,
  value,
}: {
  onChange: (photo: ApplicantPhoto | null) => void;
  value: ApplicantPhoto | null;
}) {
  const { colors } = useAppTheme();
  const [camera, setCamera] = useState(false);
  const uploading = Boolean(value && !value.fileAssetId);

  async function attach(picked: PickedImage) {
    onChange({ uri: picked.uri });

    try {
      onChange(await uploadApplicantImage(picked, "Photo"));
    } catch (error) {
      onChange(null);
      toastError("Photo not added", readApiError(error, "Try again."));
    }
  }

  async function pickFromGallery() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to pick a photo.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ["images"],
      quality: 0.85,
    });
    const picked = result.canceled ? null : result.assets[0];

    if (picked) {
      await attach({
        height: picked.height,
        mimeType: picked.mimeType ?? undefined,
        uri: picked.uri,
        width: picked.width,
      });
    }
  }

  return (
    <View className="flex-row items-center gap-4">
      <View
        className="items-center justify-center overflow-hidden rounded-full border-2 border-primary bg-muted"
        style={{ height: 96, opacity: uploading ? 0.5 : 1, width: 96 }}
      >
        {value ? (
          <Image contentFit="cover" source={{ uri: value.uri }} style={{ height: "100%", width: "100%" }} />
        ) : (
          <Glyph color={colors.mutedForeground} name="person" size={44} />
        )}
      </View>

      <View className="flex-1 gap-2">
        <Button
          disabled={uploading}
          icon="camera"
          label={value ? "Take again" : "Take photo"}
          onPress={() => setCamera(true)}
          size="sm"
        />
        <Button
          disabled={uploading}
          icon="image-add"
          label="Upload photo"
          onPress={() => void pickFromGallery()}
          size="sm"
          variant="outline"
        />
        {uploading ? <Text variant="caption">Uploading the photo…</Text> : null}
      </View>

      <GuidedCapture
        onCancel={() => setCamera(false)}
        onConfirm={(uri) => {
          setCamera(false);
          void attach({ mimeType: "image/jpeg", uri });
        }}
        shape="face"
        visible={camera}
      />
    </View>
  );
}
