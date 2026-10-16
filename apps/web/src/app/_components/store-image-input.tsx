"use client";

import { GripVertical, ImagePlus, Link2, Loader2, X } from "@/components/icons";
import { useCallback, useId, useRef, useState, type DragEvent } from "react";

import { uploadFiles } from "@/lib/uploads/uploader";

/**
 * Picking the pictures for a product or a category.
 *
 * ## Two ways in, because the catalogue is stocked two ways
 *
 * A supplier sends a folder of photographs, or a link to their own listing.
 * Until now this was a single `Image URL` text box, so the second case was the
 * only supported one and the first meant hosting the file somewhere else first.
 * Both are here: drop or choose **many** files at once, or paste a list of URLs —
 * one per line, or comma separated, which is how they arrive in a message.
 *
 * ## The value is the API's own shape
 *
 * Every entry is `{ assetId }` or `{ url }` — exactly `productImage` in
 * `store.validation.ts`. Nothing is translated on the way out, so a change to
 * what the server accepts shows up here as a type error rather than as a
 * silently dropped field.
 *
 * ## The first one is the cover, and it says so
 *
 * `images[0]` is the thumbnail everywhere — the shop grid, the cart row, the
 * order line, the push notification. That is invisible in a plain list of
 * boxes, so the first tile is labelled and the arrows exist to make something
 * else the cover. Reordering is arrows rather than drag: this list is at most
 * eight items, and a drag implementation that works on a touchpad, a mouse and
 * a keyboard is a great deal of code for a job two buttons already do.
 *
 * ## Uploads go through the one pipeline
 *
 * `uploadFiles` registers every transfer with the global store, so the
 * always-mounted toaster shows byte-level progress and failures toast
 * themselves. This never draws its own progress bar.
 */

export type StoreImageValue = {
  /** An uploaded asset. Mutually exclusive with `url` in practice. */
  assetId?: string;
  /** A supplier's hosted image. */
  url?: string;
};

type Row = StoreImageValue & {
  /** Local key. `crypto.randomUUID` so two copies of one URL stay separable. */
  id: string;
  /** What to draw. An object URL for a just-uploaded file, else the URL itself. */
  previewUrl: string;
};

/** Same rule as `linkUrl` on the server: absolute http(s), or a same-origin path. */
function isUsableUrl(value: string) {
  return /^https?:\/\//i.test(value) || (value.startsWith("/") && !value.startsWith("//"));
}

