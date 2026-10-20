import * as Application from "expo-application";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { type ApiEnvelope, readApiError, unwrap } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

const KINDS = [
  { label: "Feedback", value: "FEEDBACK" },
  { label: "Bug", value: "BUG" },
  { label: "Improvement", value: "IMPROVEMENT" },
] as const;

type Kind = (typeof KINDS)[number]["value"];
type Shot = { assetId: string; durationMs: number | null; uri: string; video: boolean };

/** The server's caps (`DEFAULT_IMAGE_BYTES` / `DEFAULT_VIDEO_BYTES`), checked before the upload starts. */
const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * MB;
const MAX_VIDEO_BYTES = 50 * MB;

/**
 * Send feedback — the app half of Help & support (the web's `support-dialog`).
 * A kind, one text box whose first line reads as the title, and up to four
 * screenshots or clips. Lands in Platform → Feedback, which plays the clips —
 * so unlike community posts, a video here needs no player on the phone. The
 * contacts themselves sit in every More tab (`SupportContact`), which links here.
 */
export default function HelpScreen() {
  const { colors } = useAppTheme();
  const [kind, setKind] = useState<Kind>("FEEDBACK");
  const [message, setMessage] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);

  async function addShot() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to attach a screenshot or video.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.8 });
    const picked = result.canceled ? null : result.assets[0];

    if (!picked) return;

    const video = picked.type === "video";
    const maxBytes = video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

    if (picked.fileSize && picked.fileSize > maxBytes) {
      toastError("Too large", `${video ? "Videos" : "Photos"} can be up to ${maxBytes / MB} MB.`);
      return;
    }

    setAdding(true);

    try {
      const assetId = await uploadAsset(
        { fileName: picked.fileName ?? undefined, fileSize: picked.fileSize, mimeType: picked.mimeType, uri: picked.uri },
        { label: video ? "Video" : "Screenshot" },
      );

      setShots((current) => [...current, { assetId, durationMs: picked.duration ?? null, uri: picked.uri, video }]);
    } catch (error) {
      toastError("Could not attach", readApiError(error, `The ${video ? "video" : "screenshot"} did not upload.`));
    } finally {
      setAdding(false);
    }
  }

  async function send() {
    setSending(true);

    try {
      unwrap(
        await api.post<ApiEnvelope<{ id: string }>>("/feedback", {
          appVersion: Application.nativeApplicationVersion ?? undefined,
          kind,
          message,
          page: "app",
          platform: "APP",
          screenshotAssetIds: shots.map((shot) => shot.assetId),
        }),
      );
      toastSuccess("Thanks — we have it");
      router.back();
    } catch (error) {
      toastError("Could not send", readApiError(error, "Try again in a moment."));
    } finally {
      setSending(false);
    }
  }

  return (
    <Screen
      footer={
        <View className="px-5 pb-4 pt-2">
          <Button
            disabled={message.trim().length < 3 || adding}
            label="Send"
            loading={sending}
            onPress={() => void send()}
          />
        </View>
      }
      header={<AppBar showBack title="Send feedback" />}
      scroll
    >
      <View className="gap-4 px-5 py-4">
        <Segmented onChange={setKind} options={KINDS} value={kind} />
        <Input
          hint="The first line reads as the title."
          label={kind === "BUG" ? "What went wrong?" : "What's on your mind?"}
          maxLength={4000}
          multiline
          onChangeText={setMessage}
          placeholder={kind === "BUG" ? "What you did, what you expected, what happened." : "Tell us in your own words."}
          style={{ minHeight: 140, textAlignVertical: "top" }}
          value={message}
        />
        <View className="gap-2">
          <Text variant="label">Screenshots or a video</Text>
          <Text variant="caption">Up to 4 · photos to 5 MB, videos to 50 MB</Text>
          <View className="flex-row flex-wrap gap-2">
            {shots.map((shot) => (
              <Pressable
                accessibilityLabel={shot.video ? "Remove video" : "Remove screenshot"}
                key={shot.assetId}
                onPress={() => setShots((current) => current.filter((item) => item.assetId !== shot.assetId))}
              >
                {shot.video ? (
                  <View
                    className="items-center justify-center gap-1 rounded-xl bg-muted"
                    style={{ height: 96, width: 72 }}
                  >
                    <Glyph color={colors.mutedForeground} name="videocam" size={24} />
                    {shot.durationMs ? <Text variant="caption">{clipLength(shot.durationMs)}</Text> : null}
                  </View>
                ) : (
                  <Image source={{ uri: shot.uri }} style={{ borderRadius: 12, height: 96, width: 72 }} />
                )}
              </Pressable>
            ))}
            {shots.length < 4 ? (
              <Pressable
                accessibilityLabel="Add a screenshot or video"
                className="items-center justify-center rounded-xl border border-dashed border-border"
                disabled={adding}
                onPress={() => void addShot()}
                style={{ height: 96, width: 72 }}
              >
                <Glyph color={colors.mutedForeground} name="add" size={24} />
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Screen>
  );
}

/** "0:42" — a clip's length under its tile. */
function clipLength(durationMs: number) {
  const seconds = Math.round(durationMs / 1000);

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
