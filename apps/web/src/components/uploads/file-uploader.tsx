"use client";

import { FileText, ImageIcon, Loader2, Paperclip, Upload, X } from "@/components/icons";
import { useCallback, useId, useState, type DragEvent } from "react";

import { PhotoCropper } from "@/components/photo-cropper";
import { formatBytes } from "@/lib/uploads/accepts";
import { cn } from "@/lib/utils";
import {
  useUploader,
  type UploadedAsset,
  type UploaderApi,
  type UseUploaderOptions,
} from "./use-uploader";

/**
 * The drop-in file field used across the site.
 *
 * Two entry points, one look:
 * - `<FileUploader …uploaderOptions />` when the screen only needs a field.
 * - `<FileUploaderView uploader={…} />` when the screen already holds a
 *   {@link useUploader} instance (because it needs the asset id for a submit,
 *   or wants to clear the field after saving).
 *
 * Progress is deliberately *not* duplicated inline — the global toaster is the
 * one place a user looks to see how far along an upload is.
 */

export type UploaderTone = "admin" | "brand" | "resident";

export type FileUploaderPresentation = {
  className?: string;
  /**
   * Run picked images through the square crop-and-zoom step before uploading.
   *
   * Use it wherever the image is shown at a fixed shape later — a card portrait,
   * an avatar — so the person frames it themselves instead of discovering the
   * app cropped their head off. Non-image files bypass the cropper and upload
   * as they are.
   */
  cropImages?: boolean;
  disabled?: boolean;
  hint?: string;
  label?: string;
  /** `lg` for a primary, page-level drop target; `sm` inside a dense form. */
  size?: "lg" | "sm";
  /** Accent colour, so a resident screen reads green and an admin screen cyan. */
  tone?: UploaderTone;
  variant?: "button" | "compact" | "dropzone";
};

const TONE_CLASSES = {
  admin: {
    borderActive: "border-role-admin",
    borderHover: "hover:border-role-admin",
    icon: "text-role-admin",
    soft: "bg-role-admin/10 text-role-admin",
    surface: "hover:bg-role-admin/5",
    text: "text-role-admin",
  },
  brand: {
    borderActive: "border-brand-teal",
    borderHover: "hover:border-brand-teal",
    icon: "text-brand-teal",
    soft: "bg-brand-teal/10 text-brand-teal",
    surface: "hover:bg-brand-teal/5",
    text: "text-brand-teal",
  },
  resident: {
    borderActive: "border-role-resident",
    borderHover: "hover:border-role-resident",
    icon: "text-role-resident",
    soft: "bg-role-resident/10 text-role-resident",
    surface: "hover:bg-role-resident/5",
    text: "text-role-resident",
  },
} as const;

/**
 * Where to read a just-uploaded asset back from, for the thumbnail.
 *
 * Multipart uploads hand back a directly readable `url`; asset uploads land in
 * private storage and are read through the files endpoint, which signs a URL for
 * the requested variant. Anything else has nothing to show.
 */
function previewSrc(file: UploadedAsset) {
  if (!file.mimeType.startsWith("image/") && !file.mimeType.startsWith("video/")) {
    return null;
  }

  if (file.url) {
    return file.url;
  }

  // Not yet claimed by an application, so nobody owns it: the claim token is
  // what proves the person looking is the person who uploaded it.
  if (file.assetId && file.claimToken) {
    return `/api/v1/files/${file.assetId}/url?variant=THUMBNAIL&claim=${encodeURIComponent(file.claimToken)}`;
  }

  return file.assetId ? `/api/v1/files/${file.assetId}/url?variant=THUMBNAIL` : null;
}

