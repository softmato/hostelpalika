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

/** Eases its content open/shut by animating the grid row from 0fr to 1fr. */
function Reveal({ children, open }: { children: ReactNode; open: boolean }) {
  return (
    <div
      aria-hidden={!open}
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

type Preview = { code: string; coverUrl: string | null; from: string; kind: "HOSTEL" | "PARTNER"; rewardText: string };

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
  // Kept after `preview`/`error` clear so their panels can ease shut with content still in them.
  const [shown, setShown] = useState<Preview | null>(null);
  const [lastError, setLastError] = useState("");
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
      const found = await browserApi<Preview>(
        `/api/v1/public/hostel-referral-codes/${encodeURIComponent(code.trim())}`,
      );
      setShown(found);
      setPreview(found);
    } catch (caught) {
      setPreview(null);
      const message = caught instanceof Error ? caught.message : "That code could not be checked.";
      setLastError(message);
      setError(message);
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
                <AlertDialogDescription key={preview ? "ok" : "ask"} className="animate-in fade-in duration-300">
                  {preview
                    ? preview.rewardText
                      ? `Code accepted. Your plan gets ${preview.rewardText} extra once your hostel goes live.`
                      : "Code accepted."
                    : "Type the code you were sent, then check it."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Reveal open={Boolean(preview)}>
                {shown ? (
                  <div className="flex items-center gap-3 pb-1">
                    {shown.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt={shown.from} className="size-14 shrink-0 rounded-lg object-cover" src={shown.coverUrl} />
                    ) : null}
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {shown.kind === "HOSTEL" ? "Referred by" : "Partner"}
                      </p>
                      <p className="truncate text-base font-semibold">{shown.from}</p>
                    </div>
                  </div>
                ) : null}
              </Reveal>
              <input
                aria-label="Referral code"
                autoFocus
                className={`h-11 rounded-md border bg-background px-3 font-mono text-base uppercase tracking-widest outline-none transition-[border-color,opacity,box-shadow] duration-300 ease-out focus:border-brand-teal ${
                  preview ? "border-success ring-2 ring-success/20" : "border-border"
                } ${checking ? "animate-pulse opacity-60" : ""}`}
                readOnly={checking}
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
              <Reveal open={Boolean(error)}>
                <p className="text-sm text-destructive">{error || lastError}</p>
              </Reveal>
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
