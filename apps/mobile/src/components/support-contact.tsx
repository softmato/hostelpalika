import { router } from "expo-router";
import { Linking } from "react-native";

import { MenuGroup, MenuRow } from "@/components/more-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useAppSelector } from "@/hooks/redux";
import { useSiteConfig } from "@/hooks/use-site-config";

/**
 * The website's footer contact column, shown at the foot of every More/Profile
 * tab. Tappable rather than printed: on a phone a support number is a call,
 * not a string to memorise.
 */
/** `wa.me` takes digits with the country code; a local 98… number gets Nepal's 977. */
function whatsappUrl(phone: string) {
  const digits = phone.replace(/\D/g, "");

  return `https://wa.me/${digits.length === 10 && digits.startsWith("9") ? `977${digits}` : digits}`;
}

export function SupportContact() {
  const { identity } = useSiteConfig().config;
  // Feedback is filed against an account, so a signed-out visitor sees only the contacts.
  const signedIn = useAppSelector((state) => Boolean(state.auth.account));
  // Up to two numbers with a note each (Website Config); the one support phone otherwise.
  const lines = identity.supportLines?.length
    ? identity.supportLines
    : identity.supportPhone
      ? [{ note: "", phone: identity.supportPhone }]
      : [];

  return (
    <MenuGroup>
      {lines.map((line) => (
        <MenuRow
          icon="logo-whatsapp"
          key={line.phone}
          // A message first — it leaves a thread both sides can scroll back through; Call sits beside it.
          onPress={() => void Linking.openURL(whatsappUrl(line.phone))}
          right={
            <IconButton
              label={`Call ${line.phone}`}
              name="call"
              size="sm"
              onPress={() => void Linking.openURL(`tel:${line.phone.replace(/[^\d+]/g, "")}`)}
            />
          }
          subtitle={line.note ? `${line.note} · WhatsApp` : "Message us on WhatsApp"}
          title={line.phone}
        />
      ))}
      {identity.supportEmail ? (
        <MenuRow
          icon="mail"
          onPress={() => void Linking.openURL(`mailto:${identity.supportEmail}`)}
          title={identity.supportEmail}
          tone="warning"
        />
      ) : null}
      {signedIn ? (
        <MenuRow
          icon="chatbox"
          onPress={() => router.push("/help")}
          subtitle="Feedback, a bug, or an idea — screenshots welcome"
          title="Send feedback"
          tone="neutral"
        />
      ) : null}
      {identity.address ? (
        <MenuRow icon="location" title={identity.address} tone="neutral" />
      ) : null}
    </MenuGroup>
  );
}
