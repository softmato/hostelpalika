/**
 * Downloading a PDF that needs the bearer token, then handing it to the OS.
 *
 * `Linking.openURL` cannot do this. The receipt and statement routes stream
 * through our API and authorise the caller, so an unauthenticated GET from the
 * system browser gets a 401 — and on Android that renders as a downloaded file
 * containing a JSON error, which is worse than an error message because the
 * resident keeps it.
 *
 * So: download with the header, write to the cache directory, share. The cache
 * directory rather than documents because the OS may reclaim it — these are
 * copies of something the server can always regenerate, and a receipt that
 * silently accumulates on a 32 GB phone every time somebody taps it is not a
 * feature.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

import { APP_NAME } from "@/constants/branding";
import { openSavedFile, saveSilently } from "@/lib/native-downloads";
import { readTokens } from "@/lib/session";
import { toastSuccess, toastSuccessAction } from "@/lib/toast";
import { finishUpload, startDownload, updateUpload } from "@/lib/upload-queue";

/** Opens a download row with a light tap, so the press is felt before the toaster appears. */
function beginDownload(label: string) {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  return startDownload(label);
}

/** Sub-folder so a cache sweep can be reasoned about, and names cannot collide. */
const FOLDER = "documents";

/**
 * Anything that is not a letter, digit, dash or dot becomes one dash.
 *
 * Receipt numbers come from the server and are tame today, but a filename is
 * a path: a `/` in one would write outside the folder, and a Windows-hostile
 * character breaks the share sheet on some targets.
 */
function safeFileName(name: string) {
  const cleaned = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");

  return cleaned || "document";
}

/**
 * expo-file-system rejects a non-2xx answer with its own plumbing as the
 * message — "Call to function 'FileSystemDownloadTask.start' has been rejected
 * … HTTP 404" — which is what an owner was shown. The status is the useful
 * part, so it is said in the same words the web downloader uses.
 */
function throwReadable(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  const status = /(?:HTTP|status:?)\s*(\d{3})/.exec(message)?.[1];

  if (status === "401" || status === "403") {
    throw new Error("You are not signed in, or this is not yours to download.");
  }

  if (status) {
    throw new Error(`The server could not produce this file (${status}).`);
  }

  throw new Error("The download failed. Check your connection and try again.");
}

export async function downloadAndShare({
  fileName,
  url,
}: {
  /** Without the extension. `.pdf` is appended. */
  fileName: string;
  url: string;
}) {
  const tokens = await readTokens();

  if (!tokens?.accessToken) {
    throw new Error("You need to be signed in to download this.");
  }

  const folder = new Directory(Paths.cache, FOLDER);

  if (!folder.exists) {
    folder.create({ intermediates: true });
  }

  const target = new File(folder, `${safeFileName(fileName)}.pdf`);

  // Overwritten rather than appended to: a second tap on the same receipt must
  // produce the same file, not a growing one.
  if (target.exists) {
    target.delete();
  }

  const file = await File.downloadFileAsync(url, target, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    idempotent: true,
  }).catch(throwReadable);

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
  });
}

/**
 * Downloads a remote image and hands it to the share sheet — the global asset
 * viewer's "Save" action.
 *
 * Separate from `downloadAndShare`, which is the receipt path and is PDF-shaped
 * all the way down (`.pdf` appended, PDF mime, PDF UTI, always authorised).
 * This one differs in the way that matters:
 *
 * **The header is a parameter, and the default is off.** A private asset needs
 * the bearer token on our route; a public one must not carry one, because R2
 * reads any `Authorization` header as SigV4 and rejects the request outright
 * (measured 2026-08-17 — see `privateAssetSource` in `lib/uploads.ts`). Sending
 * it "just in case" breaks exactly the images that work today, so the caller
 * says which kind it has and `lib/asset-viewer.ts` is what decides.
 *
 * The extension comes from the mime type rather than from the URL: the
 * authorising route ends in `/url`, so a name taken from the path would save
 * every private image as a file the gallery refuses to open.
 */
