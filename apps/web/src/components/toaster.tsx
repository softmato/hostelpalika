"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  ImageIcon,
  Info,
  Loader2,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { formatBytes } from "@/lib/uploads/accepts";
import { cn } from "@/lib/utils";
import {
  canRetryDownload,
  cancelDownload,
  type DownloadItem,
  downloadRate,
  isDownloadActive,
  retryDownload,
  useDownloadStore,
} from "@/stores/download-store";
import { useToastStore, type ToastItem, type ToastTone } from "@/stores/toast-store";
import {
  canRetryUpload,
  cancelUpload,
  isActive,
  retryUpload,
  uploadRate,
  useUploadStore,
  type UploadItem,
} from "@/stores/upload-store";

/**
 * The one global feedback surface: live upload progress plus one-shot toasts.
 *
 * Mounted once in the root layout, so any upload started anywhere — public
 * registration, resident portal, admin portal — is reflected here without the
 * page doing anything. Brand green (`--brand-teal`) is the progress colour
 * throughout; red and amber are reserved for failures and warnings.
 */

/** How long a finished upload row lingers before it clears itself. */
const SUCCESS_LINGER_MS = 2600;
/** Rows shown before collapsing the rest into a "+N more" line. */
const MAX_VISIBLE_UPLOADS = 3;

/**
 * Each tone tints the whole card and fills its icon, so an error never reads as
 * another green "done" at a glance — a 4px stripe alone was too easy to miss.
 */
const TOAST_TONE: Record<
  ToastTone,
  { badge: string; border: string; icon: typeof Info; surface: string }
> = {
  error: {
    badge: "bg-destructive text-white",
    border: "border-destructive/50",
    icon: XCircle,
    surface: "bg-destructive/10",
  },
  info: {
    badge: "bg-foreground text-background",
    border: "border-border",
    icon: Info,
    surface: "bg-muted/60",
  },
  success: {
    badge: "bg-brand-teal text-white",
    border: "border-brand-teal/50",
    icon: CheckCircle2,
    surface: "bg-brand-teal/10",
  },
  warning: {
    badge: "bg-warning text-white",
    border: "border-warning/50",
    icon: AlertTriangle,
    surface: "bg-warning/10",
  },
};

function secondsLabel(seconds: number) {
  if (seconds < 1) {
    return "less than a second left";
  }

  if (seconds < 60) {
    return `${Math.ceil(seconds)}s left`;
  }

  return `${Math.ceil(seconds / 60)} min left`;
}

/** "1.2 MB of 4.0 MB · 820 KB/s · 4s left" — only the parts we actually know. */
function progressCaption(item: UploadItem) {
  if (item.status === "processing") {
    return "Finishing up…";
  }

  if (item.status === "queued") {
    return "Waiting to start…";
  }

  const { bytesPerSecond, etaSeconds } = uploadRate(item);
  const transferred = `${formatBytes(item.loadedBytes)} of ${formatBytes(item.sizeBytes)}`;

  const parts = [transferred];

  if (bytesPerSecond > 0) {
    parts.push(`${formatBytes(bytesPerSecond)}/s`);
  }

  if (etaSeconds !== null && etaSeconds > 0 && Number.isFinite(etaSeconds)) {
    parts.push(secondsLabel(etaSeconds));
  }

  return parts.join(" · ");
}

function UploadRowIcon({ item }: { item: UploadItem }) {
  if (item.status === "success") {
    return <CheckCircle2 className="size-4 text-brand-teal" />;
  }

  if (item.status === "error") {
    return <XCircle className="size-4 text-destructive" />;
  }

  if (item.status === "canceled") {
    return <X className="size-4 text-muted-foreground" />;
  }

  return <Loader2 className="size-4 animate-spin text-brand-teal" />;
}

