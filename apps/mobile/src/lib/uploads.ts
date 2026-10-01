/**
 * The one upload path: presign → PUT to R2 → complete.
 *
 * Ports the web's universal uploader. Three steps, and none of them is
 * optional:
 *
 * 1. `POST /files/presign` creates a `FileAsset` row **before any bytes exist**
 *    and returns a presigned URL. The row is a reservation carrying only the
 *    client's own description of the file.
 * 2. The PUT goes **straight to R2**, not through our API. It therefore carries
 *    no bearer token — the signature in the URL is the authorisation, and
 *    adding an `Authorization` header makes S3-compatible storage reject the
 *    request outright.
 * 3. `POST /files/{assetId}/complete` reads the stored object back, rejects it
 *    if it contradicts the description, and stamps `uploadCompletedAt`. **An
 *    asset that never completes is not usable as evidence** — a claim
 *    referencing one is refused — so skipping step 3 produces an upload that
 *    looks fine on the phone and is invisible to the hostel.
 *
 * `kind: "PAYMENT_PROOF"` is not decoration: the presign route refuses a
 * financial asset that is not tenant-scoped, because money evidence that is not
 * hostel-scoped cannot be authorised on read. The server resolves a resident's
 * hostel from their live resident profile — the same one the claim is checked
 * against — so the client never sends one.
 */

import { File, UploadType } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";

import { API_BASE_URL, api } from "@/lib/api";
import { type ApiEnvelope, readApiError, unwrap } from "@/lib/api-contract";
import { resolveFileName, resolveMimeType } from "@/lib/mime";
import { finishUpload, startUpload, updateUpload } from "@/lib/upload-queue";

export type FileAssetKind =
  /**
   * A booking fee screenshot. Paid to the platform, not a hostel, so the server
   * never scopes it to one — the uploader and platform staff read it back.
   */
  | "BOOKING_PAYMENT_PROOF"
  /**
   * A resident describing a complaint out loud, attached to one complaint.
   *
   * Deliberately **not** `MAINTENANCE_NOTE`, even though the recorder and the
   * player are the same components: that kind is the one `files/{assetId}/url`
   * widens to an assigned service provider, and a complaint about the kitchen
   * staff — possibly raised anonymously — must never sit in a kind whose read
   * rule reaches outside the hostel at all.
   */
  | "COMPLAINT_NOTE"
  /**
   * A shop bill or payment screenshot on a hostel expense. The hostel's own
   * books: scoped to the hostel at presign and readable by its staff only.
   */
  | "EXPENSE_RECEIPT"
  | "GENERIC"
  /**
   * A spoken description of a maintenance problem. Its own kind because it is
   * the only asset in the product a **service provider** can read — the server's
   * `files/{assetId}/url` widens access for this kind, and for nothing else, to
   * the one provider the job was assigned to.
   */
  | "MAINTENANCE_NOTE"
  | "PAYMENT_PROOF"
  | "PAYMENT_QR"
  | "STATEMENT";

export type UploadProgress = {
  /** 0–1, or null while the size is unknown. */
  fraction: number | null;
  stage: "presigning" | "uploading" | "verifying";
};

export class UploadError extends Error {
  constructor(
    message: string,
    readonly stage: UploadProgress["stage"],
  ) {
    super(message);
    this.name = "UploadError";
  }
}

type PresignResponse = { assetId: string; key: string; presignedUrl: string };

/**
 * Uploads one picked file and returns the asset id to attach to a claim.
 *
 * ## Progress reports itself
 *
 * Every call registers with `lib/upload-queue.ts`, which the always-mounted
 * `<UploadToaster />` renders — so a screen gets live progress, a stage label
 * and a failure message without wiring anything up, and an upload keeps
 * reporting after the user has navigated away from the screen that started it.
 * That is the web's universal-uploader rule ("call sites never build their own
 * progress UI") and the reason `label` is the *task*, not the file name: "IMG
 * 20260817 004312.jpg" tells nobody what is happening.
 *
 * `onProgress` stays for the rare screen that also wants an inline indicator
 * next to the thing being uploaded.
 */
