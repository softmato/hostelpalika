/**
 * The system notification that reports an upload while the app is not on screen.
 *
 * ## Why this exists next to the toaster
 *
 * `<UploadToaster />` already shows every transfer in the app, and that is the
 * web's universal-uploader rule ported. But a phone is not a browser tab: the
 * moment someone photographs a rent receipt and switches to their banking app
 * to check the amount, the toaster is gone and the only honest answer to "did my
 * evidence send?" is a notification in the shade. This is the native half of the
 * same pipeline — same queue, same rows, same labels — rendered where the user
 * can still see it.
 *
 * ## One notification, not one per file
 *
 * Attaching three photos to a complaint must not produce three notifications
 * that each vibrate. The rows are folded into a single **batch** with an
 * aggregate percentage, posted under one identifier so each update replaces the
 * last rather than stacking.
 *
 * ## Why the percentage is floored to a step
 *
 * `onProgress` fires per network chunk — dozens of times a second. Reposting a
 * notification that often is an IPC call per chunk and a visibly stuttering
 * shade. Flooring to `PERCENT_STEP` caps the batch at ~20 reposts however big
 * the file is, and flooring rather than rounding means the notification never
 * claims 100% while bytes are still moving.
 *
 * ## Why the terminal notice outlives the queue
 *
 * `pruneUploads` drops a succeeded row after 2.5 seconds, which is the right
 * lifetime for a toast on a screen the user is looking at and far too short for
 * a notification they are meant to find later. So the batch is tallied as it
 * runs and the finished summary is built from the tally, not from rows that no
 * longer exist.
 *
 * Kept free of React Native so it can be tested; `lib/upload-notifier.ts` is the
 * half that talks to `expo-notifications`.
 */

import {
  isUploadActive,
  type TransferDirection,
  type UploadRow,
  uploadRowFraction,
} from "@/lib/upload-queue";

/** One identifier, so every update replaces the previous notification. */
export const UPLOAD_NOTIFICATION_ID = "hostelhub-upload-progress";

/**
 * The terminal notice — done or failed — under an identifier of its own.
 *
 * It used to reuse `UPLOAD_NOTIFICATION_ID`, which made "Downloaded" an *update*
 * of the progress notification. Android sheds updates once an app passes ~5
 * enqueues a second, and exempts only notifications carrying a completed
 * progress bar — ours carry text, so the one post that mattered was the one
 * dropped after a burst of percentages. That was the "arrives late, or never,
 * while the toast always shows" report. A fresh identifier is a new
 * notification, not an update, and is never shed.
 */
export const UPLOAD_DONE_NOTIFICATION_ID = "hostelhub-transfer-done";

/**
 * Minimum gap between two progress reposts. Keeps the progress stream well under
 * Android's update-rate limit; terminal notices ignore it. See `drain`.
 */
export const PROGRESS_REPOST_MS = 1_000;

/**
 * Marks our own notifications in their `data`, so the foreground handler in
 * `push-notifications.ts` can keep them out of the banner path. It lives here
 * rather than beside the notifier so that module never has to be imported by
 * the push module just to read one string.
 */
export const UPLOAD_NOTIFICATION_TYPE = "upload-progress";

/**
 * How long a transfer must have been running before the shade says anything.
 *
 * A 3 kB CSV is done in under a second, and posting progress for it produced
 * exactly the complaint it was meant to prevent: the in-app toaster had already
 * said "done" before the notification appeared, so the shade looked like it was
 * reporting something that had not started yet. Two async hops — a permission
 * read and `scheduleNotificationAsync` — cannot be made to land inside 200ms, so
 * the answer is not to race them but to not enter.
 *
 * The shade's whole justification is "the user switched away mid-transfer", and
 * nobody switches away inside a second. Terminal notices are never delayed: the
 * completed file is the part worth telling someone about.
 */
export const PROGRESS_DELAY_MS = 1_200;

/**
 * The channel a finished **download** is posted on, and its display name.
 *
 * Separate from `UPLOAD_CHANNEL` because the two want opposite importance. A
 * progress bar must never pop over the screen — LOW, silent, no heads-up — and
 * a finished download is the one notification in this whole pipeline that
 * *should* appear at the top, because it is the app's only report that a file
 * now exists on the phone. That is the behaviour every browser has trained
 * people to expect, and a completed download buried silently in the list is
 * indistinguishable from nothing having happened.
 */
export const DOWNLOAD_CHANNEL = "downloads";
/*
 * Carries failed transfers too: an error the user only learns about by opening
 * the app is the same silence a buried "Downloaded" was. The id stays.
 */
export const DOWNLOAD_CHANNEL_NAME = "Finished and failed transfers";

/** Marks the notification that a tap should open a file rather than route. */
export const DOWNLOAD_NOTIFICATION_TYPE = "download-complete";