const UploadRow = memo(function UploadRow({ item }: { item: UploadItem }) {
  const dismiss = useUploadStore((state) => state.dismiss);
  const active = isActive(item.status);
  const failed = item.status === "error";
  const FileIcon = item.mimeType.startsWith("image/") ? ImageIcon : FileText;

  // Successful rows clear themselves; failures stay so the retry stays reachable.
  useEffect(() => {
    if (item.status !== "success" && item.status !== "canceled") {
      return;
    }

    const timer = window.setTimeout(() => dismiss(item.id), SUCCESS_LINGER_MS);

    return () => window.clearTimeout(timer);
  }, [dismiss, item.id, item.status]);

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            failed
              ? "bg-destructive/10 text-destructive"
              : "bg-brand-teal/10 text-brand-teal",
          )}
        >
          <FileIcon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
              {item.label}
            </p>
            {active ? (
              <span className="shrink-0 text-[12px] font-bold tabular-nums text-brand-teal">
                {item.percent}%
              </span>
            ) : (
              <UploadRowIcon item={item} />
            )}
          </div>

          {item.label !== item.fileName ? (
            <p className="truncate text-[11px] text-muted-foreground">{item.fileName}</p>
          ) : null}

          {active ? (
            <>
              <div
                aria-label={`Uploading ${item.fileName}`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={item.percent}
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-brand-teal transition-[width] duration-200 ease-out",
                    item.status === "processing" && "animate-pulse",
                  )}
                  style={{ width: `${Math.max(item.percent, 3)}%` }}
                />
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {progressCaption(item)}
              </p>
            </>
          ) : (
            <p
              className={cn(
                "mt-0.5 truncate text-[11px]",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {item.status === "success"
                ? `Uploaded · ${formatBytes(item.sizeBytes)}`
                : item.status === "canceled"
                  ? "Canceled"
                  : (item.error ?? "Upload failed")}
            </p>
          )}
        </div>

        <div className="mt-0.5 flex shrink-0 items-center gap-1">
          {active ? (
            <button
              aria-label={`Cancel upload of ${item.fileName}`}
              className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={() => cancelUpload(item.id)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <>
              {failed && canRetryUpload(item.id) ? (
                <button
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-brand-teal transition hover:bg-brand-teal/10"
                  onClick={() => retryUpload(item.id)}
                  type="button"
                >
                  <RotateCcw className="size-3" />
                  Retry
                </button>
              ) : null}
              <button
                aria-label="Dismiss"
                className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                onClick={() => dismiss(item.id)}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

/**
 * The upload card: a single panel for the whole queue with an aggregate bar on
 * top, so five simultaneous uploads read as one clear "62% · 3 of 5 done"
 * instead of five competing toasts.
 */
function UploadStack() {
  const items = useUploadStore((state) => state.items);
  const clearFinished = useUploadStore((state) => state.clearFinished);

  const summary = useMemo(() => {
    const activeItems = items.filter((item) => isActive(item.status));
    const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
    // Weight each row's own percent by its size rather than summing raw bytes,
    // so the header never reads 100% while a row still says 99% / "Finishing up".
    const loadedBytes = items.reduce(
      (sum, item) =>
        sum +
        (item.status === "success"
          ? item.sizeBytes
          : (item.sizeBytes * item.percent) / 100),
      0,
    );

    return {
      activeCount: activeItems.length,
      doneCount: items.filter((item) => item.status === "success").length,
      failedCount: items.filter((item) => item.status === "error").length,
      percent:
        totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0,
    };
  }, [items]);

  if (items.length === 0) {
    return null;
  }

  const visible = items.slice(-MAX_VISIBLE_UPLOADS);
  const hidden = items.length - visible.length;
  const uploading = summary.activeCount > 0;

  const headline = uploading
    ? summary.activeCount === 1
      ? "Uploading 1 file"
      : `Uploading ${summary.activeCount} files`
    : summary.failedCount > 0
      ? `${summary.failedCount} upload${summary.failedCount === 1 ? "" : "s"} failed`
      : "All uploads complete";

  return (
    <div className="pointer-events-auto overflow-hidden rounded-xl border border-border bg-card shadow-lg animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-center gap-2 border-b border-border bg-surface-strong px-3 py-2">
        {uploading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-brand-teal" />
        ) : summary.failedCount > 0 ? (
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-brand-teal" />
        )}

        <p className="min-w-0 flex-1 truncate text-[12px] font-bold text-foreground">
          {headline}
        </p>

        {uploading ? (
          <span className="shrink-0 text-[12px] font-bold tabular-nums text-brand-teal">
            {summary.percent}%
          </span>
        ) : (
          <button
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={clearFinished}
            type="button"
          >
            Clear
          </button>
        )}
      </div>

      {/* Aggregate bar — the "how much, overall" read at a glance. */}
      {uploading ? (
        <div className="h-1 w-full bg-muted">
          <div
            className="h-full bg-brand-teal transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(summary.percent, 2)}%` }}
          />
        </div>
      ) : null}

      <div className="max-h-[42vh] divide-y divide-border overflow-y-auto">
        {visible.map((item) => (
          <UploadRow item={item} key={item.id} />
        ))}
      </div>

      {hidden > 0 ? (
        <p className="border-t border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
          +{hidden} more {hidden === 1 ? "file" : "files"} in this batch
        </p>
      ) : null}
    </div>
  );
}

/** "1.2 MB of 4.0 MB · 820 KB/s · 4s left", or just what has arrived so far. */
function downloadCaption(item: DownloadItem) {
  if (item.status === "saving") {
    return "Saving to your device…";
  }

  const { bytesPerSecond, etaSeconds } = downloadRate(item);

  /*
   * A streamed export sends no `Content-Length`, so there is no "of 4.0 MB" to
   * write and no honest ETA. Saying what has arrived is the whole truth
   * available, and it still moves — which is the part that tells somebody the
   * thing is working.
   */
  const parts = [
    item.sizeBytes > 0
      ? `${formatBytes(item.loadedBytes)} of ${formatBytes(item.sizeBytes)}`
      : formatBytes(item.loadedBytes),
  ];

  if (bytesPerSecond > 0) {
    parts.push(`${formatBytes(bytesPerSecond)}/s`);
  }

  if (etaSeconds !== null && etaSeconds > 0 && Number.isFinite(etaSeconds)) {
    parts.push(secondsLabel(etaSeconds));
  }

  return parts.join(" · ");
}

function DownloadRowIcon({ item }: { item: DownloadItem }) {
  if (item.status === "success") {
    return <CheckCircle2 className="size-4 text-brand-teal" />;
  }

  if (item.status === "error") {
    return <XCircle className="size-4 text-destructive" />;
  }

  if (item.status === "canceled") {
    return <X className="size-4 text-muted-foreground" />;
  }

  return <Loader2 className="size-4 animate-spin text-brand-teal" />;
}

const DownloadRow = memo(function DownloadRow({ item }: { item: DownloadItem }) {
  const dismiss = useDownloadStore((state) => state.dismiss);
  const active = isDownloadActive(item.status);
  const failed = item.status === "error";
  const FileIcon = item.mimeType.startsWith("image/") ? ImageIcon : FileText;

  // Successful rows clear themselves; failures stay so the retry stays reachable.
  useEffect(() => {
    if (item.status !== "success" && item.status !== "canceled") {
      return;
    }

    const timer = window.setTimeout(() => dismiss(item.id), SUCCESS_LINGER_MS);

    return () => window.clearTimeout(timer);
  }, [dismiss, item.id, item.status]);

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            failed
              ? "bg-destructive/10 text-destructive"
              : "bg-brand-teal/10 text-brand-teal",
          )}
        >
          <FileIcon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
              {item.label}
            </p>
            {active && item.percent !== null ? (
              <span className="shrink-0 text-[12px] font-bold tabular-nums text-brand-teal">
                {item.percent}%
              </span>
            ) : (
              <DownloadRowIcon item={item} />
            )}
          </div>

          {item.label !== item.fileName ? (
            <p className="truncate text-[11px] text-muted-foreground">{item.fileName}</p>
          ) : null}

          {active ? (
            <>
              <div
                aria-label={`Downloading ${item.fileName}`}
                aria-valuemax={100}
                aria-valuemin={0}
                // Omitted entirely when the size is unknown: that is what makes
                // a progressbar indeterminate to a screen reader, and a made-up
                // number here would be read aloud as fact.
                aria-valuenow={item.percent ?? undefined}
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
              >
                {item.percent === null ? (
                  /*
                   * No length header, so no width to set. A pulsing full bar
                   * says "working, size unknown"; a bar stuck at 0 says
                   * "nothing is happening", which is the reading that makes
                   * people click Export a second time.
                   */
                  <div className="h-full w-full animate-pulse rounded-full bg-brand-teal/50" />
                ) : (
                  <div
                    className={cn(
                      "h-full rounded-full bg-brand-teal transition-[width] duration-200 ease-out",
                      item.status === "saving" && "animate-pulse",
                    )}
                    style={{ width: `${Math.max(item.percent, 3)}%` }}
                  />
                )}
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {downloadCaption(item)}
              </p>
            </>
          ) : (
            <p
              className={cn(
                "mt-0.5 truncate text-[11px]",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {item.status === "success"
                ? `Downloaded · ${formatBytes(item.sizeBytes)}`
                : item.status === "canceled"
                  ? "Canceled"
                  : (item.error ?? "Download failed")}
            </p>
          )}
        </div>

        <div className="mt-0.5 flex shrink-0 items-center gap-1">
          {active ? (
            <button
              aria-label={`Cancel download of ${item.fileName}`}
              className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={() => cancelDownload(item.id)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <>
              {failed && canRetryDownload(item.id) ? (
                <button
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-brand-teal transition hover:bg-brand-teal/10"
                  onClick={() => retryDownload(item.id)}
                  type="button"
                >
                  <RotateCcw className="size-3" />
                  Retry
                </button>
              ) : null}
              <button
                aria-label="Dismiss"
                className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                onClick={() => dismiss(item.id)}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

/**
 * The download card — deliberately the same object as `<UploadStack />`.
 *
 * Its own component rather than a mode of that one, for the same reason
 * `download-store.ts` is its own store: the two share an appearance and almost
 * nothing else. A merged stack would have to headline a batch that is half
 * arriving and half leaving, and there is no true sentence for that.
 *
 * What they *do* share stays shared: `secondsLabel`, `formatBytes`,
 * `SUCCESS_LINGER_MS` and `MAX_VISIBLE_UPLOADS` are the same values from the
 * same file, so the two cards cannot drift in rhythm or in wording.
 */
function DownloadStack() {
  const items = useDownloadStore((state) => state.items);
  const clearFinished = useDownloadStore((state) => state.clearFinished);

  const summary = useMemo(() => {
    const activeItems = items.filter((item) => isDownloadActive(item.status));
    const measured = items.filter((item) => item.sizeBytes > 0);
    const totalBytes = measured.reduce((sum, item) => sum + item.sizeBytes, 0);
    const loadedBytes = measured.reduce(
      (sum, item) =>
        sum +
        (item.status === "success" ? item.sizeBytes : (item.sizeBytes * (item.percent ?? 0)) / 100),
      0,
    );

    return {
      activeCount: activeItems.length,
      doneCount: items.filter((item) => item.status === "success").length,
      failedCount: items.filter((item) => item.status === "error").length,
      /*
       * Null unless something in the batch declared a size. Averaging a known
       * row with an unknown one would put a confident number on a guess, and
       * the aggregate bar is the one place that number is read as authoritative.
       */
      percent:
        totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : null,
    };
  }, [items]);

  if (items.length === 0) {
    return null;
  }

  const visible = items.slice(-MAX_VISIBLE_UPLOADS);
  const hidden = items.length - visible.length;
  const downloading = summary.activeCount > 0;

  const headline = downloading
    ? summary.activeCount === 1
      ? "Downloading 1 file"
      : `Downloading ${summary.activeCount} files`
    : summary.failedCount > 0
      ? `${summary.failedCount} download${summary.failedCount === 1 ? "" : "s"} failed`
      : "All downloads complete";

  return (
    <div className="pointer-events-auto overflow-hidden rounded-xl border border-border bg-card shadow-lg animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-center gap-2 border-b border-border bg-surface-strong px-3 py-2">
        {downloading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-brand-teal" />
        ) : summary.failedCount > 0 ? (
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-brand-teal" />
        )}

        <p className="min-w-0 flex-1 truncate text-[12px] font-bold text-foreground">
          {headline}
        </p>

        {downloading ? (
          summary.percent === null ? null : (
            <span className="shrink-0 text-[12px] font-bold tabular-nums text-brand-teal">
              {summary.percent}%
            </span>
          )
        ) : (
          <button
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={clearFinished}
            type="button"
          >
            Clear
          </button>
        )}
      </div>

      {downloading ? (
        <div className="h-1 w-full bg-muted">
          {summary.percent === null ? (
            <div className="h-full w-full animate-pulse bg-brand-teal/50" />
          ) : (
            <div
              className="h-full bg-brand-teal transition-[width] duration-200 ease-out"
              style={{ width: `${Math.max(summary.percent, 2)}%` }}
            />
          )}
        </div>
      ) : null}

      <div className="max-h-[42vh] divide-y divide-border overflow-y-auto">
        {visible.map((item) => (
          <DownloadRow item={item} key={item.id} />
        ))}
      </div>

      {hidden > 0 ? (
        <p className="border-t border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
          +{hidden} more {hidden === 1 ? "file" : "files"} in this batch
        </p>
      ) : null}
    </div>
  );
}

const Toast = memo(function Toast({ toast: item }: { toast: ToastItem }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const tone = TOAST_TONE[item.tone];
  const Icon = tone.icon;

  useEffect(() => {
    if (item.duration <= 0) {
      return;
    }

    const timer = window.setTimeout(() => dismiss(item.id), item.duration);

    return () => window.clearTimeout(timer);
  }, [dismiss, item.duration, item.id]);

  return (
    <div
      className={cn(
        "pointer-events-auto overflow-hidden rounded-xl border bg-card shadow-xl animate-in fade-in slide-in-from-bottom-2",
        tone.border,
      )}
      role={item.tone === "error" ? "alert" : "status"}
    >
      <div className={cn("flex min-w-0 items-start gap-3 px-3 py-3", tone.surface)}>
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", tone.badge)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 self-center">
          <p className="break-words text-[13px] font-semibold text-foreground">{item.title}</p>
          {item.description ? (
            <p className="mt-0.5 break-words text-[12px] text-muted-foreground">
              {item.description}
            </p>
          ) : null}
        </div>
        <button
          aria-label="Dismiss notification"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={() => dismiss(item.id)}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
});

const noopSubscribe = () => () => {};

/** Hydration-safe "are we on the client yet" flag — `document` only exists there. */
function useIsHydrated() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Whether a modal dialog is currently on screen.
 *
 * The stack normally sits on the bottom edge, which is also where a dialog pins
 * its primary action — and the two are not in the same tree, so the toast wins
 * the hit test. On a phone that put the *upload* toast squarely over the
 * `Submit proof` button of the modal that started the upload: the resident
 * pressed Submit and pressed the toast instead. (What that used to cost them is
 * why `dialog.tsx` now refuses to close on an interaction inside here.)
 *
 * Read from the DOM rather than from a store, because a dialog is nobody's
 * child: `DialogContent` portals to `<body>`, this portals to `<body>`, and
 * neither knows the other exists. The observer only has to *fire* — the query
 * that follows searches the whole document — so a portal wrapper appearing
 * between Radix versions cannot make it miss.
 */
function useModalDialogOpen() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const read = () =>
      setOpen(Boolean(document.querySelector('[data-slot="dialog-content"]')));

    read();

    const observer = new MutationObserver(read);

    observer.observe(document.body, { childList: true });

    return () => observer.disconnect();
  }, []);

  return open;
}

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const uploads = useUploadStore((state) => state.items);
  const downloads = useDownloadStore((state) => state.items);
  const hydrated = useIsHydrated();
  const dialogOpen = useModalDialogOpen();

  if (
    !hydrated ||
    (toasts.length === 0 && uploads.length === 0 && downloads.length === 0)
  ) {
    return null;
  }

  // Portalled to <body> so the overlay escapes every ancestor's stacking
  // context, transform and overflow clipping — it floats above the page and
  // never takes part in its layout.

  return createPortal(
    <div
      aria-live="polite"
      // Read by `dialog.tsx`: an interaction in here is not the user clicking
      // away from a dialog, however far outside its tree this portal sits.
      data-app-toaster=""
      className={cn(
        "pointer-events-none fixed inset-x-0 z-[2147483000] flex flex-col items-end gap-2 p-3 sm:inset-x-auto sm:right-4 sm:left-auto sm:p-0",
        // Above the dialog rather than on its action. The top edge is the only
        // one a dialog does not pin anything important to — the close X lives
        // there, but Cancel, Escape and the backdrop all still close it, while a
        // covered Submit has no second way to be pressed.
        dialogOpen
          ? "top-0 bottom-auto sm:top-4 sm:bottom-auto"
          : "bottom-0 top-auto sm:bottom-4 sm:top-auto",
      )}
    >
      <div className="flex w-full max-w-full flex-col gap-2 sm:w-[352px]">
        {toasts.map((item) => (
          <Toast key={item.id} toast={item} />
        ))}
        <UploadStack />
        {/*
          Under the uploads, because an upload is something the user is waiting
          on before they can carry on and a download is not — if both are live,
          the one that blocks them should be the one nearest the top of the
          stack rather than the one that pushed it down.
        */}
        <DownloadStack />
      </div>
    </div>,
    document.body,
  );
}