function AttachedFile({
  file,
  onRemove,
  tone,
}: {
  file: UploadedAsset;
  onRemove: () => void;
  tone: (typeof TONE_CLASSES)[UploaderTone];
}) {
  const Icon = file.mimeType.startsWith("image/") ? ImageIcon : FileText;
  const src = previewSrc(file);
  const isVideo = file.mimeType.startsWith("video/");

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        {/* The thumbnail is the point: a filename tells you nothing about
            whether you attached the right photo. */}
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg",
            src ? "bg-muted" : tone.soft,
          )}
        >
          {src ? (
            isVideo ? (
              <video className="size-full object-cover" muted src={src} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- preview of a freshly uploaded asset.
              <img alt={file.name} className="size-full object-cover" src={src} />
            )
          ) : (
            <Icon className="size-4" />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{file.name}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            Uploaded · {formatBytes(file.sizeBytes)}
          </p>
        </div>
      </div>
      <button
        aria-label={`Remove ${file.name}`}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
        onClick={onRemove}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function FileUploaderView({
  className,
  cropImages = false,
  disabled = false,
  hint,
  label = "Upload file",
  size = "sm",
  tone = "brand",
  uploader,
  variant = "dropzone",
}: FileUploaderPresentation & { uploader: UploaderApi }) {
  const [isDragging, setIsDragging] = useState(false);
  // Images waiting to be framed. Cropped one at a time, oldest first, so
  // picking several at once still gives each one its own decision.
  const [cropQueue, setCropQueue] = useState<File[]>([]);
  const inputId = useId();
  const toneClasses = TONE_CLASSES[tone];

  const busy = uploader.isUploading;
  const locked = disabled || busy || !uploader.canAddMore;

  /**
   * The single entry point for freshly picked files, whether they arrived by
   * drop or through the input — so the cropper cannot be sidestepped by
   * dragging a photo in.
   */
  const accept = useCallback(
    async (picked: File[]) => {
      if (picked.length === 0) {
        return;
      }

      if (!cropImages) {
        await uploader.uploadMany(picked);
        return;
      }

      const images = picked.filter((file) => file.type.startsWith("image/"));
      const rest = picked.filter((file) => !file.type.startsWith("image/"));

      if (rest.length > 0) {
        await uploader.uploadMany(rest);
      }

      if (images.length > 0) {
        setCropQueue((current) => [...current, ...images]);
      }
    },
    [cropImages, uploader],
  );

  const dropCropHead = useCallback(() => setCropQueue((current) => current.slice(1)), []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setIsDragging(false);

      if (locked) {
        return;
      }

      await accept(Array.from(event.dataTransfer.files ?? []));
    },
    [accept, locked],
  );

  const cropper = cropQueue[0] ? (
    <PhotoCropper
      file={cropQueue[0]}
      key={cropQueue[0].name + cropQueue[0].lastModified}
      onCancel={dropCropHead}
      onCropped={async (cropped) => {
        dropCropHead();
        await uploader.uploadMany([cropped]);
      }}
    />
  ) : null;

  const fileInput = (
    <input
      accept={uploader.accept}
      className="sr-only"
      disabled={locked}
      id={inputId}
      multiple={uploader.maxFiles > 1}
      onChange={async (event) => {
        const input = event.currentTarget;

        await accept(Array.from(input.files ?? []));
        // Cleared so re-picking the same file still fires a change event.
        input.value = "";
      }}
      type="file"
    />
  );

  const attached = uploader.files.map((file) => (
    <AttachedFile
      file={file}
      key={file.id}
      onRemove={() => uploader.remove(file.id)}
      tone={toneClasses}
    />
  ));

  if (variant === "button" || variant === "compact") {
    const compact = variant === "compact";

    return (
      <div className={cn("space-y-2", className)}>
        {cropper}
        {attached}
        {uploader.canAddMore ? (
          <label
            className={cn(
              "inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold transition",
              compact
                ? "border-border text-foreground hover:bg-muted"
                : cn("border-current", toneClasses.text, toneClasses.surface),
              locked && "cursor-not-allowed opacity-60",
            )}
            htmlFor={inputId}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : compact ? (
              <Paperclip className="size-3.5" />
            ) : (
              <Upload className="size-4" />
            )}
            {busy ? "Uploading…" : label}
            {fileInput}
          </label>
        ) : null}
      </div>
    );
  }

  const large = size === "lg";

  return (
    <div className={cn("space-y-2", className)}>
      {cropper}
      {attached}
      {uploader.canAddMore ? (
        <label
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-center transition",
            large ? "rounded-xl px-4 py-8" : "px-4 py-4",
            toneClasses.borderHover,
            toneClasses.surface,
            isDragging && cn("border-solid", toneClasses.borderActive),
            locked && "cursor-not-allowed opacity-60",
          )}
          htmlFor={inputId}
          onDragLeave={() => setIsDragging(false)}
          onDragOver={(event) => {
            event.preventDefault();
            if (!locked) {
              setIsDragging(true);
            }
          }}
          onDrop={handleDrop}
        >
          {busy ? (
            <Loader2
              className={cn(
                "animate-spin",
                large ? "mb-1 size-6" : "size-4",
                toneClasses.icon,
              )}
            />
          ) : (
            <Upload
              className={cn(
                large ? "mb-1 size-6" : "size-4",
                large ? toneClasses.icon : "text-muted-foreground",
              )}
            />
          )}
          <span
            className={cn("font-semibold text-foreground", large ? "text-sm" : "text-xs")}
          >
            {busy
              ? "Uploading…"
              : isDragging
                ? "Drop to upload"
                : large
                  ? `${label} — drag & drop or click`
                  : label}
          </span>
          <span
            className={cn("text-muted-foreground", large ? "text-xs" : "text-[10px]")}
          >
            {hint ?? uploader.hint}
          </span>
          {fileInput}
        </label>
      ) : null}
    </div>
  );
}

export type FileUploaderProps = FileUploaderPresentation & UseUploaderOptions;

/** Self-managed field: owns its own uploader instance. */
export function FileUploader({
  className,
  cropImages,
  disabled,
  hint,
  label,
  size,
  tone,
  variant,
  ...uploaderOptions
}: FileUploaderProps) {
  const uploader = useUploader(uploaderOptions);

  return (
    <FileUploaderView
      className={className}
      cropImages={cropImages}
      disabled={disabled}
      hint={hint}
      label={label}
      size={size}
      tone={tone}
      uploader={uploader}
      variant={variant}
    />
  );
}

/**
 * Screens with bespoke trigger markup (e.g. the hostel profile gallery's
 * "Add photo" chip) skip these components entirely: they call `useUploader`
 * — or `uploadFile` from `@/lib/uploads/uploader` — behind their own
 * `<input type="file">` and still get global progress for free.
 */
