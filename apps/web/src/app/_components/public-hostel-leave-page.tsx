"use client";

import { HeldHostelsPanel } from "@/app/_components/held-hostel-claim";
import { PublicShell } from "@/app/_components/shared";

/**
 * Claim a hostel back while its data is still held (docs/HOSTEL_LEAVE_PLATFORM.md).
 * The approval email links here. A signed-out visitor is asked to sign in with
 * the owner's email first.
 */
export function PublicHostelLeavePage() {
  return (
    <PublicShell>
      <HeldHostelsPanel />
    </PublicShell>
  );
}
