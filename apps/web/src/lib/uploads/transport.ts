import { apiUrl } from "@/lib/api-url";
import { refreshSession } from "@/lib/auth-refresh";
import { browserApi } from "@/lib/browser-api";
import type { FileAssetKind } from "@/lib/file-asset-kinds";

/**
 * Upload transports.
 *
 * `fetch()` cannot report request-body progress, so every byte-carrying request
 * here goes through XMLHttpRequest — that is the whole reason this module exists
 * rather than reusing {@link browserApi} for the upload leg. Small JSON calls
 * (the presign handshake) still use `browserApi` so they keep its 401-refresh
 * interceptor.
 */

export type UploadProgress = {
  loadedBytes: number;
  /** 0–100, clamped. `0` until the first progress event fires. */
  percent: number;
  totalBytes: number;
};

export type UploadResult = {
  /**
   * FileAsset id — set by the presigned ("asset") transport, and by a private
   * upload on the `public` target.
   */
  assetId?: string;
  /**
   * Private `public`-target uploads only: the token the registration submits to
   * claim `assetId` (`lib/registration-documents.ts`). Until then nobody owns the
   * file, and only this token opens it.
   */
  claimToken?: string;
  fileName: string;
  key?: string;
  mimeType: string;
  sizeBytes: number;
  /** Directly readable URL — set by the multipart transports only. */
  url?: string;
};

export class UploadError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export class UploadCanceledError extends Error {
  constructor() {
    super("Upload canceled.");
    this.name = "UploadCanceledError";
  }
}

type XhrOptions = {
  body: XMLHttpRequestBodyInit;
  headers?: Record<string, string>;
  method: "POST" | "PUT";
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  url: string;
  withCredentials?: boolean;
};

export function sendWithProgress(options: XhrOptions) {
  return new Promise<{ body: string; status: number }>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UploadCanceledError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(options.method, apiUrl(options.url), true);
    xhr.withCredentials = options.withCredentials ?? options.url.startsWith("/api/");

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }

    const onAbort = () => xhr.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      options.onProgress?.({
        loadedBytes: event.loaded,
        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
        totalBytes: event.total,
      });
    };

    xhr.onload = () => {
      cleanup();
      resolve({ body: xhr.responseText, status: xhr.status });
    };

    xhr.onerror = () => {
      cleanup();
      reject(
        new UploadError(
          "Network error while uploading. Check your connection and try again.",
        ),
      );
    };

    xhr.ontimeout = () => {
      cleanup();
      reject(new UploadError("The upload timed out. Please try again."));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new UploadCanceledError());
    };

    xhr.send(options.body);
  });
}

type ApiEnvelope = {
  data?: unknown;
  message?: string;
  success: boolean;
};

function parseEnvelope(body: string, status: number): unknown {
  let payload: ApiEnvelope;

  try {
    payload = JSON.parse(body) as ApiEnvelope;
  } catch {
    throw new UploadError(
      body.trim().startsWith("<!")
        ? `The server returned a page instead of a response (${status}). The upload endpoint may be unavailable.`
        : `The server sent an unreadable response (${status}).`,
      status,
    );
  }

  if (status < 200 || status >= 300 || !payload.success) {
    throw new UploadError(payload.message || "Upload failed.", status);
  }

  return payload.data;
}

/**
 * Presigned direct-to-R2 upload. Two legs: a JSON handshake that registers the
 * FileAsset row and mints a short-lived PUT URL, then the file itself straight
 * to storage — the bytes never pass through our server. Progress tracks the PUT
 * leg, which is all but 100% of the transfer.
 */
