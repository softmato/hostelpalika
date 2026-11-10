"use client";

import { useState } from "react";

import { Check, Copy } from "@/components/icons";

/** Copies the chapter as Markdown — for pasting into a note, a chat, or an AI assistant. */
export function CopyMarkdown({ markdown }: { markdown: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="flex items-center gap-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(markdown).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        });
      }}
      type="button"
    >
      {done ? <Check aria-hidden className="size-4 text-primary" /> : <Copy aria-hidden className="size-4" />}
      {done ? "Copied" : "Copy as Markdown"}
    </button>
  );
}
