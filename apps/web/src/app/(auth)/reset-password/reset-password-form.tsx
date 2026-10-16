"use client";

import { CheckCircle2 } from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import {
  AuthError,
  AuthField,
  AuthHeading,
  PasswordInput,
  authInputClass,
  authPrimaryButtonClass,
} from "../auth-fields";
import { AuthShell } from "../auth-shell";

type AuthResponse =
  | { success: true; message: string; data: unknown }
  | { success: false; message: string; errorCode: string };

async function authRequest(path: string, body: unknown) {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as AuthResponse | null;

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.message ?? "Request failed. Please try again.");
  }

  return payload.message;
}

export function ResetPasswordForm() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordFormContent />
    </Suspense>
  );
}

function ResetPasswordFormContent() {
  const searchParams = useSearchParams();
  // The emailed link carries the token. Without one the visitor arrived from
  // "Forgot password?" and needs to request a link first.
  const token = searchParams.get("token") ?? "";

  return (
    <AuthShell
      footer={
        <>
          Remembered it?{" "}
          <Link className="font-semibold text-[#0A8A4B] hover:underline" href="/login">
            Back to sign in
          </Link>
        </>
      }
      mode="login"
    >
      {token ? <SetNewPassword token={token} /> : <RequestResetLink />}
    </AuthShell>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-100 bg-[#EAF6F3] px-4 py-4">
      <CheckCircle2 className="size-5 shrink-0 text-[#0A8A4B]" />
      <div>{children}</div>
    </div>
  );
}

/** Step 1 — ask for the reset email. */
function RequestResetLink() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    const identifier = email.trim().toLowerCase();

    try {
      await authRequest("/api/v1/auth/forgot-password", { email: identifier });
      setSentTo(identifier);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not send the reset link. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-7">
        <AuthHeading
          subtitle="A reset link is on its way."
          title="Check your inbox"
        />
        <Notice>
          <p className="text-[13px] font-semibold text-[#0F172A]">Sent to {sentTo}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">
            The link expires in one hour and can only be used once. If it does not arrive,
            check your spam folder before requesting another.
          </p>
        </Notice>
        <button
          className="text-[13px] font-semibold text-[#0A8A4B] hover:underline"
          onClick={() => setSentTo("")}
          type="button"
        >
          Use a different email address
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <AuthHeading
        subtitle="Enter the email on your account and we'll send you a reset link."
        title="Reset password"
      />

      <AuthError message={error} />

      <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
        <AuthField htmlFor="reset-email" label="Email">
          <input
            autoComplete="email"
            className={authInputClass}
            id="reset-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Enter your email"
            required
            type="email"
            value={email}
          />
        </AuthField>

        <button className={authPrimaryButtonClass} disabled={isSubmitting} type="submit">
          {isSubmitting ? "Sending…" : "Send reset link"}
        </button>
      </form>
    </div>
  );
}

/** Step 2 — the visitor followed the emailed link and sets a new password. */
function SetNewPassword({ token }: { token: string }) {
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isDone, setIsDone] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      await authRequest("/api/v1/auth/reset-password", { newPassword, token });
      setIsDone(true);
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "Could not reset the password. Please request a new link.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isDone) {
    return (
      <div className="flex flex-col gap-7">
        <AuthHeading
          subtitle="Your password has been changed and every other session was signed out."
          title="Password updated"
        />
        <Notice>
          <p className="text-[12px] leading-relaxed text-slate-500">
            Signing out everywhere is deliberate — if someone else had access to the old
            password, that access is now gone.
          </p>
        </Notice>
        <Link className={authPrimaryButtonClass} href="/login">
          Continue to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <AuthHeading
        subtitle="Choose a new password for your account."
        title="Set a new password"
      />

      <AuthError message={error} />

      <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
        <AuthField htmlFor="new-password" label="New password">
          <PasswordInput
            autoComplete="new-password"
            id="new-password"
            minLength={8}
            onChange={setNewPassword}
            placeholder="At least 8 characters"
            value={newPassword}
          />
        </AuthField>

        <AuthField htmlFor="confirm-password" label="Confirm new password">
          <PasswordInput
            autoComplete="new-password"
            id="confirm-password"
            onChange={setConfirmPassword}
            placeholder="Re-enter the new password"
            value={confirmPassword}
          />
        </AuthField>

        <button className={authPrimaryButtonClass} disabled={isSubmitting} type="submit">
          {isSubmitting ? "Updating…" : "Reset password"}
        </button>
      </form>
    </div>
  );
}