export async function downloadAndShareImage({
  authorize = false,
  fileName,
  mimeType = "image/jpeg",
  url,
}: {
  /** Attach the session's bearer token. Only for `files/[assetId]/url`. */
  authorize?: boolean;
  /** Without the extension. */
  fileName: string;
  mimeType?: string;
  url: string;
}) {
  const headers: Record<string, string> = {};

  if (authorize) {
    const tokens = await readTokens();

    if (!tokens?.accessToken) {
      throw new Error("You need to be signed in to save this.");
    }

    headers.Authorization = `Bearer ${tokens.accessToken}`;
  }

  const folder = new Directory(Paths.cache, FOLDER);

  if (!folder.exists) {
    folder.create({ intermediates: true });
  }

  const extension = mimeType.split("/")[1]?.split("+")[0] || "jpg";
  const target = new File(folder, `${safeFileName(fileName)}.${extension}`);

  // Overwritten rather than appended to: saving the same photo twice must
  // produce the same file, not a growing one.
  if (target.exists) {
    target.delete();
  }

  const file = await File.downloadFileAsync(url, target, { headers, idempotent: true }).catch(throwReadable);

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }

  // The share sheet is the route to the camera roll on both platforms; writing
  // to the gallery directly would need `expo-media-library` and a new native
  // module. Same trade already taken by `shareDataUrlImage`.
  await Sharing.shareAsync(file.uri, { mimeType });
}

/**
 * Downloads an authorised CSV and hands it to the share sheet.
 *
 * The report exports are `GET` routes that answer `text/csv` with a
 * `Content-Disposition` filename, which a browser turns into a download and a
 * phone turns into nothing at all — there is no download tray to land in. So the
 * bytes go to the cache directory under a name we choose and the share sheet
 * takes it from there: mail it to the accountant, drop it in Drive, open it in
 * whatever spreadsheet app is installed.
 *
 * Same shape as {@link downloadAndShare}, which does this for receipt PDFs. The
 * two are kept apart rather than parameterised on MIME type because the failure
 * messages differ and both are read by a person mid-task.
 */
export async function downloadAndShareCsv({
  fileName,
  url,
}: {
  /** Without the extension. `.csv` is appended. */
  fileName: string;
  url: string;
}) {
  const tokens = await readTokens();

  if (!tokens?.accessToken) {
    throw new Error("You need to be signed in to export this.");
  }

  const folder = new Directory(Paths.cache, FOLDER);

  if (!folder.exists) {
    folder.create({ intermediates: true });
  }

  const target = new File(folder, `${safeFileName(fileName)}.csv`);

  if (target.exists) {
    target.delete();
  }

  const file = await File.downloadFileAsync(url, target, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    idempotent: true,
  }).catch(throwReadable);

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
  });
}

/* -------------------------------------------------------------------------- */
/* Saving to the device                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where Android was last told to put downloads — a SAF tree URI.
 *
 * AsyncStorage rather than SecureStore: it is a folder path, not a secret, and
 * SecureStore is for the two tokens and nothing else (see `lib/session.ts`).
 */
const DOWNLOAD_FOLDER_KEY = "hh_download_folder_uri";

/**
 * The folder this app makes inside whatever the user picked.
 *
 * Everything the app ever saves goes in one place, so a year of exports and
 * receipts is not scattered through a Downloads folder that already has three
 * hundred things in it. Created once, at grant time, and the *child* URI is what
 * gets remembered — so this is never re-created and there is no per-download
 * check for whether it exists.
 */
const APP_FOLDER = APP_NAME;

/**
 * `expo-file-system/legacy`, loaded only when a file is actually being saved.
 *
 * The modern API has no Storage Access Framework, and SAF is the only way an
 * app can write into a folder the user can browse on Android 11+ — the old
 * `WRITE_EXTERNAL_STORAGE` route has been closed since API 30. The legacy entry
 * point is part of the **same installed native module**, so this needs no
 * rebuild; requiring it lazily keeps a platform-specific import off the iOS path
 * and out of module load, the same trade `manage/statements.tsx` takes for the
 * document picker.
 *
 * Typed here rather than imported, because the legacy module's own types pull in
 * the whole deprecated surface for the four functions actually used.
 */
