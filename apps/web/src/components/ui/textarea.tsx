"use client";

import * as React from "react";

import { useField } from "@/components/ui/field";
import { fieldDisabled, fieldFocus, fieldInvalid, fieldShell } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  const field = useField();

  return (
    <textarea
      data-slot="textarea"
      {...props}
      id={props.id ?? field?.id}
      aria-describedby={props["aria-describedby"] ?? field?.describedBy}
      aria-invalid={props["aria-invalid"] ?? (field?.invalid || undefined)}
      className={cn(
        fieldShell,
        fieldFocus,
        fieldInvalid,
        fieldDisabled,
        "flex field-sizing-content min-h-24 px-3 py-2.5 text-base placeholder:text-muted-foreground/70 md:text-sm",
        className,
      )}
    />
  );
}

export { Textarea };
