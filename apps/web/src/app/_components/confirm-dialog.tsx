"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { browserApi } from "@/lib/browser-api";

export type ConfirmOptions = {
  /** Label on the button that goes ahead. Say what will happen, not "OK". */
  actionLabel?: string;
  cancelLabel?: string;
  description: string;
  /**
   * Ask for the account PIN before going ahead. For the serious removals —
   * a resident, a staff member, a room — never for an everyday undoable one.
   * An account with no PIN (or a temporary login) just confirms.
   */
  pin?: boolean;
  /** `destructive` for anything that removes, revokes or cannot be undone. */
  tone?: "default" | "destructive";
  title: string;
};

type Resolver = (confirmed: boolean) => void;

/**
 * `window.confirm`, replaced.
 *
 * The native dialog is unstyled, ignores the theme, blocks the main thread and
 * cannot say more than one line — but its *shape* is the reason it kept getting
 * used: it returns a boolean right where the decision is made. This keeps that
 * shape and returns a promise instead, so a handler still reads
 * `if (!(await confirm({...}))) return;` while rendering a real
 * `AlertDialog` (focus-trapped, announced as `alertdialog`, and not dismissable
 * by a stray click on the overlay).
 *
 * ```tsx
 * const { confirm, confirmDialog } = useConfirm();
 * // …
 * if (!(await confirm({ title: "Delete post?", description: "…" }))) return;
 * // …
 * return <>{confirmDialog}…</>;
 * ```
 *
 * The promise resolves `false` on cancel, on Escape, and on unmount, so a
 * caller can never be left awaiting a dialog that is no longer on screen.
 */
export function useConfirm() {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  // The resolver lives only in a ref — it is not rendered, and keeping it out
  // of state means nothing is written to a ref during render.
  const resolverRef = useRef<Resolver | null>(null);
  // "loading" while we learn whether the account has a PIN at all.
  const [pinStep, setPinStep] = useState<"off" | "loading" | "ask">("off");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [checking, setChecking] = useState(false);

  const confirm = useCallback((options: ConfirmOptions) => {
    setPin("");
    setPinError("");
    setPinStep(options.pin ? "loading" : "off");

    if (options.pin) {
      browserApi<{ user: { hasLockPin?: boolean; viaTemporaryCredential?: boolean } }>("/api/v1/auth/me").then(
        ({ user }) => setPinStep(user.hasLockPin && !user.viaTemporaryCredential ? "ask" : "off"),
        () => setPinStep("ask"),
      );
    }

    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPending(options);
    });
  }, []);

  // A caller awaiting a dialog that has left the screen would hang forever.
  useEffect(() => {
    return () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    };
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setPending(null);
  }, []);

  const verifyPin = useCallback(async () => {
    if (pin.length !== 4 || checking) return;

    setChecking(true);
    setPinError("");

    try {
      await browserApi("/api/v1/auth/lock-pin/verify", { body: JSON.stringify({ pin }), method: "POST" });
      settle(true);
    } catch (caught) {
      setPin("");
      setPinError(caught instanceof Error ? caught.message : "Wrong PIN.");
    } finally {
      setChecking(false);
    }
  }, [checking, pin, settle]);

  const confirmDialog = (
    <AlertDialog
      onOpenChange={(open) => {
        // Covers Escape and any programmatic close, not just the Cancel button.
        if (!open) {
          settle(false);
        }
      }}
      open={pending !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {pinStep === "ask" ? (
          <label className="grid gap-2 text-sm font-semibold text-foreground">
            Enter your PIN to confirm
            <input
              // Not type="password": browsers ignore autocomplete="off" there and
              // fill the saved account password. A text field masked with CSS
              // keeps password managers out.
              autoComplete="one-time-code"
              autoFocus
              className="h-12 rounded-xl border border-border bg-background text-center text-xl tracking-[0.6em] outline-none [-webkit-text-security:disc] focus:border-primary"
              data-1p-ignore
              data-bwignore
              data-lpignore="true"
              name="confirm-pin"
              inputMode="numeric"
              maxLength={4}
              onChange={(event) => {
                setPinError("");
                setPin(event.target.value.replace(/\D/g, "").slice(0, 4));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void verifyPin();
                }
              }}
              type="text"
              value={pin}
            />
            {pinError ? <span className="text-xs font-medium text-destructive">{pinError}</span> : null}
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {pending?.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pinStep === "loading" || (pinStep === "ask" && (pin.length !== 4 || checking))}
            onClick={(event) => {
              if (pinStep === "off") {
                settle(true);
                return;
              }
              // Stay open: the PIN is checked first, and a wrong one keeps the dialog.
              event.preventDefault();
              void verifyPin();
            }}
            variant={pending?.tone === "destructive" ? "destructive" : "default"}
          >
            {checking ? "Checking…" : (pending?.actionLabel ?? "Confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, confirmDialog };
}
