import { create } from "zustand";

import type { Role } from "@/lib/roles";

/**
 * The last known answer from `/api/v1/auth/me`, cached for the tab's lifetime.
 *
 * The public header is rendered by `PublicShell`, which lives inside each
 * *page* rather than the route-group layout — so every navigation unmounts and
 * remounts it. With per-component state that meant re-asking who you are on
 * every click, and drawing the signed-out navigation until the answer came
 * back. Holding it here means a remount paints the correct header immediately
 * and the refetch only confirms it.
 *
 * `status` distinguishes "not asked yet" from "asked, nobody is signed in", so
 * a first paint can hold back role-dependent chrome instead of guessing.
 */
/** A hostel's plan suspension, as `/auth/me` reports it — see `hostel-suspension.ts`. */
/** A quick sign-up's KYC and trial, from `/auth/me` (docs/QUICK_SIGNUP_KYC_TRIAL.md). */
export type HostelKyc = {
  hostelId: string;
  hostelName: string;
  /** The frozen features are frozen. False once approved — and for every older hostel, which has no `hostelKyc`. */
  locked: boolean;
  /** Why it was sent back; only while `REJECTED`. */
  note: string | null;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  submittedAt: string | null;
  trialDays: number | null;
  trialEndsAt: string | null;
};

export type HostelSuspension = {
  graceEndsAt: string;
  hostelId: string;
  hostelName: string;
  reason: "PLAN_PAYMENT" | "TRIAL_ENDED";
  stage: "PRE_SUSPENSION" | "SUSPENDED";
  startedAt: string;
};

export type SessionUser = {
  email: string | null;
  hostelKyc?: HostelKyc | null;
  /** Set while the account's hostel is in pre-suspension or suspended. */
  hostelSuspension?: HostelSuspension | null;
  id: string;
  image: string | null;
  /** Approved service provider — derived server-side; there is no such role. */
  isServiceProvider: boolean;
  name: string;
  role: Role;
  userResidentId: string | null;
};

type SessionStore = {
  clear: () => void;
  setUser: (user: SessionUser | null) => void;
  status: "resolved" | "unknown";
  user: SessionUser | null;
};

export const useSessionStore = create<SessionStore>((set) => ({
  clear: () => set({ status: "resolved", user: null }),
  setUser: (user) => set({ status: "resolved", user }),
  status: "unknown",
  user: null,
}));