type LegacyFileSystem = {
  StorageAccessFramework: {
    createFileAsync: (parentUri: string, fileName: string, mimeType: string) => Promise<string>;
    getUriForDirectoryInRoot: (folderName: string) => string;
    makeDirectoryAsync: (parentUri: string, dirName: string) => Promise<string>;
    requestDirectoryPermissionsAsync: (
      initialFileUrl?: string | null,
    ) => Promise<{ directoryUri: string; granted: boolean }>;
    writeAsStringAsync: (
      fileUri: string,
      contents: string,
      options?: { encoding?: string },
    ) => Promise<void>;
  };
};

function loadLegacyFileSystem(): LegacyFileSystem | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-file-system/legacy") as LegacyFileSystem;
  } catch {
    return null;
  }
}

/**
 * The folder Android downloads go into, asking for one the first time only.
 *
 * ## The second rung, not the first
 *
 * `lib/native-downloads.ts` writes to `MediaStore.Downloads` with no permission
 * and no dialogue at all, and it is tried first. This is what happens when that
 * cannot: Android 9 or older, where the Downloads collection does not exist, or
 * an app binary built before the native module shipped.
 *
 * For those, scoped storage leaves exactly one unprivileged route — a directory
 * grant the user makes once, which then survives restarts. The picker opens on
 * `Download` already, so it is one tap, once, ever.
 *
 * Returns `null` when the user declines. Declining is a real answer, and the
 * caller falls back to the share sheet rather than failing a download whose
 * bytes are already on the device.
 */
async function resolveDownloadFolder(saf: LegacyFileSystem["StorageAccessFramework"]) {
  const remembered = await AsyncStorage.getItem(DOWNLOAD_FOLDER_KEY);

  if (remembered) {
    return remembered;
  }

  const permission = await saf.requestDirectoryPermissionsAsync(
    saf.getUriForDirectoryInRoot("Download"),
  );

  if (!permission.granted) {
    return null;
  }

  /*
   * One folder of our own inside what they granted, rather than writing loose
   * into it. SAF has no "create if absent", and on the rare second run — a
   * reinstall over an existing `HostelPalika/` — it answers with `HostelPalika (1)`
   * rather than an error. That is why the *result* is what gets remembered:
   * whichever folder this call produced is the folder from then on, so the
   * duplicate is made at most once and never accumulates.
   *
   * A failure here is untidiness, not a broken download — some trees refuse
   * subfolders — so it falls back to the granted folder itself.
   */
  let folderUri = permission.directoryUri;

  try {
    folderUri = await saf.makeDirectoryAsync(permission.directoryUri, APP_FOLDER);
  } catch {
    folderUri = permission.directoryUri;
  }

  await AsyncStorage.setItem(DOWNLOAD_FOLDER_KEY, folderUri);

  return folderUri;
}

/** Forgets the chosen folder, so the next download asks for one again. */
export async function forgetDownloadFolder() {
  await AsyncStorage.removeItem(DOWNLOAD_FOLDER_KEY);
}

/**
 * Downloads an authorised file and **saves it to the device**, reporting into
 * the global transfer toaster the whole way.
 *
 * ## Why this exists beside `downloadAndShare`
 *
 * That one ends at the share sheet, which is the right ending for a receipt
 * somebody is about to send to a resident and the wrong one for an export
 * somebody wants to *keep*. Being asked "share to…" after pressing a download
 * button is the app re-opening a decision the user already made.
 *
 * So here the bytes land in a folder the user chose, and the only dialogue is
 * the one-time folder grant.
 *
 * ## Progress, because a silent button is indistinguishable from a broken one
 *
 * Registered with `startDownload`, so `<UploadToaster />` draws it at the top of
 * whatever screen the user is on — and keeps drawing it if they navigate away,
 * because this is a plain module and does not care which screen started it. The
 * caller needs no spinner and gets no progress callback.
 *
 * ## iOS has no Downloads folder
 *
 * SAF is Android-only, and iOS has no user-browsable filesystem to write into;
 * the platform's own idea of a download is Files, reached through the share
 * sheet. So there the transfer is still reported in the toaster and still not a
 * silent button — it just ends in `Sharing`, which is what "download" means on
 * that platform. Same fallback when an Android user declines the folder grant.
 */
/**
 * The first bytes a file of this type must start with, where there is one.
 *
 * Only PDF, because only PDF has both a signature worth checking and a caller
 * that can ask for it by name. A CSV has no magic number — anything is a valid
 * CSV — so there is nothing to verify on that side and no entry here.
 */