export async function uploadAsset(
  asset: Pick<ImagePickerAsset, "fileName" | "fileSize" | "mimeType" | "uri">,
  {
    accessLevel = "PRIVATE",
    kind = "GENERIC",
    label = "File",
    onProgress,
  }: {
    /**
     * **`PRIVATE` unless the bytes are meant for strangers.** Default-deny, and
     * every existing caller wants it: a payment proof, an ID photo and a complaint
     * attachment are all read back through the authorising route.
     *
     * `PUBLIC` is for community media, matching the web's
     * `useUploader({ accessLevel: "PUBLIC" })`. It has to be: a public community
     * post is read by people who are neither the owner nor in the author's hostel,
     * and `files/[assetId]/url` default-denies exactly that — so a PRIVATE upload
     * would post an image only its author can see.
     */
    accessLevel?: "PRIVATE" | "PUBLIC";
    kind?: FileAssetKind;
    label?: string;
    onProgress?: (progress: UploadProgress) => void;
  } = {},
): Promise<string> {
  const rowId = startUpload(label);

  const report = (progress: UploadProgress) => {
    updateUpload(rowId, { fraction: progress.fraction, stage: progress.stage });
    onProgress?.(progress);
  };

  try {
    const assetId = await runUpload(asset, kind, accessLevel, report);

    finishUpload(rowId);

    return assetId;
  } catch (caught) {
    finishUpload(rowId, {
      error: readApiError(caught, "That upload did not go through."),
    });

    throw caught;
  }
}

async function runUpload(
  asset: Pick<ImagePickerAsset, "fileName" | "fileSize" | "mimeType" | "uri">,
  kind: FileAssetKind,
  accessLevel: "PRIVATE" | "PUBLIC",
  onProgress: (progress: UploadProgress) => void,
): Promise<string> {
  const mimeType = resolveMimeType(asset);
  const fileName = resolveFileName(asset);

  /*
   * SDK 54 replaced `getInfoAsync`/`createUploadTask` with the `File` object;
   * the old functions still exist under `expo-file-system/legacy`, and reaching
   * for them is how a codebase ends up with two file APIs.
   */
  const file = new File(asset.uri);

  /*
   * Measured off the file at `asset.uri`, not read from `asset.fileSize`.
   *
   * The two are not the same number. `fileSize` describes the asset the picker
   * handed back, and the ID-card portrait is picked with `allowsEditing` and
   * `quality: 0.85` — the bytes at that uri have been cropped and re-encoded. It
   * is also simply optional: the field is absent on several platforms and picker
   * paths, which is why the fallback was there in the first place.
   *
   * This is the size the server writes onto the `FileAsset` row, and
   * `/files/{id}/complete` re-reads the stored object and rejects it unless the
   * real length matches exactly. Declaring anything other than what is about to
   * be uploaded fails there — and until the signer stopped binding
   * `content-length`, it failed a step earlier, at R2, where there is nothing to
   * read afterwards. `file.size` cannot be wrong: it is the file being sent.
   */
  const sizeBytes = file.size || asset.fileSize;

  if (!file.exists || !sizeBytes) {
    throw new UploadError("That file could not be read, or it is empty.", "presigning");
  }

  onProgress({ fraction: 0, stage: "presigning" });

  const presigned = unwrap(
    await api.post<ApiEnvelope<PresignResponse>>("/files/presign", {
      accessLevel,
      fileName,
      kind,
      mimeType,
      sizeBytes,
    }),
  );

  onProgress({ fraction: 0, stage: "uploading" });

  /*
   * Straight to R2 with `expo-file-system`'s uploader rather than reading the
   * file into JS and handing it to axios. A rent receipt photographed on a
   * modern phone is several megabytes, and base64 in memory is that again by
   * a third — enough to kill a low-end Android device mid-payment.
   *
   * No `Authorization` header: the URL's signature is the credential, and an
   * extra auth header makes S3-compatible storage reject the request.
   */
  const result = await file.upload(presigned.presignedUrl, {
    headers: { "Content-Type": mimeType },
    httpMethod: "PUT",
    mimeType,
    onProgress: ({ bytesSent, totalBytes }) => {
      onProgress({
        fraction: totalBytes > 0 ? bytesSent / totalBytes : null,
        stage: "uploading",
      });
    },
    uploadType: UploadType.BINARY_CONTENT,
  });

  /*
   * Two failures, two messages, because they send the reader to different
   * places. No result at all is a transport failure and "check your connection"
   * is the right advice. A *status* means storage answered and said no — a
   * signature that did not match, an expired URL, a bucket that is not there —
   * and telling someone with four bars to check their wifi is how an afternoon
   * goes missing. The number is included because this request never touches our
   * own infrastructure: it is the only trace of the failure that exists.
   */
  if (!result) {
    throw new UploadError(
      "The upload did not reach our storage. Check your connection and try again.",
      "uploading",
    );
  }

  if (result.status < 200 || result.status >= 300) {
    throw new UploadError(
      `Our storage refused this file (error ${result.status}). Please try again.`,
      "uploading",
    );
  }

  onProgress({ fraction: 1, stage: "verifying" });

  /*
   * Not optional. Until this runs the asset is a reservation, and the finance
   * module refuses a claim whose evidence never completed — which on the phone
   * looks like a successful upload and a rejected submit with no obvious link
   * between the two.
   */
  unwrap(
    await api.post<ApiEnvelope<{ assetId: string }>>(
      `/files/${presigned.assetId}/complete`,
    ),
  );

  return presigned.assetId;
}

