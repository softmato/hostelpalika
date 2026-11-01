"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";

const BusyContext = createContext(false);

type BusyFormProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

/**
 * A `<form>` that knows when its async submit handler is still running, so
 * every `SubmitButton` inside it can show a spinner and block double-submits
 * without each page tracking its own boolean.
 *
 * The handler is invoked synchronously, so handlers that read
 * `event.currentTarget` before their first `await` keep working.
 */
export function BusyForm({ children, onSubmit, ...props }: BusyFormProps) {
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      const result = onSubmit(event);

      if (!(result instanceof Promise)) {
        return;
      }

      setBusy(true);
      void result.finally(() => setBusy(false));
    },
    [onSubmit],
  );

  return (
    <BusyContext.Provider value={busy}>
      <form {...props} onSubmit={handleSubmit}>
        {children}
      </form>
    </BusyContext.Provider>
  );
}

/** Submit button that spins while the surrounding `BusyForm` is submitting. */
export function SubmitButton({
  busyLabel,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "loading" | "type"> & {
  /** Shown in place of the label while the submit runs, e.g. "Processing…". */
  busyLabel?: string;
  children: ReactNode;
}) {
  const busy = useContext(BusyContext);

  return (
    <Button {...props} loading={busy} type="submit">
      {busy && busyLabel ? busyLabel : children}
    </Button>
  );
}
