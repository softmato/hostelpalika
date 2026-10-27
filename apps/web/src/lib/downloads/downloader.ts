import { toast } from "@/stores/toast-store";
import { type DownloadItem, useDownloadStore } from "@/stores/download-store";
import { csvFilename, toCsv } from "@/lib/csv";
import { workspaceSlug } from "@/lib/browser-api";

/**
 * The universal downloader.
 *
 * Every file the site *retrieves* goes through {@link downloadFile}: it
 * registers a row in the global download store (which the always-mounted
 * toaster renders as a live progress bar), streams the bytes with byte-level
 * progress, and hands the result to the browser's download manager. Call sites
 * never touch fetch, streams or object URLs.
 *
 * The mirror of `lib/uploads/uploader.ts`, and the reason it exists: a report
 * export used to be a plain `<a href>`. That works, and it tells the user
 * nothing — a click on "Collection CSV" produced no feedback at all until the
 * browser's own download chip appeared, and on a slow query that is several
 * seconds of a page that looks broken. Worse, an `<a>` navigates on failure, so
 * an expired session answered "download my report" with a raw JSON error body
 * rendered as a page.
 *
 * ## Why this streams rather than awaiting `response.blob()`
 *
 * `blob()` resolves once, at the end. There is no progress in it, so the bar
 * would sit at 0 and then jump to done — which is a spinner with extra steps.
 * Reading `response.body` chunk by chunk is the only way the browser exposes
 * transfer progress on a fetch, and it is what makes this worth having over the
 * anchor it replaces.
 *
 * ## Credentials
 *
 * These routes are same-origin and cookie-authorised, so the default
 * `same-origin` credentials mode already sends the session. Nothing here reads
 * or forwards a token.
 */

/** A server that streams a report sends no length; the bar goes indeterminate. */
const UNKNOWN_SIZE = 0;

export type DownloadOptions = {
  /** The name the file is saved under. Include the extension. */
  fileName: string;
  /** Human name for the thing being fetched, e.g. "Collection report". */
  label?: string;
  /** Falls back to whatever the server declares, then to a generic binary. */
  mimeType?: string;
  /** Groups related downloads in the store so a screen can watch just its own. */
  scope?: string;
  /** Suppresses the success toast; failures always toast. */
  silent?: boolean;
  url: string;
};

export type DownloadOutcome = { error: string; ok: false } | { ok: true };

let sequence = 0;

function nextId() {
  sequence += 1;

  return `download-${sequence}-${Date.now()}`;
}

/**
 * Hands the assembled bytes to the browser.
 *
 * The object URL is revoked immediately: the click has already passed the blob
 * to the download manager, and holding the URL leaks it for the lifetime of the
 * document. Same note the resident statement page carried before this existed.
 */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.download = fileName;
  link.href = url;
  link.rel = "noopener";
  link.click();

  URL.revokeObjectURL(url);
}

export type TableFormat = "csv" | "pdf";

/**
 * Saves rows the screen already holds as a CSV or a PDF — the Export menus. No
 * server round trip: what is exported is exactly what the filters are showing.
 * The PDF is the same renderer the report routes use, loaded only when asked.
 */
export async function downloadTable(
  format: TableFormat,
  prefix: string,
  columns: Array<{ key: string; label: string }>,
  rows: Array<Record<string, unknown>>,
  options: { period?: string; scopeName?: string; title?: string } = {},
) {
  if (format === "csv") {
    saveBlob(new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8" }), csvFilename(prefix));
    return;
  }

  try {
    const { renderReportPdf } = await import("@/modules/reports/report-pdf");
    const bytes = await renderReportPdf({
      columns,
      generatedAt: new Date(),
      period: options.period,
      rows,
      scopeName: options.scopeName ?? "",
      title: options.title ?? prefix.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase()),
    });

    saveBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), csvFilename(prefix).replace(/\.csv$/, ".pdf"));
  } catch {
    toast.error("The PDF could not be made. Try the CSV.");
  }
}

/** The CSV half of {@link downloadTable}, for callers that only ever offered CSV. */
export function downloadCsv(
  prefix: string,
  columns: Array<{ key: string; label: string }>,
  rows: Array<Record<string, unknown>>,
) {
  void downloadTable("csv", prefix, columns, rows);
}

