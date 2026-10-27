import { roomTypeLabel } from "@hostel/constants/room-types";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { FactRow } from "@/components/ui/layout";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { startSession } from "@/lib/auth-session";
import {
  acceptResidencyInvite,
  declineResidencyInvite,
  getResidencyInvite,
  inviteRentLine,
  type ResidencyInvite,
} from "@/lib/residency-invite";
import { toastError, toastSuccess } from "@/lib/toast";
import { setResidentActivated } from "@/store/slices/authSlice";

/**
 * "Your hostel added you as a resident" — the bottom sheet a signed-in public
 * account sees when a hostel has its email (docs/EXISTING_RESIDENTS.md). The
 * server decides who is asked (`residency-invite.service.ts`); this only asks.
 *
 * At the app root so it reaches the person wherever they are, and asked again
 * when the app comes back to the front — the push that says "confirm your
 * hostel" is tapped from outside the app, and that is the moment to show it.
 *
 * Continue swaps in the resident session and opens the resident tabs. "This is
 * not me" stops the question and tells the hostel. "Not now" closes it until the
 * app is next opened.
 */
export function ResidencyInviteHost() {
  const { colors } = useAppTheme();
  const dispatch = useAppDispatch();
  const role = useAppSelector((state) => state.auth.account?.role ?? null);
  const signedIn = useAppSelector((state) => Boolean(state.auth.accessToken));
  const [invite, setInvite] = useState<ResidencyInvite | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const later = useRef<string | null>(null);
  const eligible = signedIn && role === ROLE.PUBLIC;

  useEffect(() => {
    if (!eligible) {
      return;
    }

    let live = true;

    const ask = () => {
      getResidencyInvite()
        .then((next) => {
          if (live) setInvite(next && next.residentId !== later.current ? next : null);
        })
        .catch(() => {
          // Nothing to ask is the safe reading of any failure.
        });
    };

    ask();

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") ask();
    });

    return () => {
      live = false;
      subscription.remove();
    };
  }, [eligible]);

  if (!eligible || !invite) {
    return null;
  }

  async function accept() {
    if (!invite) return;

    setBusy("accept");

    try {
      await startSession(await acceptResidencyInvite(invite.residentId));
      // The call that just returned is what linked them — see `app/activate.tsx`.
      dispatch(setResidentActivated(true));
      setInvite(null);
      toastSuccess(`Welcome to ${invite.hostelName}`, "Your dashboard is ready.");
      router.replace("/(resident)");
    } catch (error) {
      toastError("Could not continue", readApiError(error));
    } finally {
      setBusy(null);
    }
  }

  async function decline() {
    if (!invite) return;

    setBusy("decline");

    try {
      await declineResidencyInvite(invite.residentId);
      setInvite(null);
      toastSuccess("Thanks", "We told the hostel to check the email.");
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setBusy(null);
    }
  }

  function notNow() {
    later.current = invite?.residentId ?? null;
    setInvite(null);
  }

  const due = invite.dueAmount > 0;

  return (
    <Sheet
      footer={
        <View className="gap-2">
          <Button
            disabled={busy === "decline"}
            label="Continue to my dashboard"
            loading={busy === "accept"}
            onPress={() => void accept()}
          />
          <Button
            disabled={busy === "accept"}
            label="This is not me"
            loading={busy === "decline"}
            onPress={() => void decline()}
            variant="outline"
          />
          <Button disabled={busy !== null} label="Not now" onPress={notNow} size="sm" variant="ghost" />
        </View>
      }
      onClose={() => {
        if (!busy) notNow();
      }}
      open
    >
      <View className="items-center gap-2 pb-3">
        <View className="h-14 w-14 items-center justify-center rounded-full bg-brand-soft">
          <Glyph color={colors.primary} name="business" size={26} />
        </View>
        <Text className="text-center" variant="title">
          {invite.hostelName} added you as a resident
        </Text>
        <Text className="text-center" variant="muted">
          Hi {invite.firstName}, is this you? Continue to see your bills, notices and more.
        </Text>
      </View>

      <Card className="gap-1">
        <FactRow label="Room type" value={roomTypeLabel(invite.roomType)} />
        <FactRow
          label="Rent"
          value={
            <Text className={due ? "font-semibold text-warning" : "font-semibold text-success"}>
              {inviteRentLine(invite)}
            </Text>
          }
        />
      </Card>
    </Sheet>
  );
}
