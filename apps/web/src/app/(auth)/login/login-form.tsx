"use client";

import { apiFetch } from "@/lib/api-url";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState, type FormEvent } from "react";

import { destinationForRole } from "@/lib/route-access";
import { Role } from "@/lib/roles";

import { AuthShell } from "../auth-shell";
import {
  AuthError,
  AuthField,
  AuthHeading,
  PasswordInput,
  authInputClass,
  authPrimaryButtonClass,
} from "../auth-fields";
import { GoogleAuthButton } from "../google-auth-button";

/* ─────────────────────── Types ─────────────────────── */
type LoginUser = { role: Role };
type LoginResponse =
  | { success: true; data: { user: LoginUser }; message: string }
  | { success: false; errorCode: string; message: string };

const routeErrorMessages: Record<string, string> = {
  forbidden: "Your account is not allowed to open that portal.",
  resident_removed:
    "Your hostel has removed your resident profile. Sign in again to keep using your account as a regular user, or contact your hostel if you think this is a mistake.",
  invalid_session: "Your session could not be verified. Please login again.",
  session_expired: "Your session expired. Please login again.",
};

/* ─────────────────────── Component ─────────────────── */
export function LoginForm({ googleClientId }: { googleClientId: string }) {
  return (
    <Suspense fallback={null}>
      <LoginFormContent googleClientId={googleClientId} />
    </Suspense>
  );
}

function LoginFormContent({ googleClientId }: { googleClientId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const routeError = searchParams.get("error");
  const visibleError =
    error || (routeError ? (routeErrorMessages[routeError] ?? "") : "");
  const nextParam = searchParams.get("next");
  const signupLink = nextParam
    ? `/signup?next=${encodeURIComponent(nextParam)}`
    : "/signup";

  /* helpers */
  function destinationAfterLogin(role: Role) {
    return destinationForRole(role, nextParam);
  }

  const handleGoogleSuccess = useCallback(
    (user: { role: Role }) => {
      router.push(destinationAfterLogin(user.role));
      router.refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, nextParam],
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const res = await apiFetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim().toLowerCase(),
          password,
        }),
      });
      const payload = (await res.json().catch(() => null)) as LoginResponse | null;
      if (!res.ok || !payload?.success)
        throw new Error(payload?.message ?? "Login failed.");
      router.push(destinationAfterLogin(payload.data.user.role));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  /* ── render ── */
  return (
    <AuthShell
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            className="font-semibold text-[#0A8A4B] hover:underline"
            href={signupLink}
          >
            Sign up
          </Link>
        </>
      }
      mode="login"
    >
      <div className="flex flex-col gap-7">
        <AuthHeading
          subtitle="Enter your email and password to access your account"
          title="Welcome back"
        />

        <AuthError message={visibleError} />

        <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
          <AuthField htmlFor="login-identifier" label="Email">
            <input
              autoComplete="username"
              className={authInputClass}
              id="login-identifier"
              name="identifier"
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="Enter your email or access username"
              required
              type="text"
              value={identifier}
            />
          </AuthField>

          <AuthField htmlFor="login-password" label="Password">
            <PasswordInput
              autoComplete="current-password"
              id="login-password"
              onChange={setPassword}
              placeholder="Enter your password"
              value={password}
            />
          </AuthField>

          <div className="flex items-center justify-between">
            <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-slate-500">
              <input
                className="size-4 cursor-pointer rounded border-slate-300 text-[#0A8A4B] focus:ring-[#0A8A4B]"
                type="checkbox"
              />
              Remember me
            </label>
            <Link
              className="text-[13px] text-slate-500 transition hover:text-[#0A8A4B]"
              href="/reset-password"
            >
              Forgot password
            </Link>
          </div>

          <div className="flex flex-col gap-3 pt-1">
            <button
              className={authPrimaryButtonClass}
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Signing in…" : "Sign in"}
            </button>

            <GoogleAuthButton
              clientId={googleClientId}
              onError={setError}
              onSuccess={handleGoogleSuccess}
            />
          </div>
        </form>
      </div>
    </AuthShell>
  );
}
