"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { checkAuthWithRefresh } from "@/lib/auth-check";

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [retry, setRetry] = useState(0);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    checkAuthWithRefresh()
      .then((r) => {
        if (r.ok) {
          setOk(true);
        } else if (r.status === 401 || r.status === 403) {
          const next = encodeURIComponent(
            window.location.pathname + window.location.search,
          );
          router.replace(`/login?next=${next}`);
        } else {
          setUnavailable(true);
        }
      })
      .catch(() => {
        setUnavailable(true);
      });
  }, [router, retry]);

  if (unavailable && !ok) {
    return <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <p>We could not connect. Your session has been kept.</p>
      <button onClick={() => { setUnavailable(false); setRetry((value) => value + 1); }}>Try again</button>
    </div>;
  }

  if (!ok) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="size-8 animate-spin rounded-full border-4 border-brand-teal border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