const MAGIC: Record<string, string> = {
  pdf: "%PDF-",
};

/**
 * Refuses a file whose contents do not match the extension it is about to be
 * saved under.
 *
 * ## The bug this exists to make impossible
 *
 * The statement export asks the API for `?format=pdf`. A server that predates
 * that parameter does not reject it — Zod strips unknown keys — it simply
 * returns the CSV it has always returned. The client then wrote 162 bytes of
 * spreadsheet into `hostel-statement.pdf`, which no PDF reader on earth will
 * open, and the failure surfaced as "the notification does not work" three
 * layers away from its cause.
 *
 * So the file is checked against its own name before it is saved anywhere. A
 * mismatch is reported as what it actually is — the API being older than the
 * app — rather than saved and left for the user to discover.
 *
 * Reads only the first bytes, not the whole file: `bytes()` on a large export
 * would pull it through JS for the sake of five characters.
 */
async function assertMatchesExtension(file: File, extension: string) {
  const magic = MAGIC[extension];

  if (!magic) {
    return;
  }

  const head = (await file.bytes()).slice(0, magic.length);
  const text = String.fromCharCode(...head);

  if (text !== magic) {
    throw new Error(
      `The server sent something that is not a ${extension.toUpperCase()}, so nothing was saved. Try again in a minute.`,
    );
  }
}

/**
 * Puts a file that is already on the device somewhere the user can find it.
 *
 * Three rungs, best first, and every one of them ends with the file somewhere
 * reachable:
 *
 * 1. **MediaStore** — `Download/HostelPalika/`, or `Pictures/HostelPalika/` for an
 *    image so it lands in the gallery. No permission, no dialogue, nothing to
 *    remember. Android 10+ and a binary that has the native module. This is
 *    what a download should feel like.
 * 2. **Storage Access Framework** — one folder grant, once, remembered for
 *    ever. Covers Android 9 and older, and any build made before the module
 *    shipped.
 * 3. **The share sheet** — iOS, where there is no Downloads folder to write
 *    into, and the Android user who declined the grant.
 *
 * The ladder is walked rather than branched on a platform check, because "can
 * this build do it" and "can this device do it" are different questions and only
 * the rung itself knows the answer to both. For the same reason no rung may
 * throw its way out of the ladder: a rung that fails is a rung that cannot, and
 * there is another one underneath it. See `saveSilently`.
 *
 * Takes an open toaster row rather than starting its own, because the two
 * callers reach here having done different amounts of work — one downloaded the
 * bytes over the network and has been reporting progress, the other wrote them
 * from something already in hand.
 */
async function placeOnDevice({
  extension,
  id,
  mimeType,
  safe,
  title,
  uri,
}: {
  /** Without the dot — `csv`, `pdf`, `png`. */
  extension: string;
  /** The open row in the transfer queue, which this finishes. */
  id: string;
  mimeType: string;
  /** The file's name, already through `safeFileName`, without the extension. */
  safe: string;
  /** The toast's first line — "Downloaded" for a transfer, "Saved" otherwise. */
  title: string;
  /** `file://` URI of the copy in the cache directory. */
  uri: string;
}) {
  const saved = await saveSilently({
    fileName: `${safe}.${extension}`,
    mimeType,
    sourceUri: uri,
    subfolder: APP_FOLDER,
  });

  if (saved !== null) {
    /*
     * The file's handle travels with the finished row, so the completion
     * notification can open it — the toaster is gone in 2.5 seconds and the
     * notification is what is left. See `UploadRow.openUri`.
     */
    finishUpload(id, {
      openMimeType: mimeType,
      openPath: saved.path,
      openUri: saved.uri,
    });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Tappable: the push that says the same thing can arrive late or not at
    // all, and this toast is the one report the user always gets.
    toastSuccessAction(title, `Saved to ${saved.path}. Tap to open.`, () => {
      void openSavedFile({ mimeType, path: saved.path, uri: saved.uri });
    });

    return;
  }

  const saf =
    Platform.OS === "android" ? (loadLegacyFileSystem()?.StorageAccessFramework ?? null) : null;
  const destination = saf ? await resolveDownloadFolder(saf) : null;

  if (saf && destination) {
    try {
      const fileUri = await saf.createFileAsync(destination, safe, mimeType);

      /*
       * Base64 through JS rather than a native move, because SAF has no
       * relocate that accepts a `file://` source. Fine for an export, a receipt
       * or a card capture — all kilobytes — and the reason this is not the
       * function to reach for with a video.
       */
      await saf.writeAsStringAsync(fileUri, await new File(uri).base64(), {
        encoding: "base64",
      });

      finishUpload(id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toastSuccess(title, `Saved as ${safe}.${extension} in your ${APP_FOLDER} folder.`);

      return;
    } catch {
      /*
       * The remembered grant is gone — the user cleared app data, or removed
       * the card it pointed at. Forget it so the next attempt asks again, and
       * hand this one to the share sheet rather than losing a file that is
       * already on the device.
       */
      await forgetDownloadFolder();
    }
  }

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("There is nowhere to save this on this device.");
  }

  await Sharing.shareAsync(uri, { mimeType });
  finishUpload(id);
}

