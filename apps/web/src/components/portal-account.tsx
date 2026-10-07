"use client";

import { BadgePlus, ChevronDown, LogOut, QrCode, Smartphone, Users } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { checkAuthWithRefresh } from "@/lib/auth-check";
import { cn } from "@/lib/utils";
import { disableBrowserPush } from "@/lib/web-push-client";
import { type SessionUser, useSessionStore } from "@/stores/session-store";
import { signOutRequest } from "@/lib/sign-out";
import { GetAppDialog } from "@/components/get-app-dialog";
import { HostelPreviewLink } from "@/components/hostel-preview-link";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  ResidentIdentityCenter,
  requestResidentProfileForm,
  requestResidentQr,
} from "@/components/resident-identity";

type CurrentUser = {
  email: string | null;
  /** The account has an app-lock PIN — this portal asks again after idle time. */
  hasLockPin?: boolean;
  image?: string | null;
  name: string;
  /** The account has an app-lock PIN this browser has not typed yet. */
  pinLocked?: boolean;
  role: string;
  /** Null until they save their resident profile for the first time. */
  userResidentId?: string | null;
  viaTemporaryCredential?: boolean;
};

/** No click, key, scroll or touch for this long and the PIN is asked again. Mirrors `UNLOCK_IDLE_SECONDS`. */
const PIN_IDLE_MS = 30 * 60 * 1000;
/** Activity reaches the server at most this often. */
const PIN_TOUCH_EVERY_MS = 60 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

function toUnlock() {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.assign(`/unlock?next=${next}`);
}

/**
 * The portal of an account with a PIN, left open on a desk: after
 * {@link PIN_IDLE_MS} without activity it steps aside for `/unlock`. Moving
 * around never asks — activity slides the server's unlock cookie
 * (`/auth/lock-pin/touch`), so the API agrees with what this tab decides.
 */
function usePinIdleLock(active: boolean) {
  useEffect(() => {
    if (!active) return;

    let lastActivity = Date.now();
    // Zero, so the first activity on this page slides the cookie at once.
    let lastTouch = 0;

    function check() {
      if (Date.now() - lastActivity >= PIN_IDLE_MS) toUnlock();
    }

    function onActivity() {
      const now = Date.now();

      // Back at a tab left past the limit: the tap that woke it does not count.
      if (now - lastActivity >= PIN_IDLE_MS) {
        toUnlock();
        return;
      }

      lastActivity = now;
      if (now - lastTouch < PIN_TOUCH_EVERY_MS) return;
      lastTouch = now;

      void fetch("/api/v1/auth/lock-pin/touch", { credentials: "include", method: "POST" })
        .then((response) => {
          if (response.status === 423) toUnlock();
        })
        .catch(() => {});
    }

    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 30_000);

    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [active]);
}

type MeResponse =
  | {
      data: {
        user: CurrentUser;
      };
      success: true;
    }
  | {
      message: string;
      success: false;
    };

type PortalTone =
  "platform" | "admin" | "resident" | "guardian" | "team" | "cook" | "provider";