/**
 * Its own Android channel at LOW importance: silent, no vibration, no heads-up.
 * A progress bar that buzzes twenty times per file is the thing that makes
 * people disable notifications for the whole app — taking the SOS channel with
 * them if they shared one.
 */
export const UPLOAD_CHANNEL = "uploads";

/**
 * What the channel is called in Android's settings.
 *
 * The **id** above stays `"uploads"` for ever: a channel id is the key the
 * user's own choices (importance, sound, blocked-or-not) hang off, so changing
 * it would silently orphan whatever they had set and create a second, default
 * channel beside it. The display name is free to change, and it has, because
 * the channel now carries downloads too.
 */
export const UPLOAD_CHANNEL_NAME = "Uploads and downloads";

/** Percentage granularity. 5 caps a transfer at ~20 reposts. */
export const PERCENT_STEP = 5;

/**
 * Where the batch is, named after what the user is waiting for rather than
 * after the HTTP call — the same vocabulary `uploadRowMessage` uses in the
 * toaster, so the shade and the screen never disagree.
 *
 * The batch takes its **least advanced** active stage: while one file is still
 * presigning, "Checking the file…" would be a lie about the other one.
 */
export type UploadPhase = "preparing" | "transferring" | "verifying";

export type UploadTally = {
  /** Transfers still in flight. */
  active: number;
  /**
   * Which way this batch is going, or `null` when the rows disagree.
   *
   * A mixed batch is not hypothetical — a resident can attach a payment proof
   * and tap a receipt in the same few seconds — and it is the one case where no
   * single verb is true. `null` makes the notice say "Transferring" rather than
   * picking one of the two and being wrong about half the bytes.
   */
  direction: TransferDirection | null;
  /** The latest failure's own message, so the shade says what the toast says. */
  error: string | null;
  failed: number;
  /** The single row's label, or `null` once a batch holds more than one. */
  label: string | null;
  /** Floored aggregate 0–100. Only meaningful while `phase` is transferring. */
  percent: number;
  /** The saved file a finished download left behind, for the tap handler. */
  openMimeType: string | null;
  openPath: string | null;
  openUri: string | null;
  /** `null` when nothing is in flight. */
  phase: UploadPhase | null;
  /** Ids already counted, so a re-emit cannot double-count a finished row. */
  seen: readonly string[];
  /**
   * When this batch began, so `uploadNotice` can withhold progress from one too
   * short to need it. `0` while nothing has started.
   */
  since: number;
  succeeded: number;
  /** Everything this batch has held, finished or not. */
  total: number;
};

export const EMPTY_TALLY: UploadTally = {
  active: 0,
  direction: null,
  error: null,
  failed: 0,
  label: null,
  openMimeType: null,
  openPath: null,
  openUri: null,
  percent: 0,
  phase: null,
  seen: [],
  since: 0,
  succeeded: 0,
  total: 0,
};

function floorToStep(value: number): number {
  return Math.max(0, Math.min(100, Math.floor(value / PERCENT_STEP) * PERCENT_STEP));
}

/**
 * Folds the queue into the running batch.
 *
 * A **new batch** begins when nothing was in flight and something now is. The
 * rows already finished at that instant belong to the batch before it, so they
 * are seeded into `seen` rather than counted again — otherwise a second upload
 * started while the first row was still lingering would report "2 uploaded".
 */
