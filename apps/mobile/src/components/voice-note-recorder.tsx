import {
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { toastError } from "@/lib/toast";
import {
  formatDuration,
  isUsableRecording,
  recorderHint,
  VOICE_NOTE_MAX_MS,
  type VoiceNoteContext,
} from "@/lib/voice-note";

/**
 * Record the problem, hear it back, do it again or throw it away.
 *
 * ## Why speaking beats typing here
 *
 * The person who can see the fault is a warden standing in front of it; the
 * person who has to understand it is a contractor reading a line somebody typed
 * one-handed. Twenty seconds of *"it is the pipe under the sink in 204, not the
 * tap, and it only drips when the pump runs"* carries what a title never will,
 * and it takes a fifth as long to produce.
 *
 * It does **not** transcribe. Nothing in the product does speech-to-text, and
 * the recording is not trying to fill in the form — the typed sentence is still
 * what the queue, the search and the provider's job list read. This is the
 * detail underneath it.
 *
 * ## Nothing is uploaded until the request is raised
 *
 * The file sits in the app's cache while it is being reviewed, and the upload
 * happens on the confirm step. Recording straight to storage would leave an
 * orphaned asset behind every time somebody re-recorded or changed their mind,
 * and there is no sweep that would ever collect them.
 *
 * That is also why re-record simply overwrites: the old file was never anywhere
 * but this phone.
 *
 * ## The cap stops the recorder, it does not warn about it
 *
 * Three minutes, enforced here rather than by asking the person to watch a
 * clock — a phone left face-down in a pocket is the case this exists for, and a
 * warning is no use to a pocket. `VOICE_NOTE_MAX_MS` explains the number.
 */

/**
 * Voice, not music.
 *
 * `RecordingPresets.HIGH_QUALITY` is 44.1 kHz stereo at 128 kbps, which for a
 * warden describing a leaking pipe is roughly sixteen times more data than the
 * words carry — a two-minute note would be about 2 MB, uploaded over a Nepali
 * mobile connection, to be listened to once on a phone speaker.
 *
 * Mono at 32 kbps and 22.05 kHz is the shape every voice-messaging app settles
 * on: speech is intelligible well below this, and the file is around 500 KB for
 * the same two minutes. The container stays `.m4a` on both platforms, which is
 * what the server's allowlist and its byte sniffer expect — see
 * `DEFAULT_AUDIO_MIME_TYPES`.
 */
export const VOICE_NOTE_RECORDING: RecordingOptions = {
  android: {
    audioEncoder: "aac",
    extension: ".m4a",
    outputFormat: "mpeg4",
  },
  bitRate: 32_000,
  extension: ".m4a",
  ios: {
    audioQuality: AudioQuality.MEDIUM,
    extension: ".m4a",
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
    outputFormat: IOSOutputFormat.MPEG4AAC,
  },
  numberOfChannels: 1,
  sampleRate: 22_050,
  web: {
    bitsPerSecond: 32_000,
    mimeType: "audio/webm",
  },
};

export type VoiceNote = { durationMs: number; uri: string };

export function VoiceNoteRecorder({
  context = "maintenance",
  disabled = false,
  label = "Say what is wrong",
  note,
  onChange,
  showHint = true,
}: {
  /**
   * Who hears it. Only the sentences change — see `recorderHint`.
   *
   * Defaulted rather than required because the maintenance screen was here
   * first and its copy is the default; a second caller states its own.
   */
  context?: VoiceNoteContext;
  /** True while the request is being submitted — the file is being uploaded. */
  disabled?: boolean;
  /**
   * The field label above the control, or `null` on a screen that already says
   * what this is — the complaint screen puts the recorder inside a section it
   * has titled, and a second heading two lines below the first reads as two
   * separate controls.
   */
  label?: string | null;
  note: VoiceNote | null;
  onChange: (note: VoiceNote | null) => void;
  /**
   * The changing line underneath — the countdown, the play-it-back nudge.
   *
   * Off for a screen that already carries one line of guidance and does not
   * want a second: the complaint screen says what to do once, under the send
   * button, and repeating it here was a paragraph where the camera should be.
   * The control still says everything load-bearing in its own two lines
   * ("Recording" and the clock), so nothing is lost but the prose.
   */
  showHint?: boolean;
}) {
  const recorder = useAudioRecorder(VOICE_NOTE_RECORDING);
  const recorderState = useAudioRecorderState(recorder, 250);
  const player = useAudioPlayer(note?.uri ?? null);
  const playerStatus = useAudioPlayerStatus(player);

  const [preparing, setPreparing] = useState(false);
  /* Guards the auto-stop below, which can fire on two consecutive polls. */
  const stopping = useRef(false);

  const recording = recorderState.isRecording;
  const durationMs = recorderState.durationMillis ?? 0;

  const stop = useCallback(async () => {
    if (stopping.current) {
      return;
    }

    stopping.current = true;

    try {
      await recorder.stop();

      const uri = recorder.uri;

      /*
       * `durationMillis` is read *before* the stop resolves, because the state
       * hook polls and its last sample is the length of what was captured; the
       * recorder's own counter resets. A tap that starts and stops produces a
       * fraction of a second of silence, which is worse than no recording at all
       * — see `isUsableRecording`.
       */
      if (!uri || !isUsableRecording(durationMs)) {
        onChange(null);
        toastError("Too short", "Hold on and describe the problem out loud.");
        return;
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onChange({ durationMs, uri });
    } catch {
      onChange(null);
      toastError("Recording failed", "The microphone did not hand anything back.");
    } finally {
      stopping.current = false;
    }
  }, [durationMs, onChange, recorder]);

  /* The cap. Fires from the same poll that drives the countdown on screen. */
  useEffect(() => {
    if (recording && durationMs >= VOICE_NOTE_MAX_MS) {
      void stop();
    }
  }, [durationMs, recording, stop]);

  const start = useCallback(async () => {
    setPreparing(true);

    try {
      const permission = await requestRecordingPermissionsAsync();

      if (!permission.granted) {
        toastError(
          "Microphone is off",
          "Allow the microphone in your phone's settings to record a note.",
        );
        return;
      }

      /*
       * iOS routes recording through the audio session, and without
       * `allowsRecording` the recorder starts and captures silence — a failure
       * that looks exactly like a working recorder until it is played back.
       */
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      player.pause();
      onChange(null);

      await recorder.prepareToRecordAsync();
      recorder.record();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      toastError("Could not start", "The microphone is busy or unavailable.");
    } finally {
      setPreparing(false);
    }
  }, [onChange, player, recorder]);

  const remove = useCallback(() => {
    player.pause();
    onChange(null);
  }, [onChange, player]);

  const togglePlayback = useCallback(() => {
    if (playerStatus.playing) {
      player.pause();
      return;
    }

    /*
     * Rewind first. A player left at the end of the clip plays nothing when
     * pressed again, which reads as a broken recording rather than as a
     * finished one.
     */
    if (playerStatus.currentTime >= (playerStatus.duration || 0) - 0.05) {
      player.seekTo(0);
    }

    player.play();
  }, [player, playerStatus.currentTime, playerStatus.duration, playerStatus.playing]);

  const hint = recorderHint({
    context,
    durationMs,
    hasRecording: note !== null,
    recording,
  });

  return (
    <View className="gap-2">
      {label ? <Text variant="label">{label}</Text> : null}

      <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
        {note && !recording ? (
          <>
            <RoundButton
              busy={false}
              icon={playerStatus.playing ? "pause" : "play"}
              label={playerStatus.playing ? "Pause the recording" : "Play the recording"}
              onPress={togglePlayback}
              tone="brand"
            />

            <View className="flex-1">
              <Text variant="label">{formatDuration(note.durationMs)}</Text>
              <Text variant="caption">Voice note ready</Text>
            </View>

            <RoundButton
              busy={preparing}
              disabled={disabled}
              icon="refresh"
              label="Record it again"
              onPress={() => void start()}
              tone="muted"
            />
            <RoundButton
              busy={false}
              disabled={disabled}
              icon="trash"
              label="Delete the recording"
              onPress={remove}
              tone="danger"
            />
          </>
        ) : (
          <>
            <RoundButton
              busy={preparing}
              disabled={disabled}
              icon={recording ? "stop" : "mic"}
              label={recording ? "Stop recording" : "Record a voice note"}
              onPress={() => void (recording ? stop() : start())}
              tone={recording ? "danger" : "brand"}
            />

            <View className="flex-1">
              <Text variant="label">
                {recording ? formatDuration(durationMs) : "Record a voice note"}
              </Text>
              <Text variant="caption">
                {recording ? "Tap the square to finish" : "Optional"}
              </Text>
            </View>
          </>
        )}
      </View>

      {showHint ? <Text variant="caption">{hint}</Text> : null}
    </View>
  );
}

/**
 * The circular control the recorder is built from.
 *
 * Round rather than a pill because all four of its uses are one glyph with no
 * label, and because the record button is the one control on this sheet that
 * has to be findable without reading — which is the whole argument for a
 * recorder in the first place.
 */
function RoundButton({
  busy,
  disabled = false,
  icon,
  label,
  onPress,
  tone,
}: {
  busy: boolean;
  disabled?: boolean;
  icon: GlyphName;
  label: string;
  onPress: () => void;
  tone: "brand" | "danger" | "muted";
}) {
  const { colors } = useAppTheme();

  const background =
    tone === "brand" ? "bg-primary" : tone === "danger" ? "bg-destructive" : "bg-muted";
  const glyph =
    tone === "muted" ? colors.mutedForeground : colors.primaryForeground;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      className={`h-11 w-11 items-center justify-center rounded-full ${background} ${
        disabled || busy ? "opacity-50" : "active:opacity-80"
      }`}
      disabled={disabled || busy}
      hitSlop={6}
      onPress={onPress}
    >
      <Glyph color={glyph} name={icon} size={20} />
    </Pressable>
  );
}
