import * as Speech from "expo-speech";
import { useEffect, useRef } from "react";

import type { Guidance } from "@/hooks/use-guidance";
import { spokenCue, startCue } from "@/lib/navigation";
import type { RouteMode } from "@/lib/routing";

/**
 * Turn-by-turn, out loud.
 *
 * The phone's own text-to-speech engine (`expo-speech`), so it costs nothing,
 * needs no key and works offline once the voice is installed. What is said and
 * when is `spokenCue` / `startCue` in `lib/navigation.ts`, where it is tested;
 * this only remembers what has been said and owns the speaker.
 *
 * Muted, the cues are still marked said — unmuting picks up at the next one
 * rather than reading out a turn from two streets ago.
 *
 * Indian English: the closest accent most Nepali phones carry a voice for, and
 * it reads Kathmandu street names better than the US default. A phone without
 * it falls back to its own default voice.
 */
const VOICE: Speech.SpeechOptions = { language: "en-IN" };

export function useVoiceGuidance({
  gateNote,
  guidance,
  mode,
  muted,
  nearGate,
  place,
}: {
  /** The hostel's "find the gate" note, read near the door and on arrival. */
  gateNote?: string;
  guidance: Guidance;
  mode: RouteMode;
  muted: boolean;
  /** Within 200 m of the hostel. */
  nearGate: boolean;
  /** The hostel being navigated to, as it is spoken. */
  place: string;
}) {
  const { rerouting, status, step } = guidance;
  const spoken = useRef(new Set<string>());
  const started = useRef(false);

  // A new session starts with nothing said; stopping silences the speaker.
  useEffect(() => {
    if (status === "idle") {
      spoken.current.clear();
      started.current = false;
      void Speech.stop();
    }
  }, [status]);

  useEffect(() => {
    if (status !== "guiding") {
      return;
    }

    const lines: string[] = [];

    if (!started.current) {
      started.current = true;
      lines.push(startCue(step, mode, place));
    }

    const cue = step ? spokenCue(step, mode, spoken.current) : null;

    if (cue) {
      spoken.current.add(cue.key);
      lines.push(cue.text);
    }

    if (!muted) {
      for (const line of lines) {
        Speech.speak(line, VOICE);
      }
    }
  }, [mode, muted, place, status, step]);

  useEffect(() => {
    if (rerouting && !muted) {
      Speech.speak("Rerouting", VOICE);
    }
  }, [muted, rerouting]);

  useEffect(() => {
    if (status === "arrived" && !muted) {
      Speech.speak(`You have arrived at ${place}.${gateNote ? ` ${gateNote}` : ""}`, VOICE);
    }
  }, [gateNote, muted, place, status]);

  // Once per trip, as the hostel comes within 200 m.
  const gateSaid = useRef(false);

  useEffect(() => {
    if (status === "idle") {
      gateSaid.current = false;
      return;
    }

    if (nearGate && gateNote && status === "guiding" && !gateSaid.current) {
      gateSaid.current = true;

      if (!muted) {
        Speech.speak(`Finding the gate: ${gateNote}`, VOICE);
      }
    }
  }, [gateNote, muted, nearGate, status]);

  useEffect(() => {
    if (muted) {
      void Speech.stop();
    }
  }, [muted]);

  // Leaving the screen mid-sentence stops the sentence.
  useEffect(
    () => () => {
      void Speech.stop();
    },
    [],
  );
}