function readableRole(role: string) {
  return role
    .toLowerCase()
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

const toneRing: Record<PortalTone, string> = {
  admin: "ring-role-admin/20",
  guardian: "ring-role-guardian/20",
  platform: "ring-role-platform/20",
  resident: "ring-role-resident/20",
  team: "ring-role-team/20",
  cook: "ring-role-team/20",
  provider: "ring-role-team/20",
};

const toneBg: Record<PortalTone, string> = {
  admin: "bg-role-admin-soft text-role-admin",
  guardian: "bg-role-guardian-soft text-role-guardian",
  platform: "bg-role-platform-soft text-role-platform",
  resident: "bg-role-resident-soft text-role-resident",
  team: "bg-role-team-soft text-role-team",
  cook: "bg-role-team-soft text-role-team",
  provider: "bg-role-team-soft text-role-team",
};

export function PortalAccount({
  tone = "platform",
  showPortalActions = false,
}: {
  tone?: PortalTone;
  showPortalActions?: boolean;
}) {
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [getAppOpen, setGetAppOpen] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  usePinIdleLock(Boolean(user?.hasLockPin && !user.viaTemporaryCredential));

  const loadCurrentUser = useCallback(async () => {
    try {
      const response = await checkAuthWithRefresh();
      const payload = (await response.json().catch(() => null)) as MeResponse | null;

      if (!response.ok || !payload?.success) {
        throw new Error(
          payload && !payload.success ? payload.message : "Unable to load account.",
        );
      }

      if (payload.data.user.pinLocked) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.assign(`/unlock?next=${next}`);
        return;
      }

      setUser(payload.data.user);
      // Shared with the rest of the portal: the suspension gate reads this same
      // answer rather than asking `/auth/me` again, where a second refresh
      // racing this one would rotate the token out from under it.
      useSessionStore.getState().setUser(payload.data.user as unknown as SessionUser);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Unable to load account.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred so the first paint is not blocked by a cascading setState —
    // same pattern as PublicHeader.
    const timer = window.setTimeout(() => {
      void loadCurrentUser();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadCurrentUser]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  async function handleLogout() {
    setIsLoggingOut(true);
    setError("");

    try {
      /*
       * Release this browser's push subscription **before** the session goes.
       * The unsubscribe route is authenticated and scoped to the caller, so
       * after the logout there is no longer anybody able to revoke it — and a
       * row left ACTIVE keeps delivering this account's invoices, complaint
       * replies and SOS alerts to a machine they have signed out of. Same leak
       * `revokeDeviceToken` closed for phones.
       *
       * Never allowed to hold up or fail the sign-out.
       */
      await disableBrowserPush().catch(() => false);

      await signOutRequest();
    } finally {
      window.location.assign("/login");
    }
  }

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "HH";

  return (
    <div
      className="relative"
      ref={menuRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") setMenuOpen(false);
      }}
    >
      <button
        aria-label="Account and portal actions"
        aria-expanded={menuOpen}
        className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-2 shadow-sm transition hover:bg-slate-50 dark:border-border dark:bg-card dark:hover:bg-muted sm:pr-2.5"
        onClick={() => setMenuOpen((open) => !open)}
        type="button"
      >
        {user?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt=""
            className={cn("size-8 rounded-full object-cover ring-2", toneRing[tone])}
            src={user.image}
          />
        ) : (
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full text-xs font-bold ring-2 ring-white dark:ring-card",
              toneBg[tone],
            )}
          >
            {isLoading ? "…" : initials}
          </span>
        )}
        <span className="hidden min-w-0 text-left sm:block">
          {isLoading ? (
            <>
              <span className="block text-xs font-semibold text-foreground">
                Loading…
              </span>
              <span className="block text-[10px] text-muted-foreground">Session</span>
            </>
          ) : error ? (
            <>
              <span className="block text-xs font-semibold text-rose-600">
                Session issue
              </span>
              <span className="block max-w-[120px] truncate text-[10px] text-muted-foreground">
                {error}
              </span>
            </>
          ) : user ? (
            <>
              <span className="block max-w-[120px] truncate text-xs font-semibold text-foreground">
                {user.name}
              </span>
              <span className="block text-[10px] text-muted-foreground">
                {readableRole(user.role)}
              </span>
            </>
          ) : (
            <>
              <span className="block text-xs font-semibold text-foreground">Guest</span>
              <span className="block text-[10px] text-muted-foreground">
                Not signed in
              </span>
            </>
          )}
        </span>
        <ChevronDown className="hidden size-3.5 text-slate-400 sm:block" />
      </button>

      {menuOpen ? (
        <div className="absolute right-0 top-full z-50 mt-2 max-h-[calc(100dvh-6rem)] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl border border-border bg-card p-1.5 shadow-lg">
          {user ? (
            <div className="border-b border-slate-100 px-3 py-2 dark:border-border">
              <p className="truncate text-sm font-semibold text-foreground">
                {user.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {user.email ?? readableRole(user.role)}
              </p>
            </div>
          ) : null}
          {showPortalActions ? (
            <div className="border-b border-border py-1.5">
              <Link
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
                href="/community"
                onClick={() => setMenuOpen(false)}
              >
                <Users className="size-4" /> Community
              </Link>
              {tone === "admin" ? (
                <HostelPreviewLink menu onNavigate={() => setMenuOpen(false)} />
              ) : null}
              <button
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setGetAppOpen(true);
                }}
              >
                <Smartphone className="size-4" /> Get the app
              </button>
            </div>
          ) : null}
          {/* Shown to everyone: with no profile yet, the QR modal opens the
              create form instead. */}
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            onClick={() => {
              setMenuOpen(false);
              requestResidentQr();
            }}
            type="button"
          >
            <QrCode className="size-4" />
            Resident ID card
          </button>
          {!user?.userResidentId && (
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-brand-teal transition hover:bg-brand-teal/10"
              onClick={() => {
                setMenuOpen(false);
                requestResidentProfileForm("MANUAL");
              }}
              type="button"
            >
              <BadgePlus className="size-4" />
              Create resident ID
            </button>
          )}
          {showPortalActions ? (
            <div className="my-1 border-y border-border py-1">
              <ThemeToggle menu />
            </div>
          ) : null}
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-60 dark:hover:bg-rose-950/30"
            disabled={isLoggingOut}
            onClick={handleLogout}
            type="button"
          >
            <LogOut className="size-4" />
            {isLoggingOut ? "Signing out…" : "Logout"}
          </button>
        </div>
      ) : null}

      <ResidentIdentityCenter onProfileSaved={loadCurrentUser} />
      {showPortalActions ? (
        <GetAppDialog comingSoon open={getAppOpen} onOpenChange={setGetAppOpen} />
      ) : null}
    </div>
  );
}