/** One per line, comma separated, or whitespace separated — all three happen. */
function splitUrls(raw: string) {
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function rowFor(value: StoreImageValue, previewUrl: string): Row {
  return { ...value, id: crypto.randomUUID(), previewUrl };
}

/**
 * Rebuilds the rows for an existing record.
 *
 * An `assetId` with no object URL behind it — anything loaded from the server
 * rather than uploaded in this session — is previewed through the same
 * `/api/v1/files/:id/url` redirect the mobile app uses, so an edited product
 * shows its real artwork instead of a grey box.
 */
export function storeImageRows(values: readonly StoreImageValue[]): Row[] {
  return values.map((value) =>
    rowFor(
      value,
      value.url || (value.assetId ? `/api/v1/files/${value.assetId}/url` : ""),
    ),
  );
}

export function StoreImageInput({
  maxImages = 8,
  label,
  hint,
  onChange,
  rows,
  scope,
}: {
  hint?: string;
  label: string;
  /** Hard ceiling. The product schema allows 8; a category tile takes 1. */
  maxImages?: number;
  onChange: (rows: Row[]) => void;
  rows: Row[];
  /** Groups these transfers in the upload store, e.g. `store-product-images`. */
  scope: string;
}) {
  const [busy, setBusy] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [urlError, setUrlError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  const room = maxImages - rows.length;

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || room <= 0) {
        return;
      }

      setBusy(true);

      try {
        const accepted = files.slice(0, room);
        const outcomes = await uploadFiles(accepted, {
          accessLevel: "PUBLIC",
          kind: "image",
          label: label,
          optimizeImage: true,
          scope,
          // Failures already toast for themselves; a second summary per file
          // would be two notifications for one problem.
          silent: true,
        });

        const added = outcomes.flatMap((outcome) =>
          outcome.ok && outcome.result.assetId
            ? [
                rowFor(
                  { assetId: outcome.result.assetId },
                  // The bytes are already in the browser, so the preview costs
                  // nothing — no round trip to look at what was just sent.
                  URL.createObjectURL(outcome.file),
                ),
              ]
            : [],
        );

        if (added.length > 0) {
          onChange([...rows, ...added]);
        }
      } finally {
        setBusy(false);
      }
    },
    [label, onChange, room, rows, scope],
  );

  const addUrls = useCallback(() => {
    const entries = splitUrls(urlDraft);

    if (entries.length === 0) {
      return;
    }

    const bad = entries.find((entry) => !isUsableUrl(entry));

    if (bad) {
      // Said here rather than after the POST: the server rejects the whole
      // product for one bad link, and by then the message names a field index.
      setUrlError(`"${bad}" is not a link. Use https://… or a path starting with /.`);
      return;
    }

    setUrlError("");
    setUrlDraft("");
    onChange([
      ...rows,
      ...entries.slice(0, room).map((url) => rowFor({ url }, url)),
    ]);
  }, [onChange, room, rows, urlDraft]);

  const move = useCallback(
    (index: number, delta: number) => {
      const next = [...rows];
      const target = index + delta;

      if (target < 0 || target >= next.length) {
        return;
      }

      [next[index], next[target]] = [next[target], next[index]];
      onChange(next);
    },
    [onChange, rows],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      void addFiles(
        [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/")),
      );
    },
    [addFiles],
  );

  return (
    <div className="grid gap-2 text-sm font-semibold text-foreground">
      {label}

      <div
        className={`grid gap-3 rounded-md border border-dashed p-3 transition ${
          dragging ? "border-role-platform bg-role-platform/5" : "border-border"
        }`}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDrop={onDrop}
      >
        {rows.length > 0 ? (
          <ul className="grid grid-cols-4 gap-2">
            {rows.map((row, index) => (
              <li
                className="group relative aspect-square overflow-hidden rounded-md border border-border bg-muted"
                key={row.id}
              >
                {/* Artwork from an arbitrary supplier host — `next/image` would
                    need every one of them in `remotePatterns`, which turns
                    adding a product into a deploy. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" className="size-full object-cover" src={row.previewUrl} />

                {index === 0 ? (
                  <span className="absolute inset-x-0 top-0 bg-foreground/70 py-0.5 text-center text-[10px] font-bold text-background">
                    Cover
                  </span>
                ) : null}

                <button
                  aria-label="Remove this image"
                  className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-foreground/70 text-background opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
                  type="button"
                >
                  <X className="size-3" />
                </button>

                <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-foreground/60 py-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    aria-label="Move earlier"
                    className="px-1 text-[11px] font-bold text-background disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    type="button"
                  >
                    ←
                  </button>
                  <GripVertical className="size-3 text-background/70" />
                  <button
                    aria-label="Move later"
                    className="px-1 text-[11px] font-bold text-background disabled:opacity-30"
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, 1)}
                    type="button"
                  >
                    →
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input
            accept="image/*"
            className="hidden"
            id={inputId}
            multiple
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              // Cleared so choosing the same file twice still fires a change.
              event.target.value = "";
            }}
            ref={fileInput}
            type="file"
          />
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
            disabled={busy || room <= 0}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ImagePlus className="size-3.5" />
            )}
            Choose files
          </button>
          <p className="text-[11px] font-normal text-muted-foreground">
            {room > 0
              ? `or drop them here · ${room} more allowed`
              : `That is the maximum of ${maxImages}.`}
          </p>
        </div>

        <div className="grid gap-1.5">
          <div className="flex gap-2">
            <textarea
              className="min-h-[38px] flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs font-normal outline-none focus:border-role-platform"
              onChange={(event) => setUrlDraft(event.target.value)}
              placeholder="…or paste image links, one per line"
              rows={urlDraft.includes("\n") ? 3 : 1}
              value={urlDraft}
            />
            <button
              className="inline-flex h-9 shrink-0 items-center gap-2 self-start rounded-md border border-border px-3 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
              disabled={room <= 0 || urlDraft.trim().length === 0}
              onClick={addUrls}
              type="button"
            >
              <Link2 className="size-3.5" />
              Add links
            </button>
          </div>
          {urlError ? (
            <p className="text-[11px] font-normal text-destructive">{urlError}</p>
          ) : null}
        </div>
      </div>

      {hint ? (
        <p className="text-[11px] font-normal text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
