"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "@/components/icons";

import { BrandMark } from "@/components/brand-mark";
import { Role } from "@/lib/roles";

type GoogleAuthUser = {
  role: Role;
};

type GoogleAuthResponse =
  | {
      success: true;
      data: {
        user: GoogleAuthUser;
      };
      message: string;
    }
  | {
      success: false;
      errorCode: string;
      message: string;
    };

type GoogleCredentialResponse = {
  credential?: string;
};

type GoogleAuthButtonProps = {
  clientId: string;
  onError: (message: string) => void;
  onSuccess: (user: GoogleAuthUser) => void;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            callback: (response: GoogleCredentialResponse) => void;
            client_id: string;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              locale?: string;
              shape?: "rectangular" | "pill" | "circle" | "square";
              size?: "large" | "medium" | "small";
              text?: "signin_with" | "signup_with" | "continue_with" | "signin";
              theme?: "outline" | "filled_blue" | "filled_black";
              width?: number;
            },
          ) => void;
        };
      };
    };
  }
}

const googleScriptId = "google-identity-services";

export function GoogleAuthButton({
  clientId,
  onError,
  onSuccess,
}: GoogleAuthButtonProps) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!clientId || !buttonRef.current) {
      return;
    }

    let isMounted = true;

    async function handleGoogleCredential(response: GoogleCredentialResponse) {
      if (!response.credential) {
        onError("Google did not return a sign-in token.");
        return;
      }

      onError("");
      setIsSubmitting(true);

      try {
        const googleResponse = await fetch("/api/v1/auth/google", {
          body: JSON.stringify({ idToken: response.credential }),
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        const payload = (await googleResponse
          .json()
          .catch(() => null)) as GoogleAuthResponse | null;

        if (!googleResponse.ok || !payload?.success) {
          throw new Error(payload?.message ?? "Google sign-in failed.");
        }

        onSuccess(payload.data.user);
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "Google sign-in failed. Please try again.",
        );
      } finally {
        setIsSubmitting(false);
      }
    }

    function renderGoogleButton() {
      if (!isMounted || !window.google || !buttonRef.current) {
        return;
      }

      buttonRef.current.replaceChildren();
      window.google.accounts.id.initialize({
        callback: handleGoogleCredential,
        client_id: clientId,
      });
      const parentWidth = buttonRef.current.parentElement?.offsetWidth || 400;
      buttonRef.current.style.width = `${parentWidth}px`;
      window.google.accounts.id.renderButton(buttonRef.current, {
        locale: "en",
        shape: "rectangular",
        size: "large",
        text: "continue_with",
        theme: "outline",
        width: parentWidth,
      });
      setIsReady(true);
    }

    if (window.google) {
      renderGoogleButton();
      return () => {
        isMounted = false;
      };
    }

    const existingScript = document.getElementById(googleScriptId);
    const script =
      existingScript instanceof HTMLScriptElement
        ? existingScript
        : document.createElement("script");

    function handleScriptError() {
      if (isMounted) {
        onError("Could not load Google sign-in. Please try email login.");
      }
    }

    script.addEventListener("load", renderGoogleButton);
    script.addEventListener("error", handleScriptError);

    if (!existingScript) {
      script.async = true;
      script.defer = true;
      script.id = googleScriptId;
      script.src = "https://accounts.google.com/gsi/client";
      document.head.appendChild(script);
    }

    return () => {
      isMounted = false;
      script.removeEventListener("load", renderGoogleButton);
      script.removeEventListener("error", handleScriptError);
    };
  }, [clientId, onError, onSuccess]);

  return (
    <>
      {/* Google SDK renders the real button here when clientId + SDK are ready */}
      <div
        ref={buttonRef}
        className="w-full overflow-hidden rounded-xl google-auth-button-container"
      />

      {!clientId ? (
        /* No clientId configured — show a styled fallback */
        <button
          className="flex h-[52px] w-full items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white text-[14px] font-medium text-[#0F172A] shadow-sm transition hover:bg-slate-50 hover:border-slate-300"
          onClick={() =>
            onError(
              "Google sign-in is not configured. Add NEXT_PUBLIC_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_ID to enable it.",
            )
          }
          type="button"
        >
          {/* Google colour G logo */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
              fill="#4285F4"
            />
            <path
              d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
              fill="#34A853"
            />
            <path
              d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.548 0 9s.347 2.825.957 4.039l3.007-2.332z"
              fill="#FBBC05"
            />
            <path
              d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </button>
      ) : !isReady || isSubmitting ? (
        /* SDK loading or submitting — show a skeleton-style placeholder */
        <div className="flex h-[52px] w-full items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white text-[14px] text-slate-400 select-none">
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            xmlns="http://www.w3.org/2000/svg"
            className="opacity-40"
          >
            <path
              d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
              fill="#4285F4"
            />
            <path
              d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
              fill="#34A853"
            />
            <path
              d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.548 0 9s.347 2.825.957 4.039l3.007-2.332z"
              fill="#FBBC05"
            />
            <path
              d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
              fill="#EA4335"
            />
          </svg>
          {isSubmitting ? "Completing Google sign-in…" : "Continue with Google"}
        </div>
      ) : null}

      {/* Dedicated Full-Screen Google Authentication Transition Page */}
      {isSubmitting && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#F8FAFC]/98 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="flex flex-col items-center max-w-sm px-6 text-center">
            {/* Animated Logo / Icon Wrapper */}
            <div className="relative mb-8 flex items-center justify-center size-20 rounded-2xl bg-[#0A8A4B]/10 text-[#0A8A4B] shadow-inner">
              <BrandMark className="h-8 animate-pulse" />
              {/* Spinning Ring */}
              <div className="absolute -inset-2.5 rounded-3xl border-2 border-[#0A8A4B]/20 border-t-[#0A8A4B] animate-spin" />
            </div>

            {/* Content */}
            <h3 className="font-heading text-xl font-bold text-[#0F172A] tracking-tight">
              Authenticating with Google
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              Please wait while we secure your connection and load your workspace.
            </p>

            {/* Security Badge */}
            <div className="mt-8 flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-100 bg-[#EAF6F3] text-[#0A8A4B] text-[12px] font-semibold">
              <ShieldCheck className="size-4 animate-bounce" />
              <span>Establishing secure session...</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
