"use client";

import { useState } from "react";

import { Fingerprint, LockKeyhole } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";

/**
 * The web side of the app's "Lock the app" sheet: one 4-digit PIN for the
 * account, the same one the phone asks for. Here it opens the portal after it
 * has been left idle. Biometric stays a phone thing for now, so the sheet says
 * so rather than offering a button that does nothing.
 *
 * `intro` is the offer on portal open; the account menu skips straight to the PIN.
 */
export function PinSetupDialog({
  intro,
  onOpenChange,
  onSaved,
  open,
}: {
  intro: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
}) {
  const [step, setStep] = useState<"intro" | "choose" | "confirm">(intro ? "intro" : "choose");
  const [first, setFirst] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Every open starts over: the offer from the top, the menu at the PIN.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep(intro ? "intro" : "choose");
      setFirst("");
      setPin("");
      setError("");
    }
  }

  async function type(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 4);
    setPin(digits);
    setError("");
    if (digits.length < 4) return;

    if (step === "choose") {
      setFirst(digits);
      setPin("");
      setStep("confirm");
      return;
    }

    if (digits !== first) {
      setPin("");
      setFirst("");
      setStep("choose");
      setError("Those did not match. Choose your PIN again.");
      return;
    }

    setBusy(true);
    try {
      await browserApi("/api/v1/auth/lock-pin", { body: JSON.stringify({ pin: digits }), method: "PUT" });
      toast.success({ description: "The website and the app both ask for it.", title: "PIN is on" });
      onSaved();
      onOpenChange(false);
    } catch (caught) {
      setPin("");
      setError(caught instanceof Error ? caught.message : "Could not save the PIN.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <span className="flex size-20 items-center justify-center rounded-full bg-primary/10 text-primary">
            <LockKeyhole className="size-9" />
          </span>
          <DialogTitle>
            {step === "intro" ? "Lock your portal" : step === "choose" ? "Choose a 4-digit PIN" : "Type it again"}
          </DialogTitle>
          <DialogDescription>
            {step === "intro"
              ? "Set a PIN and the portal asks for it after 30 minutes away. The same PIN opens the app."
              : "You will use it on the website and in the app."}
          </DialogDescription>
        </div>

        {step === "intro" ? (
          <div className="grid gap-2 pt-2 sm:grid-cols-2">
            <button
              className="h-11 rounded-xl border border-border text-sm font-semibold transition hover:bg-muted"
              onClick={() => onOpenChange(false)}
              type="button"
            >
              Remind me later
            </button>
            <button
              className="h-11 rounded-xl bg-primary text-sm font-bold text-primary-foreground transition hover:brightness-110"
              onClick={() => setStep("choose")}
              type="button"
            >
              Set up
            </button>
          </div>
        ) : (
          <div className="grid gap-2 pt-1">
            <input
              aria-label={step === "choose" ? "New PIN" : "Repeat PIN"}
              autoComplete="new-password"
              autoFocus
              className={cn(
                "h-14 w-full rounded-xl border bg-background text-center text-2xl font-bold tracking-[0.75em] outline-none transition focus:border-primary",
                error ? "border-destructive" : "border-border",
              )}
              disabled={busy}
              inputMode="numeric"
              key={step}
              maxLength={4}
              onChange={(event) => void type(event.target.value)}
              pattern="\d{4}"
              type="password"
              value={pin}
            />
            <p className={cn("min-h-4 text-center text-xs", error ? "text-destructive" : "text-muted-foreground")}>
              {busy ? "Saving…" : error}
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2.5">
          <Fingerprint className="size-5 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Biometric on the website is coming soon. Turn it on in the app.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