export async function downloadToDevice({
  authenticated = true,
  extension,
  fileName,
  label,
  mimeType,
  url,
}: {
  /**
   * Whether to put this session's bearer token on the request. `true` for our
   * own routes, which is nearly everything.
   *
   * **`false` is not "skip a nicety" — it is required for public storage.** An
   * R2 or S3 URL reads *any* `Authorization` header as a SigV4 signature and
   * rejects the request outright rather than ignoring it, so a public asset
   * fetched with a token on it fails with a signature error that says nothing
   * about tokens. `lib/uploads.ts` documents the same trap on the PUT side, and
   * `lib/asset-viewer.ts` on the read side; this is the third face of it.
   */
  authenticated?: boolean;
  /** Without the dot — `csv`, `pdf`. */
  extension: string;
  /** Without the extension. */
  fileName: string;
  /** What the user asked for, as the toaster says it — "Statement export". */
  label: string;
  mimeType: string;
  url: string;
}) {
  const id = beginDownload(label);

  try {
    const tokens = authenticated ? await readTokens() : null;

    if (authenticated && !tokens?.accessToken) {
      throw new Error("You need to be signed in to download this.");
    }

    const folder = new Directory(Paths.cache, FOLDER);

    if (!folder.exists) {
      folder.create({ intermediates: true });
    }

    const safe = safeFileName(fileName);
    const target = new File(folder, `${safe}.${extension}`);

    // Overwritten rather than appended to, same rule as every other transfer in
    // this file: a second download of the same export must produce the same
    // file, not a growing one.
    if (target.exists) {
      target.delete();
    }

    updateUpload(id, { fraction: 0, stage: "uploading" });

    /*
     * No `idempotent` flag on this one — `DownloadTask` has no such option, only
     * the simpler `File.downloadFileAsync` does. The delete above is what makes
     * a repeat download safe instead.
     */
    const task = new DownloadTask(url, target, {
      headers: tokens?.accessToken
        ? { Authorization: `Bearer ${tokens.accessToken}` }
        : {},
      onProgress: ({ bytesWritten, totalBytes }) => {
        /*
         * `totalBytes` is `-1` when the server sent no `Content-Length`, which
         * a streamed CSV export does not. `null` is the queue's word for "size
         * unknown" and parks the bar at a third rather than at zero — a bar
         * pinned empty while bytes are visibly moving is what makes people
         * force-quit. See `uploadRowFraction`.
         */
        updateUpload(id, {
          fraction: totalBytes > 0 ? Math.min(1, bytesWritten / totalBytes) : null,
        });
      },
    });

    const downloaded = await task.downloadAsync().catch(throwReadable);
    const uri = downloaded?.uri ?? target.uri;

    // Before anything is saved anywhere — see `assertMatchesExtension`.
    await assertMatchesExtension(downloaded ?? target, extension);

    // The bytes are here; what is left is putting them where the user can find
    // them. This stage reads "Saving…" on a download — see `uploadRowMessage`.
    updateUpload(id, { fraction: 1, stage: "verifying" });

    await placeOnDevice({ extension, id, mimeType, safe, title: "Downloaded", uri });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The download failed.";

    /*
     * The row is failed *and* the error rethrown. The toaster is the ambient
     * report and the caller still owns the foreground one — a screen that
     * silently continued past a failed download would leave the button looking
     * like it worked.
     */
    finishUpload(id, { error: message });
    throw error;
  }
}