async function uploadViaPresignedUrl(
  file: File,
  options: {
    accessLevel: "PRIVATE" | "PROTECTED" | "PUBLIC";
    assetKind?: FileAssetKind;
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  },
): Promise<UploadResult> {
  const presign = await browserApi<{
    assetId: string;
    key: string;
    presignedUrl: string;
  }>("/api/v1/files/presign", {
    body: JSON.stringify({
      accessLevel: options.accessLevel,
      fileName: file.name,
      kind: options.assetKind,
      mimeType: file.type,
      sizeBytes: file.size,
    }),
    method: "POST",
  });

  const response = await sendWithProgress({
    body: file,
    headers: { "Content-Type": file.type },
    method: "PUT",
    onProgress: options.onProgress,
    signal: options.signal,
    url: presign.presignedUrl,
  });

  // R2 answers a presigned PUT with an empty body, so there is no envelope to read.
  if (response.status < 200 || response.status >= 300) {
    throw new UploadError(
      `Storage rejected the upload (${response.status}). Please try again.`,
      response.status,
    );
  }

  // Third leg: the server reads the object back and confirms it is what was
  // declared. Until this succeeds the asset is unusable, so a failure here is
  // an upload failure — not something to swallow and report as success.
  await browserApi(`/api/v1/files/${presign.assetId}/complete`, { method: "POST" });

  return {
    assetId: presign.assetId,
    fileName: file.name,
    key: presign.key,
    mimeType: file.type,
    sizeBytes: file.size,
  };
}

/**
 * Multipart upload through one of our own route handlers. Used where the caller
 * needs a directly usable URL back (public hostel registration documents) or
 * where the request must work without R2 configured — those routes fall back to
 * writing under `public/uploads/`.
 */
async function uploadViaMultipart(
  file: File,
  options: {
    accessLevel?: "PRIVATE" | "PROTECTED" | "PUBLIC";
    endpoint: string;
    onProgress?: (progress: UploadProgress) => void;
    requiresAuth: boolean;
    signal?: AbortSignal;
    visibility?: "private" | "public";
  },
): Promise<UploadResult> {
  const send = () => {
    const formData = new FormData();
    formData.append("file", file);

    if (options.accessLevel) {
      formData.append("accessLevel", options.accessLevel);
    }

    if (options.visibility) {
      formData.append("visibility", options.visibility);
    }

    return sendWithProgress({
      body: formData,
      method: "POST",
      onProgress: options.onProgress,
      signal: options.signal,
      url: options.endpoint,
      withCredentials: true,
    });
  };

  let response = await send();

  // Mirror browserApi's interceptor: an expired access token gets one refresh
  // and one replay before we surface the failure.
  if (response.status === 401 && options.requiresAuth && (await refreshSession())) {
    response = await send();
  }

  const data = parseEnvelope(response.body, response.status) as {
    claimToken?: string;
    fileAssetId?: string;
    fileName?: string;
    mimeType?: string;
    sizeBytes?: number;
    url?: string;
  };

  return {
    assetId: data.fileAssetId,
    claimToken: data.claimToken,
    fileName: data.fileName ?? file.name,
    mimeType: data.mimeType ?? file.type,
    sizeBytes: data.sizeBytes ?? file.size,
    url: data.url,
  };
}

/**
 * Where a file should go.
 *
 * - `asset` — authenticated, presigned direct-to-R2. Returns a FileAsset id and
 *   is the right default for anything referenced by id (photos, proofs).
 * - `authenticated-form` — authenticated multipart through our API. Returns a URL.
 * - `public` — unauthenticated multipart, rate limited, for the registration
 *   flows, where there is no hostel to scope a presign to. Private by default:
 *   the file is a registration document and comes back as `assetId` +
 *   `claimToken`. With `visibility: "public"` (images only) it is published and
 *   comes back as a URL.
 */
export type UploadTarget = "asset" | "authenticated-form" | "public";

export function sendUpload(
  file: File,
  options: {
    accessLevel?: "PRIVATE" | "PROTECTED" | "PUBLIC";
    assetKind?: FileAssetKind;
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
    target: UploadTarget;
    visibility?: "private" | "public";
  },
): Promise<UploadResult> {
  if (options.target === "asset") {
    return uploadViaPresignedUrl(file, {
      accessLevel: options.accessLevel ?? "PRIVATE",
      assetKind: options.assetKind,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  }

  return uploadViaMultipart(file, {
    accessLevel: options.accessLevel,
    endpoint:
      options.target === "public"
        ? "/api/v1/public/files/upload"
        : "/api/v1/files/upload",
    onProgress: options.onProgress,
    requiresAuth: options.target === "authenticated-form",
    signal: options.signal,
    visibility: options.target === "public" ? options.visibility : undefined,
  });
}
