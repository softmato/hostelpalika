/**
 * The upload path for the two public registration forms, and only for them.
 *
 * ## Why this is not `lib/uploads.ts`
 *
 * That module is the app's one upload pipeline — presign, PUT to R2, complete —
 * and its first step, `POST /files/presign`, **requires a principal** and scopes
 * the new `FileAsset` row to the caller's hostel. Both callers here have neither:
 * a person registering a hostel does not own one yet, and a tradesperson applying
 * to the directory belongs to no hostel at all. The presign route would 401 the
 * first and file the second's citizenship photo against nothing.
 *
 * `POST /public/files/upload` exists for exactly this. It is rate-limited, capped
 * at 5 MB and accepts a short list of types. Documents (citizenship, licences,
 * house rules, the selfie) go to the **private** bucket and come back as a
 * `fileAssetId` plus a `claimToken`. The application submits both, which is what
 * attaches the file to the applicant, and platform reviewers read it through the
 * signed files route. Only photos meant for the listing are published, with
 * `visibility: "public"`, and come back as a URL.
 *
 * It is the same route the website's own registration forms post to, so an
 * application filed from the phone and one filed from a desktop produce the same
 * documents in the same bucket.
 *
 * ## Progress reports itself
 *
 * Same contract as `uploadAsset`: every call registers with `lib/upload-queue.ts`
 * and the always-mounted `<UploadToaster />` draws it. Call sites never build
 * their own progress UI, and an upload keeps reporting after the applicant has
 * moved to the next step of the form.
 */

import { File, Paths, UploadType } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";

import { API_BASE_URL } from "@/lib/api";
import type { ApiEnvelope, ApiFailure } from "@/lib/api-contract";
import { resolveFileName, resolveMimeType } from "@/lib/mime";
import { publicUploadError } from "@/lib/public-upload-limits";
import { finishUpload, startUpload, updateUpload } from "@/lib/upload-queue";

/**
 * One uploaded file, as the registration forms hold it.
 *
 * A published photo has a `url` and nothing else. A private document also has
 * `fileAssetId` + `claimToken`, which is what the application submits. Its `url`
 * only draws the chip: it opens the file for this uploader until the application
 * claims it, and it is never sent.
 */
export type PublicFile = {
  claimToken?: string;
  fileAssetId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
};

export class PublicUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUploadError";
  }
}

type PickedAsset = Pick<
  ImagePickerAsset,
  "fileName" | "fileSize" | "mimeType" | "uri"
>;

/**
 * Uploads one picked file: privately, unless `visibility` is `"public"`.
 *
 * `label` is the *task* — "Citizenship", "Your selfie" — not the file name, for
 * the reason `uploads.ts` gives: "IMG 20260817 004312.jpg" in a progress toast
 * tells nobody what is happening.
 */
export async function uploadPublicFile(
  asset: PickedAsset,
  {
    label,
    onProgress,
    visibility = "private",
  }: {
    label: string;
    /** 0–1, for a screen that draws its own progress beside the global toaster's. */
    onProgress?: (fraction: number) => void;
    visibility?: "private" | "public";
  },
): Promise<PublicFile> {
  const rowId = startUpload(label);

  try {
    const uploaded = await runPublicUpload(asset, visibility, (fraction) => {
      updateUpload(rowId, { fraction, stage: "uploading" });
      if (fraction !== null) onProgress?.(fraction);
    });

    finishUpload(rowId);

    return uploaded;
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "That upload did not go through.";

    finishUpload(rowId, { error: message });

    throw caught;
  }
}

/**
 * Writes a run of text to a cache file and uploads it as `text/plain`.
 *
 * This is what makes the hostel form's "Rules & Policies" requirement
 * satisfiable on a phone. The website asks for a document because an owner
 * filling that form is sitting at a computer with one; the same requirement on a
 * handset means "go and find a PDF", which is where a registration is abandoned.
 * The three templates the website already offers are stored copy, so choosing one
 * here produces a real document with the same words in it — not a checkbox that
 * quietly submits nothing.
 *
 * Cache rather than documents: it exists to be uploaded, and once it is, the OS
 * may reclaim it whenever it likes.
 */