export function tallyUploads(
  previous: UploadTally,
  rows: readonly UploadRow[],
): UploadTally {
  const active = rows.filter((row) => isUploadActive(row.stage));
  const startingFresh = previous.active === 0 && active.length > 0;

  const base: UploadTally = startingFresh
    ? {
        ...EMPTY_TALLY,
        seen: rows.filter((row) => !isUploadActive(row.stage)).map((row) => row.id),
      }
    : previous;

  const seen = new Set(base.seen);
  let error = base.error;
  let failed = base.failed;
  let succeeded = base.succeeded;
  let openMimeType = base.openMimeType;
  let openPath = base.openPath;
  let openUri = base.openUri;

  for (const row of rows) {
    if (isUploadActive(row.stage) || seen.has(row.id)) {
      continue;
    }

    seen.add(row.id);

    if (row.stage === "failed") {
      failed += 1;
      error = row.error ?? error;
    } else {
      succeeded += 1;

      /*
       * Carried onto the tally rather than read from the row later, for the
       * same reason `label` is: `pruneUploads` drops a succeeded row after 2.5
       * seconds and the notification outlives it by design. Without this the
       * completion notice would lose its file the moment the toaster cleared.
       */
      if (row.openUri) {
        openMimeType = row.openMimeType ?? null;
        openPath = row.openPath ?? null;
        openUri = row.openUri;
      }
    }
  }

  /*
   * The batch's start is its earliest active row, held for the batch's whole
   * life. Taking the *newest* row's start instead would restart the clock every
   * time a second file joined, and a long transfer would never clear
   * `PROGRESS_DELAY_MS` as long as new ones kept arriving.
   */
  const since =
    active.length === 0
      ? base.since
      : startingFresh || base.since === 0
        ? Math.min(...active.map((row) => row.startedAt))
        : base.since;

  const finished = failed + succeeded;
  const total = Math.max(base.total, finished + active.length);

  /*
   * The average across what is in flight, weighted by nothing: files differ in
   * size and the queue does not know by how much, so a byte-weighted bar would
   * be a more precise-looking version of the same guess.
   */
  const percent =
    active.length === 0
      ? base.percent
      : floorToStep(
          (active.reduce((sum, row) => sum + uploadRowFraction(row), 0) / active.length) *
            100,
        );

  /*
   * A label only names the notification while the batch holds one file; past
   * that, "Payment proof" would be the name of one of three things. It is read
   * from the **active** row rather than from the queue, because a row from the
   * previous batch can still be lingering in `rows` — that is precisely the
   * case `startingFresh` exists for, and finding a label by scanning would
   * re-introduce the bug on the other side.
   */
  const activeLabel = active.length === 1 ? active[0].label : null;

  return {
    active: active.length,
    direction: directionOf(active) ?? base.direction,
    error,
    failed,
    label: total === 1 ? (activeLabel ?? base.label) : null,
    openMimeType,
    openPath,
    openUri,
    percent,
    phase: phaseOf(active),
    seen: [...seen],
    since,
    succeeded,
    total,
  };
}

/**
 * The batch's direction, or `null` for none-in-flight or a mixed batch.
 *
 * Read from the **active** rows for the same reason `activeLabel` is: a row
 * from the previous batch can still be lingering in the queue, and letting it
 * vote would let an upload that finished three seconds ago name a download.
 *
 * The caller falls back to the batch's previous direction when this is `null`,
 * so the terminal notice ("… downloaded") still knows what it is reporting
 * after the last active row has gone.
 */
function directionOf(active: readonly UploadRow[]): TransferDirection | null {
  if (active.length === 0) {
    return null;
  }

  const [first] = active;

  return active.every((row) => row.direction === first.direction) ? first.direction : null;
}

function phaseOf(active: readonly UploadRow[]): UploadPhase | null {
  if (active.length === 0) {
    return null;
  }

  if (active.some((row) => row.stage === "presigning")) {
    return "preparing";
  }

  return active.some((row) => row.stage === "uploading") ? "transferring" : "verifying";
}

export type UploadNotice = {
  body: string;
  /**
   * Which Android channel to post on. A finished download goes to the louder
   * one so it lands at the top of the shade — see `DOWNLOAD_CHANNEL`.
   */
  channel: typeof DOWNLOAD_CHANNEL | typeof UPLOAD_CHANNEL;
  /** The file to open when this notification is tapped, if there is one. */
  openMimeType: string | null;
  /**
   * Where that file landed, as a person reads it — `Pictures/HostelPalika/x.png`.
   *
   * Carried separately from the body text it also appears in, because the tap
   * handler needs it when the open *fails*: a phone with nothing that reads the
   * type has to be told where the file is instead, and "it is saved, somewhere"
   * is not being told.
   */
  openPath: string | null;
  openUri: string | null;
  /**
   * Android's `sticky`: the notification cannot be swiped away while bytes are
   * moving. A transfer the user dismissed and then wonders about is exactly the
   * uncertainty this feature exists to remove.
   */
  ongoing: boolean;
  tone: "active" | "failed" | "succeeded";
  title: string;
};

/**
 * The four words the notice needs, per direction.
 *
 * A table rather than conditionals at each of the six call sites below, because
 * the sentences differ only in the verb and writing them out twice is how the
 * two directions drift apart. `null` is the mixed batch — see
 * `UploadTally.direction` — and takes the neutral verb rather than guessing.
 */
const VERBS: Record<"download" | "mixed" | "read" | "upload", {
  /** Mid-transfer, title case: `Uploading payment proof`. */
  active: string;
  /** The settle stage's body line. */
  settling: string;
  /** Past participle: `payment proof uploaded`. */
  done: string;
  /** Bare verb for the failure line: `did not upload`. */
  verb: string;
}> = {
  download: {
    active: "Downloading",
    done: "downloaded",
    /*
     * Not "Checking the file…". On a download the bytes have already arrived
     * and what is left is writing them where the user asked, which on Android
     * is a folder write that a large export can visibly sit in. Same
     * correction `uploadRowMessage` makes in the toaster, so the shade and the
     * screen never disagree about what is happening.
     */
    settling: "Saving…",
    verb: "download",
  },
  mixed: {
    active: "Transferring",
    done: "transferred",
    settling: "Finishing…",
    verb: "transfer",
  },
  /*
   * The server looking at a file already stored. No bytes are moving, so the
   * percentage this table's other rows earn is meaningless here — `uploadNotice`
   * suppresses it, and every stage says the same thing.
   */
  read: {
    active: "Checking",
    done: "checked",
    settling: "Reading it…",
    verb: "check",
  },
  upload: {
    active: "Uploading",
    done: "uploaded",
    settling: "Checking the file…",
    verb: "upload",
  },
};

