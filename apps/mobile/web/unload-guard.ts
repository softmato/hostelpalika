import { useEffect } from "react";

/** `@/lib/unload-guard` for the installable web app: the browser's own "Leave site?". */
export function useUnloadGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [active]);
}