/** Variants `files/[assetId]/url` will serve. Falls back to the original if absent. */
export type AssetVariant = "LARGE" | "MEDIUM" | "ORIGINAL" | "THUMBNAIL";

/** The authorising read route for a private asset. Needs the bearer token. */
export function assetUrl(assetId: string, variant: AssetVariant = "ORIGINAL") {
  const query = variant === "ORIGINAL" ? "" : `?variant=${variant}`;

  return `${API_BASE_URL}/api/v1/files/${assetId}/url${query}`;
}

/**
 * An `<Image source>` for a **private** asset — a payment proof, a food photo, a
 * complaint attachment.
 *
 * ## Why the header, and why it is the only mechanism available
 *
 * `files/[assetId]/url` is not the image. It authorises the caller, presigns the
 * object, and **302s to R2**. A `PUBLIC` asset skips the auth check entirely, so
 * a bare `<Image>` follows the redirect and loads (that is `lib/media.ts`'s
 * case). A private one answers `401 UNAUTHENTICATED` without a principal, and
 * `loadApiPrincipal` reads either the `Authorization` header or a cookie — the
 * phone has no cookie, so the header is the whole of it.
 *
 * ## The part that was measured rather than assumed
 *
 * Against the live bucket on 2026-08-17: the presigned URL served `200
 * image/jpeg` bare, and the **same URL with an `Authorization` header attached
 * answered `400 InvalidRequest — Missing x-amz-content-sha256`**. R2 reads any
 * `Authorization` header as SigV4 and stops honouring the query signature. So
 * the header has to reach our route and *not* the redirect target.
 *
 * Both native loaders strip `Authorization` when a redirect crosses to another
 * host, which is what makes this work — but that is one behaviour this app has
 * never observed on a device, and it is the first thing to check if a private
 * image renders blank while the same asset opens fine in the admin's browser.
 * The fix, if it comes to that, is server-side: a mode on the read route that
 * returns the presigned URL as JSON so the client can load it bare. That is why
 * every private image in the app goes through this one function.
 */
export function privateAssetSource(
  assetId: string,
  token: string | null | undefined,
  variant: AssetVariant = "ORIGINAL",
) {
  return {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    uri: assetUrl(assetId, variant),
  };
}
