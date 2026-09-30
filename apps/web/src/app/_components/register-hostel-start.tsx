"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";

type Preview = { code: string; from: string; kind: "HOSTEL" | "PARTNER"; rewardText: string };

const FORM = "/register-hostel/form";

const noSubscribe = () => () => {};

/** The `?ref=` code on this page's URL, upper-cased. Empty on the server. */
export function useReferralCodeFromUrl() {
  return useSyncExternalStore(
    noSubscribe,
    () => new URLSearchParams(window.location.search).get("ref")?.trim().toUpperCase() ?? "",
    () => "",
  );
}

/**
 * Every "Register your hostel" button on the owner landing page. Asks first:
 * a normal registration, or one with a referral code — which is checked here,
 * so the owner sees what it gives before filling in five steps.
 *
 * Arriving on a `?ref=` link skips the question and opens on the code.
 */
export function RegisterHostelStart({ children, className }: { children: ReactNode; className: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"ask" | "code">("ask");
  const fromUrl = useReferralCodeFromUrl();
  const [typed, setCode] = useState<string | null>(null);
  const code = typed ?? fromUrl;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  const start = () => {
    setStep(code ? "code" : "ask");
    setPreview(null);
    setError("");
    setOpen(true);
  };

  const check = async () => {
    setChecking(true);
    setError("");

    try {
      setPreview(
        await browserApi<Preview>(`/api/v1/public/hostel-referral-codes/${encodeURIComponent(code.trim())}`),
      );
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : "That code could not be checked.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <button className={className} onClick={start} type="button">
        {children}
      </button>

      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          {step === "ask" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Do you have a referral code?</AlertDialogTitle>
                <AlertDialogDescription>
                  A code from another hostel or one of our partners adds free time to your plan.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <button
                  className={buttonVariants({ variant: "outline" })}
                  onClick={() => router.push(FORM)}
                  type="button"
                >
                  Normal registration
                </button>
                <button className={buttonVariants()} onClick={() => setStep("code")} type="button">
                  I have a referral code
                </button>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Enter your referral code</AlertDialogTitle>
                <AlertDialogDescription>
                  {preview
                    ? `From ${preview.from}.${preview.rewardText ? ` Your plan gets ${preview.rewardText} extra once your hostel goes live.` : ""}`
                    : "Type the code you were sent, then check it."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <input
                aria-label="Referral code"
                autoFocus
                className="h-11 rounded-md border border-border bg-background px-3 font-mono text-base uppercase tracking-widest outline-none focus:border-brand-teal"
                onChange={(event) => {
                  setCode(event.target.value.toUpperCase());
                  setPreview(null);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && code.trim() && !preview) {
                    void check();
                  }
                }}
                placeholder="EDUC9C0D1"
                value={code}
              />
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <AlertDialogFooter>
                <button
                  className={buttonVariants({ variant: "outline" })}
                  onClick={() => router.push(FORM)}
                  type="button"
                >
                  Skip, register normally
                </button>
                {preview ? (
                  <button
                    className={buttonVariants()}
                    onClick={() => router.push(`${FORM}?ref=${encodeURIComponent(preview.code)}`)}
                    type="button"
                  >
                    Continue with this code
                  </button>
                ) : (
                  <button
                    className={buttonVariants()}
                    disabled={checking || code.trim().length < 4}
                    onClick={() => void check()}
                    type="button"
                  >
                    {checking ? "Checking…" : "Check code"}
                  </button>
                )}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
