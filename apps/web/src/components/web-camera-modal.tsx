"use client";

import { Camera, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { centredGuide, cropRectForGuide } from "@/lib/capture-crop";

export function WebCameraModal({
  aspectRatio = 1,
  facingMode = "user",
  onCapture,
  onClose,
  title = "Take a photo",
}: {
  aspectRatio?: number;
  facingMode?: "environment" | "user";
  onCapture: (file: File) => void;
  onClose: () => void;
  title?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [currentFacingMode, setCurrentFacingMode] = useState<"environment" | "user">(facingMode);

  useEffect(() => {
    let active = true;
    let activeStream: MediaStream | null = null;

    async function startCamera() {
      setError("");
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: currentFacingMode },
            height: { ideal: 1080 },
            width: { ideal: 1920 },
          },
        });

        if (!active) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }

        activeStream = s;
        setStream(s);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      } catch {
        if (active) {
          setError(
            "Could not access camera. Please allow camera permissions or upload an image file.",
          );
        }
      }
    }

    void startCamera();

    return () => {
      active = false;
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [currentFacingMode]);

  function handleCapture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      return;
    }

    setCapturing(true);

    try {
      const containerWidth = video.clientWidth || video.videoWidth;
      const containerHeight = video.clientHeight || video.videoHeight;

      const guide = centredGuide({ height: containerHeight, width: containerWidth }, aspectRatio, 0.12);
      const crop = cropRectForGuide(
        { height: video.videoHeight, width: video.videoWidth },
        { height: containerHeight, width: containerWidth },
        guide,
      );

      const canvas = document.createElement("canvas");
      canvas.width = crop.width;
      canvas.height = crop.height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Could not create canvas context");
      }

      ctx.drawImage(
        video,
        crop.originX,
        crop.originY,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );

      canvas.toBlob((blob) => {
        setCapturing(false);
        if (!blob) {
          setError("Could not capture photograph.");
          return;
        }

        const file = new File([blob], `capture-${Date.now()}.png`, { type: "image/png" });
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
        }
        onCapture(file);
      }, "image/png");
    } catch {
      setCapturing(false);
      setError("Failed to crop camera frame.");
    }
  }

  function toggleCamera() {
    setCurrentFacingMode((prev) => (prev === "user" ? "environment" : "user"));
  }

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="font-heading text-base font-bold text-foreground">{title}</h3>
          <button
            aria-label="Close camera"
            className="rounded-md p-1.5 text-foreground/70 transition hover:bg-muted"
            onClick={() => {
              if (stream) {
                stream.getTracks().forEach((t) => t.stop());
              }
              onClose();
            }}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative flex min-h-[320px] flex-1 items-center justify-center bg-black overflow-hidden">
          {error ? (
            <div className="p-6 text-center text-sm font-semibold text-danger">
              {error}
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="size-full object-cover"
              />

              {/* Guide Frame Overlay */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div
                  className="border-2 border-brand-teal/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] transition-all"
                  style={{
                    aspectRatio: `${aspectRatio}`,
                    borderRadius: aspectRatio === 1 ? "9999px" : "16px",
                    width: "76%",
                  }}
                />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-6 py-4 bg-surface">
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-bold text-foreground transition hover:bg-muted"
            onClick={toggleCamera}
            type="button"
          >
            <RefreshCw className="size-3.5" />
            Switch camera
          </button>

          <button
            className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-brand-teal px-6 text-sm font-bold text-white shadow-lg transition hover:brightness-110 disabled:opacity-60"
            disabled={capturing || Boolean(error)}
            onClick={handleCapture}
            type="button"
          >
            <Camera className="size-5" />
            {capturing ? "Capturing…" : "Take Photo"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
