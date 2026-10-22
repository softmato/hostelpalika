import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { endSession, revalidateSession } from "@/lib/auth-session";

/**
 * A hostel's plan suspension, over the whole app.
 *
 * `/auth/me` carries it (`hostelSuspension`), and this draws it with the app's
 * own alert card, so it reads like every other interruption here:
 *
 * - **Pre-suspension**, owner and wardens: one alert per launch with the time
 *   left, to the second. It can be acknowledged — it is a warning, not a block.
 * - **Suspended**, everyone tied to the hostel: an alert that cannot be closed.
 *   The backdrop and the back button only check again, so the ways past it are
 *   the hostel paying or signing out.
 *
 * **No pay button, no link, no QR.** The plan is business software, and Google
 * Play's payments policy bars the app from selling it or pointing at another
 * way to buy it — so the owner is sent to their email, which carries Pay now.
 *
 * The stage flips on the clock here, so an app left open over the deadline
 * blocks on time. The API refuses the hostel from the same instant on its own;
 * this is what that refusal looks like.
 */

const STAFF_ROLES = new Set<string>([ROLE.HOSTEL_ADMIN, ROLE.WARDEN]);

/** Warnings acknowledged this launch, keyed by the deadline they warned about. */
const acknowledged = new Set<string>();

function remainingLabel(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${Math.floor(total / 86_400)}d ${pad(Math.floor((total % 86_400) / 3600))}h ${pad(
    Math.floor((total % 3600) / 60),
  )}m ${pad(total % 60)}s`;
}

export function HostelSuspensionHost() {
  const account = useAppSelector((state) => state.auth.account);
  const suspension = account?.hostelSuspension ?? null;
  const endsAt = suspension ? Date.parse(suspension.graceEndsAt) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  const [, setAcknowledgements] = useState(0);
  const checking = useRef(false);

  const counting =
    Number.isFinite(endsAt) && suspension?.stage !== "SUSPENDED" && now < endsAt;

  useEffect(() => {
    if (!counting) {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [counting]);

  const checkAgain = useCallback(() => {
    if (checking.current) {
      return;
    }

    checking.current = true;

    void revalidateSession().finally(() => {
      checking.current = false;
      setNow(Date.now());
    });
  }, []);

  const signOut = useCallback(
    () => endSession({ leaveTo: "/(browse)" }),
    [],
  );

  if (!account || !suspension || !Number.isFinite(endsAt)) {
    return null;
  }

  const staff = STAFF_ROLES.has(account.role);
  const hostel = suspension.hostelName || "Your hostel";
  const trial = suspension.reason === "TRIAL_ENDED";

  if (!counting) {
    return (
      <ConfirmDialog
        cancelLabel="Check again"
        confirmLabel="Sign out"
        key="suspended"
        message={
          staff && trial
            ? `${hostel}'s free trial is over. Please check your email to choose a monthly or lifetime plan. The portal opens again as soon as the payment is confirmed.`
            : staff
            ? `${hostel} has not paid its plan, so the hostel portal is suspended. Please check your email to pay it. The portal opens again as soon as the payment is confirmed.`
            : `${hostel} has not paid its plan price. Please contact your hostel to pay it and continue the service.`
        }
        onClose={checkAgain}
        onConfirm={signOut}
        open
        title={staff ? (trial ? "Your free trial has ended" : "Hostel portal suspended") : "Service paused"}
      />
    );
  }

  const warning = `${suspension.hostelId}:${suspension.graceEndsAt}`;

  if (!staff || acknowledged.has(warning)) {
    return null;
  }

  return (
    <ConfirmDialog
      cancelLabel={null}
      confirmLabel="OK"
      key="pre-suspension"
      message={
        trial
          ? `Your free trial ends in ${remainingLabel(endsAt - now)}. Please check your email to choose a monthly or lifetime plan.`
          : `Please check your email about your plan. Otherwise, access to your hostel portal stops in ${remainingLabel(endsAt - now)}.`
      }
      onClose={() => {
        acknowledged.add(warning);
        setAcknowledgements((count) => count + 1);
      }}
      onConfirm={() => undefined}
      open
      title={trial ? "Free trial ending" : "Plan payment due"}
    />
  );
}
