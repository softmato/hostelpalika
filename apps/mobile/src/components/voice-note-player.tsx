import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { API_BASE_URL } from "@/lib/api";
import { formatDuration } from "@/lib/voice-note";

/**
 * Playing back a maintenance voice note, on either side of the job.
 *
 * ## Why it resolves the URL first instead of just playing the asset route
 *
 * `files/{assetId}/url` answers **302 to a presigned R2 URL**, and the bearer
 * token this app has to send is a token for *us*, not for storage. A player
 * handed the asset route follows the redirect with those headers still attached,
 * and R2 reads any `Authorization` header as SigV4 and rejects the request
 * outright — the same trap `lib/asset-viewer.ts` documents from the other side.
 * It fails as a player that spins and then does nothing, which is
 * indistinguishable from a bad recording.
 *
 * So this asks for `?format=json`, which runs exactly the same authorization and
 * hands back the resolved URL as data. The player then talks to R2 with no
 * headers of ours at all.
 *
 * ## One fetch, on mount
 *
 * A presigned URL is good for long enough that re-resolving on every press would
 * be a round trip spent on nothing. A note is played once, or twice.
 */
export function VoiceNotePlayer({ assetId }: { assetId: string }) {
  const { colors } = useAppTheme();
  const token = useAppSelector((state) => state.auth.accessToken);

  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/v1/files/${assetId}/url?format=json`,
          { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
        );

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        const body = (await response.json()) as { data?: { url?: string } };

        if (cancelled) {
          return;
        }

        if (body.data?.url) {
          setUrl(body.data.url);
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [assetId, token]);

  const toggle = useCallback(() => {
    if (status.playing) {
      player.pause();
      return;
    }

    // Rewind a finished clip, or the second press plays nothing and reads as a
    // broken recording. Same reason the recorder does it.
    if (status.currentTime >= (status.duration || 0) - 0.05) {
      player.seekTo(0);
    }

    player.play();
  }, [player, status.currentTime, status.duration, status.playing]);

  const elapsed = formatDuration((status.currentTime || 0) * 1000);
  const total = status.duration ? formatDuration(status.duration * 1000) : null;

  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2.5">
      <Pressable
        accessibilityLabel={
          failed
            ? "The voice note could not be loaded"
            : status.playing
              ? "Pause the voice note"
              : "Play the voice note"
        }
        accessibilityRole="button"
        accessibilityState={{ disabled: failed || !url }}
        className={`h-10 w-10 items-center justify-center rounded-full ${
          failed ? "bg-muted" : "bg-primary"
        } ${failed || !url ? "opacity-50" : "active:opacity-80"}`}
        disabled={failed || !url}
        hitSlop={6}
        onPress={toggle}
      >
        {!url && !failed ? (
          <ActivityIndicator color={colors.primaryForeground} size="small" />
        ) : (
          <Glyph
            color={failed ? colors.mutedForeground : colors.primaryForeground}
            name={failed ? "alert-circle" : status.playing ? "pause" : "play"}
            size={18}
          />
        )}
      </Pressable>

      <View className="flex-1">
        <Text variant="label">Voice note</Text>
        <Text variant="caption">
          {failed
            ? "It could not be loaded. Ask the hostel to describe the job."
            : total
              ? `${elapsed} / ${total}`
              : "Loading the recording…"}
        </Text>
      </View>

      <Glyph color={colors.mutedForeground} name="mic" size={16} />
    </View>
  );
}
