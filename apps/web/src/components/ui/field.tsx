"use client";

import * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type FieldState = { describedBy?: string; id: string; invalid: boolean };

const FieldContext = React.createContext<FieldState | null>(null);

/** What the surrounding `Field` hands its control: id, hint/error link, invalid. */
export function useField() {
  return React.useContext(FieldContext);
}

/**
 * Label above, control, then one line under it: the error when there is one,
 * else the hint. `Input` / `InputGroupInput` inside pick up the id,
 * `aria-describedby` and `aria-invalid` from here, so call sites pass none.
 */
export function Field({
  children,
  className,
  error,
  hint,
  id,
  label,
  optional,
}: {
  children: React.ReactNode;
  className?: string;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  id?: string;
  label: React.ReactNode;
  optional?: boolean;
}) {
  const auto = React.useId();
  const controlId = id ?? auto;
  const message = error || hint;
  const messageId = `${controlId}-message`;

  return (
    <div className={cn("grid gap-1.5", className)} data-slot="field">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={controlId}>{label}</Label>
        {optional ? <span className="text-xs text-muted-foreground">Optional</span> : null}
      </div>
      <FieldContext.Provider
        value={{ describedBy: message ? messageId : undefined, id: controlId, invalid: Boolean(error) }}
      >
        {children}
      </FieldContext.Provider>
      {message ? (
        <p className={cn("text-[13px]", error ? "text-destructive" : "text-muted-foreground")} id={messageId}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
