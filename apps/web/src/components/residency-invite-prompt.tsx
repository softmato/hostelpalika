"use client";

import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { BedDouble, Building2, Loader2, Wallet } from "@/components/icons";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import type { ResidencyInvite } from "@/modules/residents/residency-invite.service";
import { type SessionUser, useSessionStore } from "@/stores/session-store";
import { toast } from "@/stores/toast-store";

/**
 * "Your hostel added you as a resident" — asked once, on any page, the first time
 * a signed-in public account whose email a hostel has opens the site
 * (docs/EXISTING_RESIDENTS.md; the rules live in `residency-invite.service.ts`).
 *
 * Continue links the account and moves them to their dashboard. "This is not me"
 * stops the question for good and tells the hostel to check the email. "Not now"
 * only closes it for this tab.
 */

const LATER_KEY = "hostelpalika:residency-invite-later";

function laterFor(residentId: string) {
  try {
    return sessionStorage.getItem(LATER_KEY) === residentId;
  } catch {
    return false;
  }
}

export function ResidencyInvitePrompt() {
  const user = useSessionStore((state) => state.user);
  const setUser = useSessionStore((state) => state.setUser);
  const [invite, setInvite] = useState<ResidencyInvite | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const isPublic = user?.role === "PUBLIC";

  useEffect(() => {
    // Only a signed-in public account can be asked. Asking signed-out would be a
    // 401, and `browserApi` answers a 401 by sending the page to the login screen.
    if (!isPublic) return;

    let live = true;

    browserApi<{ invite: ResidencyInvite | null }>("/api/v1/account/residency-invite")
      .then((result) => {
        if (live && result.invite && !laterFor(result.invite.residentId)) {
          setInvite(result.invite);
        }
      })
      .catch(() => {
        // Nothing to ask is the safe reading of any failure.
      });

    return () => {
      live = false;
    };
  }, [isPublic]);

  if (!invite) {
    return null;
  }

  async function accept() {
    if (!invite) return;

    setBusy("accept");

    try {
      const result = await browserApi<{ user: SessionUser }>(
        `/api/v1/account/residency-invite/${invite.residentId}/accept`,
        { method: "POST" },
      );

      setUser(result.user);
      // A full load, so every part of the page picks up the new resident session.
      window.location.assign("/resident/dashboard");
    } catch (error) {
      setBusy(null);
      toast.error({
        description: error instanceof Error ? error.message : undefined,
        title: "Could not continue",
      });
    }
  }

  async function decline() {
    if (!invite) return;

    setBusy("decline");

    try {
      await browserApi(`/api/v1/account/residency-invite/${invite.residentId}/decline`, {
        method: "POST",
      });
      setInvite(null);
      toast.success({ description: "We told the hostel to check the email.", title: "Thanks" });
    } catch (error) {
      toast.error({
        description: error instanceof Error ? error.message : undefined,
        title: "Could not save",
      });
    } finally {
      setBusy(null);
    }
  }

  function later() {
    if (!invite) return;

    try {
      sessionStorage.setItem(LATER_KEY, invite.residentId);
    } catch {
      // Closes for now either way.
    }

    setInvite(null);
  }

  return (
    <Dialog onOpenChange={(open) => (!open && !busy ? later() : undefined)} open>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <div className="mx-auto mb-1 flex size-12 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
            <Building2 className="size-6" />
          </div>
          <DialogTitle className="text-center">
            {invite.hostelName} added you as a resident
          </DialogTitle>
          <DialogDescription className="text-center">
            Hi {invite.firstName}, is this you? Continue to see your bills, notices and more.
          </DialogDescription>
        </DialogHeader>

        <div className="divide-y divide-border rounded-xl border border-border text-sm">
          <p className="flex items-center gap-3 px-4 py-3">
            <BedDouble className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">Room type</span>
            <span className="ml-auto font-semibold text-foreground">{roomTypeLabel(invite.roomType)}</span>
          </p>
          <p className="flex items-center gap-3 px-4 py-3">
            <Wallet className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">Rent</span>
            <span
              className={
                invite.dueAmount > 0
                  ? "ml-auto font-semibold text-warning"
                  : "ml-auto font-semibold text-success"
              }
            >
              {invite.dueAmount > 0
                ? `Rs ${invite.dueAmount.toLocaleString("en-IN")} due`
                : invite.paidTill
                  ? `All clear till ${invite.paidTill}`
                  : "All clear"}
            </span>
          </p>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <button
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-teal text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
            disabled={busy !== null}
            onClick={() => void accept()}
            type="button"
          >
            {busy === "accept" ? <Loader2 className="size-4 animate-spin" /> : null}
            Continue to my dashboard
          </button>
          <button
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-60"
            disabled={busy !== null}
            onClick={() => void decline()}
            type="button"
          >
            {busy === "decline" ? <Loader2 className="size-4 animate-spin" /> : null}
            This is not me
          </button>
          <button
            className="text-xs font-semibold text-muted-foreground transition hover:text-foreground"
            disabled={busy !== null}
            onClick={later}
            type="button"
          >
            Not now
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