/**
 * Splits a `data:` URL into the three things a file needs.
 *
 * Kept separate from the writing so the failure — a string that is not a data
 * URL at all — is reported before a cache folder is made for it.
 */
function readDataUrl(dataUrl: string) {
  const match = /^data:(image\/([a-z0-9.+-]+));base64,(.+)$/i.exec(dataUrl.trim());

  if (!match) {
    throw new Error("That image could not be read.");
  }

  const [, mimeType, extension, base64] = match;

  return { base64, extension, mimeType };
}

/**
 * Saves an image that is already in hand as a `data:` URL **to the phone**.
 *
 * For the ID card's QR, which the server renders with `qrcode` and returns
 * inline. Nothing is downloaded — the bytes arrived with the JSON — so this is
 * the cache-folder write and then the same ladder every other save in this file
 * walks.
 *
 * ## Why this is not the share sheet
 *
 * It was, and it was wrong. "Save this QR code" that opens a share sheet is the
 * app re-opening a decision the user already made — they said *save*, and were
 * answered with a list of apps to send it to. The share sheet is a route to the
 * camera roll, not a save, and it costs two more taps and a choice to get there.
 *
 * The native Downloads writer removed the reason for the compromise: the file
 * lands in `Download/HostelPalika/` with no permission and no dialogue, and the
 * share sheet stays as the bottom rung for the platforms that have nowhere else
 * to put it.
 */
export async function saveDataUrlToDevice({
  dataUrl,
  fileName,
  label,
}: {
  /** `data:image/<type>;base64,…`. */
  dataUrl: string;
  /** Without the extension; taken from the data URL's own MIME type. */
  fileName: string;
  /** What the user asked for, as the toaster says it — "QR code". */
  label: string;
}) {
  const { base64, extension, mimeType } = readDataUrl(dataUrl);
  const id = beginDownload(label);

  try {
    const folder = new Directory(Paths.cache, FOLDER);

    if (!folder.exists) {
      folder.create({ intermediates: true });
    }

    const safe = safeFileName(fileName);
    const target = new File(folder, `${safe}.${extension}`);

    if (target.exists) {
      target.delete();
    }

    target.create();
    /*
     * `{ encoding: "base64" }` rather than decoding to a `Uint8Array` ourselves.
     * `atob` is a Hermes built-in rather than a React Native guarantee, and a
     * hand-rolled decode of a 420px PNG is a pointless pass over the string when
     * the native side already accepts base64.
     */
    target.write(base64, { encoding: "base64" });

    updateUpload(id, { fraction: 1, stage: "verifying" });
    await placeOnDevice({ extension, id, mimeType, safe, title: "Saved", uri: target.uri });
  } catch (error) {
    const message = error instanceof Error ? error.message : "It could not be saved.";

    finishUpload(id, { error: message });
    throw error;
  }
}

/**
 * Saves a file that already exists on disk **to the phone** — the output of a
 * view capture.
 *
 * Separate from `saveDataUrlToDevice` because the two start from different
 * things: that one is handed base64 by the server and has to write it out first,
 * this one is handed a `file://` URI that `captureRef` has already written.
 * Collapsing them would mean a function that takes "either a data URL or a
 * path", which is the shape that eventually gets passed the wrong one.
 *
 * The capture's own temporary name is not used. `captureRef` writes something
 * like `ReactNative-snapshot-image-1a2b.png`, which is a name for the machine;
 * the file the user finds in Downloads is named by the caller.
 */
export async function saveToDevice({
  extension,
  fileName,
  label,
  mimeType,
  uri,
}: {
  /** Without the dot — `png`. */
  extension: string;
  /** Without the extension. */
  fileName: string;
  /** What the user asked for, as the toaster says it — "ID card". */
  label: string;
  mimeType: string;
  /** `file://` URI of a file that already exists. */
  uri: string;
}) {
  const id = beginDownload(label);

  try {
    updateUpload(id, { fraction: 1, stage: "verifying" });
    await placeOnDevice({ extension, id, mimeType, safe: safeFileName(fileName), title: "Saved", uri });
  } catch (error) {
    const message = error instanceof Error ? error.message : "It could not be saved.";

    finishUpload(id, { error: message });
    throw error;
  }
}