/**
 * Reads the whole body, reporting progress as it goes.
 *
 * Falls back to `response.blob()` when the browser gives us no readable stream —
 * older Safari, and any environment where `body` is null. The download still
 * works there; it just has no intermediate percentage, which is why the row's
 * `percent` is nullable rather than a lie about being at zero.
 */
async function readWithProgress(
  response: Response,
  total: number,
  onProgress: (loaded: number) => void,
): Promise<Blob> {
  const reader = response.body?.getReader();

  if (!reader) {
    return response.blob();
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded);
  }

  return new Blob(chunks as BlobPart[], {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
}

/**
 * Downloads one file, with a live row in the global toaster.
 *
 * Never throws. A failure is reported on the row, toasted, and returned — the
 * same contract `uploadFiles` keeps, so a call site is a one-liner with no
 * try/catch and no local `downloading` state beyond disabling its own button.
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadOutcome> {
  const { fileName, label, mimeType, scope = "default", silent = false, url } = options;

  const id = nextId();
  const store = useDownloadStore.getState();
  const controller = new AbortController();

  const item: DownloadItem = {
    fileName,
    id,
    label: label ?? fileName,
    loadedBytes: 0,
    mimeType: mimeType ?? "application/octet-stream",
    percent: null,
    scope,
    sizeBytes: UNKNOWN_SIZE,
    startedAt: Date.now(),
    status: "downloading",
  };

  store.register(item, {
    controller,
    retry: () => void downloadFile(options),
  });

  const update = useDownloadStore.getState().update;

  try {
    /*
     * A public image (the collection QR, a listing photo) is already on screen
     * through an `<img>`, which requests it without an Origin header. R2 answers
     * that with no CORS headers and no `Vary: Origin`, the browser caches it,
     * and a later `fetch` of the same URL reuses the cached copy — then rejects
     * it for lacking `Access-Control-Allow-Origin`, surfacing only as "Failed to
     * fetch". Skipping the cache for another origin makes the request carry its
     * Origin, and the bucket's CORS rule answers it.
     */
    const crossOrigin = new URL(url, window.location.href).origin !== window.location.origin;
    const slug = crossOrigin ? null : workspaceSlug();
    const response = await fetch(url, {
      cache: crossOrigin ? "no-store" : "default",
      // The branch this portal is on, as `browserApi` names it, so a branch's export is that branch's.
      headers: slug ? { "x-hostel-id": decodeURIComponent(slug) } : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      /*
       * Deliberately not the response body. These routes answer JSON on error
       * and a raw `{"success":false,...}` in a toast is worse than a sentence —
       * and the status is the part that tells the user whether to sign in again
       * or call someone.
       */
      throw new Error(
        response.status === 401 || response.status === 403
          ? "You are not signed in, or this is not yours to download."
          : `The server could not produce this file (${response.status}).`,
      );
    }

    const declared = Number(response.headers.get("content-length") ?? "");
    const total = Number.isFinite(declared) && declared > 0 ? declared : UNKNOWN_SIZE;

    if (total > 0) {
      update(id, { sizeBytes: total, percent: 0 });
    }

    const blob = await readWithProgress(response, total, (loaded) => {
      update(id, {
        loadedBytes: loaded,
        percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null,
      });
    });

    /*
     * A separate stage, because on a large export the browser's own write can
     * take a visible moment after the last byte — and a bar parked at 100% with
     * nothing happening reads as a hang.
     */
    update(id, {
      loadedBytes: blob.size,
      percent: 100,
      sizeBytes: blob.size,
      status: "saving",
    });

    saveBlob(blob, fileName);

    update(id, { endedAt: Date.now(), status: "success" });

    if (!silent) {
      toast.success({
        description: `${fileName} is in your downloads.`,
        title: "Downloaded",
      });
    }

    return { ok: true };
  } catch (error) {
    const canceled = error instanceof DOMException && error.name === "AbortError";
    const message = canceled
      ? "Download canceled."
      : error instanceof Error
        ? error.message
        : "The download failed.";

    update(id, {
      endedAt: Date.now(),
      error: message,
      status: canceled ? "canceled" : "error",
    });

    // A cancel is the user's own decision and needs no notification about it.
    if (!canceled) {
      toast.error({ description: message, title: "Could not download" });
    }

    return { error: message, ok: false };
  }
}
