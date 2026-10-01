"use client";

import { ExternalLink, GraduationCap } from "lucide-react";

import { useSiteConfig } from "@/components/site-config-provider";
import { browserApi } from "@/lib/browser-api";

/**
 * The QuestionCall row, shown only to STUDENT residents (PHASES.md §5.1); the
 * app's resident home draws the same row.
 *
 * A plain link, not a button that fetches and then opens: a window opened after
 * a round trip is a popup the browser blocks. The click is recorded alongside.
 * On Android, a link into QuestionCall's `/app` scope opens its installed web
 * app instead of a tab; otherwise the page offers to install it.
 *
 * Label, link and switch are Website Config → Site Content → QuestionCall.
 */
export function ResidentQuestionCallCard() {
  const { questionCall } = useSiteConfig();

  if (!questionCall.enabled) {
    return null;
  }

  return (
    <a
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm transition hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      href={questionCall.url}
      onClick={() => {
        void browserApi("/api/v1/resident/questioncall/click", {
          body: JSON.stringify({ deviceType: "web" }),
          method: "POST",
        }).catch(() => undefined);
      }}
      // noopener/noreferrer: the partner tab must not get a handle on ours.
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
        <GraduationCap aria-hidden="true" className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">
          {questionCall.label}
        </span>
        <span className="block text-xs text-muted-foreground">
          Ask a tutor your study questions
        </span>
      </span>
      <ExternalLink aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}
