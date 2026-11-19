"use client";

import * as React from "react";

import { useField } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/*
 * One field look for the whole web (docs/DESIGN.md §6 "Fields"), Claude-style:
 * a white 44px field with a thin warm-grey edge and `--radius` corners, a
 * darker edge on hover, a crisp green edge on focus and a red one when invalid.
 * `Input`, `InputGroup`, `Textarea` and the `Select` trigger all read from
 * these; the light-only auth pages copy the same values in `authInputClass`.
 */
export const fieldShell =
  "w-full min-w-0 rounded-lg border border-input-border bg-surface text-foreground caret-foreground transition-[color,box-shadow,border-color] outline-none hover:border-foreground/40";
export const fieldFocus =
  "focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary";
export const fieldInvalid =
  "aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive";
export const fieldDisabled = "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const field = useField();

  return (
    <input
      data-slot="input"
      {...props}
      type={type}
      id={props.id ?? field?.id}
      aria-describedby={props["aria-describedby"] ?? field?.describedBy}
      aria-invalid={props["aria-invalid"] ?? (field?.invalid || undefined)}
      className={cn(
        fieldShell,
        fieldFocus,
        fieldInvalid,
        fieldDisabled,
        "h-11 px-3 py-2 text-base placeholder:text-muted-foreground/70 md:text-sm file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className,
      )}
    />
  );
}

/**
 * A field with an icon or text inside its edge: `<InputGroup><InputGroupInput /><CircleCheck /></InputGroup>`.
 * The group carries the edge and the focus ring; svgs before or after the input
 * are the leading and trailing icons (muted unless they set their own colour).
 */
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        fieldShell,
        "flex h-11 items-center gap-2 px-3 text-muted-foreground focus-within:border-primary focus-within:ring-1 focus-within:ring-primary",
        "has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:focus-within:ring-destructive",
        "has-disabled:cursor-not-allowed has-disabled:bg-muted has-disabled:opacity-60",
        "[&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-full flex-1 rounded-none border-0 bg-transparent px-0 text-foreground hover:border-0 focus-visible:ring-0 aria-invalid:focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export { Input, InputGroup, InputGroupInput };
