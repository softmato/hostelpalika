"use client";

import { Loader2, Minus, Plus, X } from "@/components/icons";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

/**
 * Square crop-and-zoom step, run before a photo is uploaded.
 *
 * Cropping here rather than server-side is deliberate: the resident sees exactly
 * the framing that will appear in the ID card's circular portrait, and only the
 * pixels they chose ever leave the device. What uploads is always a square
 * {@link OUTPUT}px JPEG, so the card and the header avatar can both render it
 * without any further fitting logic.
 */

/** On-screen crop window, in CSS pixels. */
const VIEWPORT = 320;
/** What actually gets uploaded. Square, so a circular mask cannot distort it. */
const OUTPUT = 512;
const MAX_ZOOM = 4;

type Offset = { x: number; y: number };

export function PhotoCropper({
  file,
  onCancel,
  onCropped,
}: {
  file: File;
  onCancel: () => void;
  /** Receives the cropped square, ready to upload. */
  onCropped: (cropped: File) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const [minScale, setMinScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ origin: Offset; pointerId: number; start: Offset } | null>(
    null,
  );

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const loaded = new Image();

    loaded.onload = () => {
      // The smallest zoom that still covers the window — the crop can never
      // contain a transparent corner.
      const fit = Math.max(VIEWPORT / loaded.naturalWidth, VIEWPORT / loaded.naturalHeight);

      setImage(loaded);
      setMinScale(fit);
      setScale(fit);
      setOffset({
        x: (VIEWPORT - loaded.naturalWidth * fit) / 2,
        y: (VIEWPORT - loaded.naturalHeight * fit) / 2,
      });
    };
    loaded.onerror = () => setError("That file could not be opened as an image.");
    loaded.src = url;

    return () => URL.revokeObjectURL(url);
  }, [file]);

  /** Keeps the image covering the window, so panning cannot expose an edge. */
  const clampOffset = useCallback(
    (next: Offset, atScale: number, source: HTMLImageElement) => {
      const width = source.naturalWidth * atScale;
      const height = source.naturalHeight * atScale;

      return {
        x: Math.min(0, Math.max(VIEWPORT - width, next.x)),
        y: Math.min(0, Math.max(VIEWPORT - height, next.y)),
      };
    },
    [],
  );

  const applyScale = useCallback(
    (nextScale: number) => {
      if (!image) {
        return;
      }

      const clampedScale = Math.min(minScale * MAX_ZOOM, Math.max(minScale, nextScale));

      setOffset((current) => {
        // Zoom about the centre of the window rather than the image origin, so
        // the face stays put instead of drifting toward a corner.
        const ratio = clampedScale / scale;
        const centre = VIEWPORT / 2;

        return clampOffset(
          {
            x: centre - (centre - current.x) * ratio,
            y: centre - (centre - current.y) * ratio,
          },
          clampedScale,
          image,
        );
      });
      setScale(clampedScale);
    },
    [clampOffset, image, minScale, scale],
  );

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !image) {
      return;
    }

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    canvas.width = VIEWPORT * dpr;
    canvas.height = VIEWPORT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);
    ctx.drawImage(
      image,
      offset.x,
      offset.y,
      image.naturalWidth * scale,
      image.naturalHeight * scale,
    );
  }, [image, offset, scale]);

  // Wheel-to-zoom has to be a non-passive listener, which JSX onWheel cannot be.
  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      applyScale(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }

    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => canvas.removeEventListener("wheel", onWheel);
  }, [applyScale, scale]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!image) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      origin: offset,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;

    if (!drag || !image || drag.pointerId !== event.pointerId) {
      return;
    }

    setOffset(
      clampOffset(
        {
          x: drag.origin.x + (event.clientX - drag.start.x),
          y: drag.origin.y + (event.clientY - drag.start.y),
        },
        scale,
        image,
      ),
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }

  function handleConfirm() {
    if (!image) {
      return;
    }

    setBusy(true);

    const output = document.createElement("canvas");
    output.width = OUTPUT;
    output.height = OUTPUT;

    const ctx = output.getContext("2d");

    if (!ctx) {
      setError("This browser could not prepare the image.");
      setBusy(false);
      return;
    }

    // Same framing as the preview, scaled up to the upload size.
    const factor = OUTPUT / VIEWPORT;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, OUTPUT, OUTPUT);
    ctx.drawImage(
      image,
      offset.x * factor,
      offset.y * factor,
      image.naturalWidth * scale * factor,
      image.naturalHeight * scale * factor,
    );

    output.toBlob(
      (blob) => {
        if (!blob) {
          setError("Could not prepare the image. Please try another photo.");
          setBusy(false);
          return;
        }

        onCropped(
          new File([blob], `id-card-photo-${Date.now()}.jpg`, { type: "image/jpeg" }),
        );
      },
      "image/jpeg",
      0.92,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div aria-hidden className="absolute inset-0" onClick={onCancel} />
      <div
        aria-modal
        className="relative flex w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl sm:max-w-md sm:rounded-2xl"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h2 className="font-heading text-lg font-extrabold text-foreground">
              Position your photo
            </h2>
            <p className="mt-1 text-sm text-foreground/90">
              Drag to move, zoom to fill. Only the circle ends up on your card.
            </p>
          </div>
          <button
            aria-label="Cancel"
            className="rounded-md p-1.5 text-foreground transition hover:bg-muted"
            onClick={onCancel}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          {error ? (
            <div className="rounded-lg border border-danger/25 bg-danger/5 p-3 text-xs font-semibold text-danger">
              {error}
            </div>
          ) : null}

          <div
            className="relative mx-auto overflow-hidden rounded-xl bg-muted"
            style={{ height: VIEWPORT, width: VIEWPORT }}
          >
            <canvas
              className="touch-none cursor-grab active:cursor-grabbing"
              onPointerCancel={handlePointerUp}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              ref={canvasRef}
              style={{ height: VIEWPORT, width: VIEWPORT }}
            />
            {/*
              Circular mask. An *outset* spread shadow on a round element dims
              everything outside the circle — the parent's overflow-hidden clips
              it back to the crop window.
            */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/80"
              style={{ boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)" }}
            />
            {!image && !error ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="size-6 animate-spin text-foreground/60" />
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <button
              aria-label="Zoom out"
              className="rounded-lg border border-border p-2 text-foreground transition hover:bg-muted"
              onClick={() => applyScale(scale / 1.2)}
              type="button"
            >
              <Minus className="size-4" />
            </button>
            <input
              aria-label="Zoom"
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-brand-teal"
              max={minScale * MAX_ZOOM}
              min={minScale}
              onChange={(event) => applyScale(Number(event.target.value))}
              step={minScale / 50}
              type="range"
              value={scale}
            />
            <button
              aria-label="Zoom in"
              className="rounded-lg border border-border p-2 text-foreground transition hover:bg-muted"
              onClick={() => applyScale(scale * 1.2)}
              type="button"
            >
              <Plus className="size-4" />
            </button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <button
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-brand-teal text-sm font-bold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
              disabled={!image || busy}
              onClick={handleConfirm}
              type="button"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Use this photo
            </button>
            <button
              className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-5 text-sm font-bold text-foreground transition hover:bg-muted sm:flex-none"
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
