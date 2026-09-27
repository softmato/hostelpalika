"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

import {
  drawSignature,
  serializeSignature,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  signatureStrokes,
  type SignatureStroke,
} from "@/lib/signature";
import { cn } from "@/lib/utils";

/** Backing-store multiplier, so the ink is crisp on a high-density screen. */
const DENSITY = 2;

/**
 * Where the cardholder signs — mouse, pen or finger, through pointer events.
 * Reports the serialised strokes (lib/signature.ts) each time the pointer lifts.
 */
export function SignaturePad({
  invalid,
  onChange,
  value,
}: {
  invalid?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<SignatureStroke[]>(signatureStrokes(value));
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(() => signatureStrokes(value).length === 0);

  function paint() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");

    if (!canvas || !ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // The ink follows the theme here; the card itself always prints it dark.
    drawSignature(
      ctx,
      serializeSignature(strokes.current),
      { height: canvas.height, width: canvas.width, x: 0, y: 0 },
      getComputedStyle(canvas).color,
    );
  }

  useEffect(paint, []);

  function pointFrom(event: PointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();

    return [
      ((event.clientX - rect.left) / rect.width) * SIGNATURE_WIDTH,
      ((event.clientY - rect.top) / rect.height) * SIGNATURE_HEIGHT,
    ];
  }

  function handleDown(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    strokes.current = [...strokes.current, [pointFrom(event)]];
    setEmpty(false);
    paint();
  }

  function handleMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) {
      return;
    }

    const stroke = strokes.current[strokes.current.length - 1];
    const last = stroke?.[stroke.length - 1];
    const point = pointFrom(event);

    if (!stroke || !last || Math.hypot(point[0] - last[0], point[1] - last[1]) < 2) {
      return;
    }

    stroke.push(point);
    paint();
  }

  function handleUp() {
    if (!drawing.current) {
      return;
    }

    drawing.current = false;
    onChange(serializeSignature(strokes.current));
  }

  function clear() {
    strokes.current = [];
    setEmpty(true);
    paint();
    onChange("");
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border bg-background",
        invalid ? "border-danger" : "border-border",
      )}
    >
      <canvas
        aria-label="Signature pad — draw your signature"
        className="block aspect-[3/1] w-full cursor-crosshair touch-none text-foreground"
        height={SIGNATURE_HEIGHT * DENSITY}
        onPointerCancel={handleUp}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        ref={canvasRef}
        width={SIGNATURE_WIDTH * DENSITY}
      />
      <div className="pointer-events-none absolute inset-x-6 bottom-[24%] border-b border-dashed border-border" />
      {empty ? (
        <span className="pointer-events-none absolute bottom-[8%] left-6 text-xs text-foreground/55">
          Sign here
        </span>
      ) : (
        <button
          className="absolute right-2 top-2 rounded-md px-2 py-1 text-xs font-bold text-brand-teal transition hover:bg-muted"
          onClick={clear}
          type="button"
        >
          Clear
        </button>
      )}
    </div>
  );
}
