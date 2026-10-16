import { router } from "expo-router";
import { View } from "react-native";

import { DocumentScreen } from "@/components/document-screen";
import { InfoNote } from "@/components/info-page";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";

/**
 * The Resident Offer Program explainer.
 *
 * **Public, and deliberately so.** Every other surface that mentions the
 * programme is behind a login, but the two moments a resident most wants to read
 * about it are moments they are not signed in: the confirmation email that lands
 * seconds after they submit a payment proof, and the conversation with a parent
 * paying the rent who has no account at all. Both of those arrive at this screen
 * from a link, so it has to render for a signed-out reader.
 *
 * The copy is the platform's configured copy, shared with `/resident-offer-
 * program` on the website. What is not shared is the block below it.
 */

/**
 * The apply block — the one part of this screen that is not the same for
 * everyone, and a port of the website's `ApplyBlock`.
 *
 * Three states, and the distinction that matters is the third: someone signed in
 * who is not a resident. Showing them "Apply" would send them to a dashboard
 * they cannot open, and showing them the signed-out pitch would tell them to
 * create an account they already have. Both are dead ends, and both are what a
 * two-state check produces.
 *
 * **Eligibility is read from the session, not from a request.** It is a property
 * of being a resident with invoices, which is already true or already false by
 * the time anyone reads this; there is no approval to grant and nothing to
 * await. `isResidentActivated` is not consulted — an invited resident who has
 * not scanned their QR yet is still a resident, and telling them they are
 * ineligible would be wrong about the programme rather than about their session.
 */
function ApplyBlock() {
  const { account, isReady } = useAppSelector((state) => state.auth);

  if (!isReady) {
    // Rendered inert rather than absent: the session resolves a beat after the
    // first frame, and a card that appears late moves the page under whoever
    // was already reading it.
    return (
      <InfoNote title="Checking your account…">
        <Text variant="muted">One moment.</Text>
      </InfoNote>
    );
  }

  if (account?.role === ROLE.RESIDENT) {
    return (
      <InfoNote title="You are eligible" tone="accent">
        <Text className="leading-6" variant="muted">
          Your resident account qualifies for the Resident Offer Program. Apply to
          start using your reference code on your next payment.
        </Text>
        <Button
          className="mt-1"
          label="Apply for the Resident Offer Program"
          onPress={() => router.push("/(resident)/payments")}
        />
      </InfoNote>
    );
  }

  if (account) {
    // Signed in, but not as a resident — an owner, a warden, a guardian, a
    // visitor with an account. Saying "become a resident" is the honest answer
    // and it is not the same as "sign up".
    return (
      <InfoNote title="This programme is for residents">
        <Text className="leading-6" variant="muted">
          Your account is signed in, but it is not a resident account. The Resident
          Offer Program runs on the invoices a hostel issues you, so you need to be a
          resident of a hostel on the platform to be eligible.
        </Text>
        <Button
          className="mt-1"
          label="Find a hostel"
          onPress={() => router.push("/(browse)/search")}
          variant="outline"
        />
      </InfoNote>
    );
  }

  return (
    <InfoNote title="Become a resident to be eligible">
      <Text className="leading-6" variant="muted">
        The Resident Offer Program is open to residents of hostels on this platform.
        Join a hostel first — once your resident account is active and your first
        invoice is raised, you can apply from this screen.
      </Text>
      <View className="mt-1 gap-2">
        <Button
          label="Find a hostel"
          onPress={() => router.push("/(browse)/search")}
        />
        <Button
          label="Already a resident? Sign in"
          onPress={() => router.push("/(auth)/login")}
          variant="outline"
        />
      </View>
    </InfoNote>
  );
}

export default function OfferProgramScreen() {
  return (
    <DocumentScreen
      /*
       * `action`, not `extra`: this block is the reason a resident opened the
       * screen, and under nine sections of programme rules it was unreachable
       * without reading them.
       */
      action={<ApplyBlock />}
      icon="sparkles"
      page="offerProgram"
      webPath="resident-offer-program"
      title="Resident Offer Program"
    />
  );
}
