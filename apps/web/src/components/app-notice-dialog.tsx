"use client";

import { useEffect, useState } from "react";

import { Megaphone } from "@/components/icons";
import { useSiteConfig } from "@/components/site-config-provider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useSessionStore } from "@/stores/session-store";

const SEEN_KEY = "hostelpalika:app-notice-seen";

const AUDIENCE_ROLES: Record<string, string[] | null> = {
  EVERYONE: null,
  GUARDIANS: ["GUARDIAN"],
  HOSTEL_STAFF: ["HOSTEL_ADMIN", "WARDEN", "COOK"],
  RESIDENTS: ["RESIDENT"],
};

function seenId() {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Platform → Push → Sheet message, on the web: the app's "Update available"
 * sheet as a card, once per message per browser. Closing it is "seen".
 */
export function AppNoticeDialog() {
  const notice = useSiteConfig().appNotice;
  const role = useSessionStore((state) => state.user?.role);
  const [open, setOpen] = useState(false);

  const audience = notice ? AUDIENCE_ROLES[notice.audience] : undefined;
  const wanted = Boolean(notice?.id && notice.title && role && (audience === null || audience?.includes(role)));

  useEffect(() => {
    if (!wanted || !notice || seenId() === notice.id) return;
    // After the portal's own first paint and any PIN offer.
    const timer = window.setTimeout(() => setOpen(true), 2500);
    return () => window.clearTimeout(timer);
  }, [notice, wanted]);

  function close() {
    setOpen(false);
    try {
      if (notice) window.localStorage.setItem(SEEN_KEY, notice.id);
    } catch {
      // Shown again next load — harmless.
    }
  }

  if (!notice) return null;
  const action = notice.link && notice.buttonLabel ? notice : null;

  return (
    <Dialog onOpenChange={(next) => !next && close()} open={open}>
      <DialogContent className="sm:max-w-sm">
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <span className="flex size-20 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Megaphone className="size-9" />
          </span>
          <DialogTitle>{notice.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{notice.message}</DialogDescription>
        </div>
        <div className={action ? "grid gap-2 pt-2 sm:grid-cols-2" : "pt-2"}>
          {action ? (
            <>
              <button
                className="h-11 rounded-xl border border-border text-sm font-semibold transition hover:bg-muted"
                onClick={close}
                type="button"
              >
                Later
              </button>
              <a
                className="flex h-11 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground transition hover:brightness-110"
                href={action.link}
                onClick={close}
                rel="noopener noreferrer"
                target="_blank"
              >
                {action.buttonLabel}
              </a>
            </>
          ) : (
            <button
              className="h-11 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground transition hover:brightness-110"
              onClick={close}
              type="button"
            >
              OK
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
