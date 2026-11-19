"use client";

import { Eye, EyeOff } from "@/components/icons";
import { useState, type ReactNode } from "react";

/**
 * The web's one field (docs/DESIGN.md §6 "Fields", `components/ui/input.tsx`)
 * written in literal light values: the auth screens sit on `bg-white` in both
 * themes, so the token version would turn dark here. Keep the two in step.
 * Login, signup, reset and unlock all pull from here.
 */
export const authInputClass =
  "h-11 w-full rounded-lg border border-[#d2cecb] bg-white px-3 text-base text-[#0F172A] caret-[#0F172A] outline-none transition placeholder:text-slate-400 hover:border-[#0F172A]/40 focus:border-[#0A8A4B] focus:ring-1 focus:ring-[#0A8A4B] md:text-sm";

export const authPrimaryButtonClass =
  "flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0A8A4B] text-sm font-semibold text-white transition hover:bg-[#0A8A4B]/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-300";

export function AuthHeading({ subtitle, title }: { subtitle: ReactNode; title: string }) {
  return (
    <div className="text-center">
      <h1 className="font-heading text-[34px] font-extrabold leading-tight tracking-tight text-[#0F172A]">
        {title}
      </h1>
      <p className="mt-2 text-[13px] text-slate-500">{subtitle}</p>
    </div>
  );
}

export function AuthError({ message }: { message: string }) {
  if (!message) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-600"
    >
      {message}
    </div>
  );
}

export function AuthField({
  children,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode;
  hint?: ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-[#0F172A]" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <div className="text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

type PasswordInputProps = {
  autoComplete: string;
  id: string;
  minLength?: number;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
};

export function PasswordInput({
  autoComplete,
  id,
  minLength,
  onChange,
  placeholder,
  value,
}: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative">
      <input
        autoComplete={autoComplete}
        className={`${authInputClass} pr-12`}
        id={id}
        minLength={minLength}
        name={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required
        type={isVisible ? "text" : "password"}
        value={value}
      />
      <button
        aria-label={isVisible ? "Hide password" : "Show password"}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
        onClick={() => setIsVisible((current) => !current)}
        type="button"
      >
        {isVisible ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
      </button>
    </div>
  );
}