export async function uploadPublicText(
  text: string,
  { fileName, label }: { fileName: string; label: string },
): Promise<PublicFile> {
  const file = new File(Paths.cache, fileName);

  if (file.exists) {
    file.delete();
  }

  file.create();
  file.write(text);

  return uploadPublicFile(
    { fileName, mimeType: "text/plain", fileSize: file.size, uri: file.uri },
    { label },
  );
}

async function runPublicUpload(
  asset: PickedAsset,
  visibility: "private" | "public",
  onProgress: (fraction: number | null) => void,
): Promise<PublicFile> {
  const mimeType = resolveMimeType(asset);
  const fileName = resolveFileName(asset);
  const file = new File(asset.uri);

  /*
   * Measured off the file, never read from `asset.fileSize` — the picker
   * describes what it handed back, and these assets have been through
   * `allowsEditing` and a quality re-encode since. `uploads.ts` documents the
   * same trap at length; here the consequence is milder (a wrong size only makes
   * the 5 MB check wrong) but it is wrong in the direction that matters, letting
   * an over-size file through to be refused by the server.
   */
  const sizeBytes = file.exists ? file.size : (asset.fileSize ?? 0);

  const rejection = publicUploadError({ mimeType, sizeBytes });

  if (rejection) {
    throw new PublicUploadError(rejection);
  }

  onProgress(0);

  const result = await file.upload(`${API_BASE_URL}/api/v1/public/files/upload`, {
    fieldName: "file",
    httpMethod: "POST",
    mimeType,
    parameters: { visibility },
    onProgress: ({ bytesSent, totalBytes }) => {
      onProgress(totalBytes > 0 ? bytesSent / totalBytes : null);
    },
    /*
     * Multipart, because this route reads `formData().get("file")`. The presign
     * pipeline's PUT is `BINARY_CONTENT` — that one talks to R2, which wants the
     * bytes and nothing else. Sending binary content here produces a 422 "File is
     * required" from a request that did contain the file.
     */
    uploadType: UploadType.MULTIPART,
  });

  if (!result) {
    throw new PublicUploadError(
      "The upload did not reach the server. Check your connection and try again.",
    );
  }

  const payload = parseEnvelope(result.body);

  if (result.status < 200 || result.status >= 300 || !payload) {
    throw new PublicUploadError(
      payload && "message" in payload && payload.message
        ? payload.message
        : `The server refused that file (error ${result.status}).`,
    );
  }

  if (!payload.success) {
    throw new PublicUploadError(payload.message);
  }

  const { claimToken, fileAssetId } = payload.data;

  if (visibility === "private") {
    if (!fileAssetId || !claimToken) {
      throw new PublicUploadError("The server did not accept that document. Try again.");
    }

    return {
      claimToken,
      fileAssetId,
      fileName: payload.data.fileName || fileName,
      mimeType: payload.data.mimeType || mimeType,
      sizeBytes: payload.data.sizeBytes || sizeBytes,
      url: `${API_BASE_URL}/api/v1/files/${fileAssetId}/url?claim=${encodeURIComponent(claimToken)}`,
    };
  }

  return {
    fileName: payload.data.fileName || fileName,
    mimeType: payload.data.mimeType || mimeType,
    sizeBytes: payload.data.sizeBytes || sizeBytes,
    /*
     * Stored raw. With R2 configured this is already absolute; without it — a
     * developer machine, or a deploy whose R2 variables are missing — the route
     * answers `/uploads/hostel-photos/…`, and the server resolves a relative
     * URL against its own origin exactly as the website's form leaves it. Making
     * it absolute here would bake a LAN address into an application that a
     * reviewer opens next week, which is the trap `saved-hostels.ts` documents
     * for photos.
     */
    url: payload.data.url ?? "",
  };
}

type UploadPayload = ApiEnvelope<{
  claimToken?: string;
  fileAssetId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url?: string;
}>;

/**
 * The response body is a string here, not an axios-parsed object — this request
 * goes through the native uploader, which knows nothing about our envelope. A
 * non-JSON body is a real possibility (a proxy's HTML error page), so it degrades
 * to `null` and the status code carries the message instead.
 */
function parseEnvelope(body: string): ApiFailure | UploadPayload | null {
  try {
    return JSON.parse(body) as ApiFailure | UploadPayload;
  } catch {
    return null;
  }
}
