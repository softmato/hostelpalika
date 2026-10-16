"use client";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Maximize2,
  Play,
  X,
  ZoomIn,
  ZoomOut,
} from "@/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

export type LightboxItem = {
  caption?: string;
  /**
   * Images and videos play inline; PDFs fall back to an embedded frame. Left
   * unset, the extension in `src` decides.
   */
  kind?: "image" | "pdf" | "video";
  src: string;
  title?: string;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

function inferKind(item: LightboxItem): NonNullable<LightboxItem["kind"]> {
  if (item.kind) {
    return item.kind;
  }

  const path = item.src.split(/[?#]/)[0] ?? "";

  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(path)) return "video";

  return "image";
}

/**
 * In-app viewer for hostel photos and uploaded documents.
 *
 * Deliberately renders inside the page rather than opening a new tab — a
 * reviewer stepping through a listing's photos should never lose the portal.
 * Closes on backdrop click or Escape; ←/→ step through the set.
 */
export function MediaLightbox({
  index,
  items,
  onClose,
  onIndexChange,
}: {
  index: number;
  items: LightboxItem[];
  onClose: () => void;
  onIndexChange: (next: number) => void;
}) {
  const total = items.length;
  const current = items[index];
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // The origin lives in a ref (it changes per mousemove, and no render needs
  // it); whether a drag is in progress is state, because the cursor and the
  // transition depend on it.
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Stepping to another item starts it at full view. Adjusting state during
  // render (rather than in an effect) avoids rendering the new item once at
  // the previous item's zoom.
  const [zoomedIndex, setZoomedIndex] = useState(index);

  if (zoomedIndex !== index) {
    setZoomedIndex(index);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((delta: number) => {
    setZoom((previous) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, previous + delta));
      // Back at full view there is nothing to pan around.
      if (next === MIN_ZOOM) {
        setOffset({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (total === 0) return;
      onIndexChange((index + delta + total) % total);
    },
    [index, onIndexChange, total],
  );

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // **Stopped dead, not merely handled.** A dialog that opened this viewer
        // has its own Escape listener on `document`, so one press used to close
        // both — the receipt *and* the payment form behind it. Listening in the
        // capture phase (below) puts this first in the propagation path, and
        // `stopImmediatePropagation` halts every remaining listener for this
        // event, including ones already registered on `document` itself.
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        zoomBy(-ZOOM_STEP);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        resetZoom();
      }
    }

    // Capture phase: the viewer is the topmost surface on screen, so it gets
    // first refusal on the keys it owns — see the Escape branch above.
    document.addEventListener("keydown", handleKey, true);
    // Stop the page behind the overlay from scrolling while it is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKey, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, resetZoom, step, zoomBy]);

  // The viewer only ever opens from a click, so there is nothing to render on
  // the server — and createPortal needs a real document.
  if (!current || typeof document === "undefined") {
    return null;
  }

  const kind = inferKind(current);
  // Only a still image is worth panning around; video keeps its own controls.
  const canZoom = kind === "image";
  const zoomed = canZoom && zoom > MIN_ZOOM;

  return createPortal(
    <div
      aria-modal
      // **`pointer-events-auto` is load-bearing.** A modal Radix dialog sets
      // `pointer-events: none` on `document.body` and re-enables it only on its
      // own layer, so that nothing behind it can be clicked. This viewer portals
      // to `document.body` — so while a dialog is open it inherits that `none`
      // and becomes completely unclickable: the backdrop, the X and the arrows
      // all stop responding.
      //
      // That is the "first click does nothing, second click closes the whole
      // modal" report: the first click is swallowed by `pointer-events: none`,
      // and the second lands on the dialog's own overlay once the viewer is out
      // of the way. Declared here rather than in any one dialog, because the
      // viewer is the topmost surface on screen and must be interactive no
      // matter what is underneath it.
      className="pointer-events-auto fixed inset-0 z-[100] flex flex-col bg-slate-950/80 backdrop-blur-md"
      // How a dialog underneath recognises a click in here as *inside* the app
      // rather than as clicking itself away — see `isInsideMediaViewer` in
      // `ui/dialog`. This element is the portal root, so every part of the
      // viewer, backdrop included, is within it.
      data-media-lightbox=""
      onClick={onClose}
      role="dialog"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">
            {current.title ?? "Attachment"}
          </p>
          {total > 1 ? (
            <p className="text-[11px] text-white/60">
              {index + 1} of {total}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canZoom ? (
            <>
              <button
                aria-label="Zoom out"
                className="rounded-lg border border-white/20 p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                disabled={zoom <= MIN_ZOOM}
                onClick={(event) => {
                  event.stopPropagation();
                  zoomBy(-ZOOM_STEP);
                }}
                type="button"
              >
                <ZoomOut className="size-4" />
              </button>
              <span className="w-12 text-center text-[11px] tabular-nums text-white/70">
                {Math.round(zoom * 100)}%
              </span>
              <button
                aria-label="Zoom in"
                className="rounded-lg border border-white/20 p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                disabled={zoom >= MAX_ZOOM}
                onClick={(event) => {
                  event.stopPropagation();
                  zoomBy(ZOOM_STEP);
                }}
                type="button"
              >
                <ZoomIn className="size-4" />
              </button>
              <button
                aria-label="Reset zoom"
                className="rounded-lg border border-white/20 p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                disabled={!zoomed}
                onClick={(event) => {
                  event.stopPropagation();
                  resetZoom();
                }}
                type="button"
              >
                <Maximize2 className="size-4" />
              </button>
            </>
          ) : null}
          <a
            className="rounded-lg border border-white/20 p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white"
            download
            href={current.src}
            onClick={(event) => event.stopPropagation()}
            title="Download original"
          >
            <Download className="size-4" />
          </a>
          <button
            aria-label="Close viewer"
            className="rounded-lg border border-white/20 p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-4"
        onClick={(event) => event.stopPropagation()}
        onMouseLeave={() => {
          dragOrigin.current = null;
          setDragging(false);
        }}
        onMouseMove={(event) => {
          const origin = dragOrigin.current;
          if (!origin) return;
          setOffset({ x: event.clientX - origin.x, y: event.clientY - origin.y });
        }}
        onMouseUp={() => {
          dragOrigin.current = null;
          setDragging(false);
        }}
        onWheel={(event) => {
          if (!canZoom) return;
          zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
        }}
      >
        {total > 1 ? (
          <button
            aria-label="Previous"
            className="absolute left-3 z-10 rounded-full border border-white/20 bg-slate-900/60 p-2 text-white/80 transition hover:bg-slate-900 hover:text-white"
            onClick={() => step(-1)}
            type="button"
          >
            <ChevronLeft className="size-5" />
          </button>
        ) : null}

        {kind === "pdf" ? (
          <iframe
            className="h-full w-full max-w-4xl rounded-lg bg-white"
            src={current.src}
            title={current.title ?? "Document"}
          />
        ) : kind === "video" ? (
          <video
            className="max-h-full max-w-full rounded-lg shadow-2xl"
            controls
            playsInline
            src={current.src}
          />
        ) : (
          /* Remote R2 asset behind a redirecting presign route — next/image
             cannot resolve it, so a plain <img> is correct here. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={current.caption ?? current.title ?? "Attachment"}
            className={cn(
              "max-h-full max-w-full rounded-lg object-contain shadow-2xl",
              // No transition while dragging, or the image lags the cursor.
              dragging ? "" : "transition-transform",
              zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
            )}
            draggable={false}
            onDoubleClick={() => (zoomed ? resetZoom() : zoomBy(ZOOM_STEP * 2))}
            onMouseDown={(event) => {
              if (!zoomed) return;
              event.preventDefault();
              dragOrigin.current = {
                x: event.clientX - offset.x,
                y: event.clientY - offset.y,
              };
              setDragging(true);
            }}
            src={current.src}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            }}
          />
        )}

        {total > 1 ? (
          <button
            aria-label="Next"
            className="absolute right-3 z-10 rounded-full border border-white/20 bg-slate-900/60 p-2 text-white/80 transition hover:bg-slate-900 hover:text-white"
            onClick={() => step(1)}
            type="button"
          >
            <ChevronRight className="size-5" />
          </button>
        ) : null}
      </div>

      {current.caption ? (
        <p
          className="shrink-0 px-4 pb-4 text-center text-[12px] text-white/70"
          onClick={(event) => event.stopPropagation()}
        >
          {current.caption}
        </p>
      ) : null}

      {total > 1 ? (
        <div
          className="no-scrollbar flex shrink-0 justify-center-safe gap-2 overflow-x-auto px-4 pb-4"
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item, itemIndex) => (
            <button
              className={cn(
                "size-14 shrink-0 overflow-hidden rounded-md border-2 transition",
                itemIndex === index
                  ? "border-white"
                  : "border-transparent opacity-60 hover:opacity-100",
              )}
              key={`${item.src}-${itemIndex}`}
              onClick={() => onIndexChange(itemIndex)}
              type="button"
            >
              {inferKind(item) === "image" ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  alt=""
                  className="size-full bg-slate-800 object-cover"
                  src={item.src}
                />
              ) : (
                // A video or PDF has no still to show, so it gets a glyph.
                <span className="flex size-full items-center justify-center bg-slate-800 text-white/70">
                  {inferKind(item) === "video" ? (
                    <Play className="size-5" />
                  ) : (
                    <FileText className="size-5" />
                  )}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