/**
 * What the shade should currently say, or `null` for "post nothing".
 *
 * `now` is a parameter rather than a `Date.now()` inside, so the delay below is
 * testable; the notifier passes the real clock.
 */
export function uploadNotice(tally: UploadTally, now: number = Date.now()): UploadNotice | null {
  const words = VERBS[tally.direction ?? "mixed"];
  const quiet = {
    channel: UPLOAD_CHANNEL,
    openMimeType: null,
    openPath: null,
    openUri: null,
  } as const;

  if (tally.active > 0) {
    // Too short to be worth telling the shade about — see `PROGRESS_DELAY_MS`.
    if (now - tally.since < PROGRESS_DELAY_MS) {
      return null;
    }

    const done = tally.failed + tally.succeeded;
    /*
     * A percentage is shown only while bytes are actually moving. Presigning
     * reports 0 and verifying reports 1 — rendering those as "0%" and "100%"
     * puts the bar at a standstill at each end of a transfer, which is the
     * reading that makes people force-quit mid-payment.
     */
    /*
     * A percentage is shown only while bytes are actually moving. Presigning
     * reports 0 and verifying reports 1 — rendering those as "0%" and "100%"
     * puts the bar at a standstill at each end of a transfer, which is the
     * reading that makes people force-quit mid-payment.
     *
     * A read never shows one at all: nothing is being counted, and a bar that
     * climbs to a number it invented is worse than a sentence that does not.
     */
    const progress =
      tally.direction === "read"
        ? words.settling
        : tally.phase === "preparing"
          ? "Preparing…"
          : tally.phase === "verifying"
            ? words.settling
            : `${tally.percent}%`;

    return {
      ...quiet,
      body:
        tally.total > 1 ? `${done} of ${tally.total} done · ${progress}` : progress,
      ongoing: true,
      title:
        tally.label === null
          ? `${words.active} ${tally.total} files`
          : `${words.active} ${tally.label.toLowerCase()}`,
      tone: "active",
    };
  }

  if (tally.failed > 0) {
    return {
      ...quiet,
      body: (tally.failed === 1 && tally.error) || "Open the app to try again.",
      // Heard, like a finished download — see `DOWNLOAD_CHANNEL_NAME`.
      channel: DOWNLOAD_CHANNEL,
      ongoing: false,
      title:
        tally.total === 1 && tally.label
          ? `${tally.label} did not ${words.verb}`
          : `${tally.failed} of ${tally.total} ${words.verb}s failed`,
      tone: "failed",
    };
  }

  if (tally.succeeded > 0) {
    /*
     * The one notice in this pipeline that is about a **thing** rather than
     * about a transfer: a file now exists on the phone. So it says where it
     * went, it opens when tapped, and it goes on the louder channel — a
     * finished download buried silently in the list is indistinguishable from
     * nothing having happened, which was the complaint.
     */
    const openable = tally.direction === "download" && tally.openUri !== null;

    return {
      body: openable
        ? `Saved to ${tally.openPath ?? "your Downloads"} · Tap to open`
        : `Finished ${words.active.toLowerCase()}.`,
      channel: openable ? DOWNLOAD_CHANNEL : UPLOAD_CHANNEL,
      ongoing: false,
      openMimeType: openable ? tally.openMimeType : null,
      openPath: openable ? tally.openPath : null,
      openUri: openable ? tally.openUri : null,
      title:
        tally.total === 1 && tally.label
          ? `${tally.label} ${words.done}`
          : `${tally.succeeded} files ${words.done}`,
      tone: "succeeded",
    };
  }

  return null;
}

/**
 * Whether the shade needs rewriting.
 *
 * Every field is compared because each one is visible; the rate limiting is
 * already done by `percent` being floored, so this stays a plain equality.
 */
export function shouldRepost(
  previous: UploadNotice | null,
  next: UploadNotice | null,
): boolean {
  if (previous === null || next === null) {
    return previous !== next;
  }

  return (
    previous.body !== next.body ||
    previous.channel !== next.channel ||
    previous.ongoing !== next.ongoing ||
    previous.openUri !== next.openUri ||
    previous.title !== next.title ||
    previous.tone !== next.tone
  );
}
