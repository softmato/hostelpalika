import { Linking } from "react-native";

import { MenuGroup, MenuRow } from "@/components/more-menu";
import { useSiteConfig } from "@/hooks/use-site-config";

/**
 * The website's footer contact column, shown at the foot of every More/Profile
 * tab. Tappable rather than printed: on a phone a support number is a call,
 * not a string to memorise.
 */
export function SupportContact() {
  const { identity } = useSiteConfig().config;
  if (!identity.supportPhone && !identity.supportEmail && !identity.address) {
    return null;
  }

  return (
    <MenuGroup>
      {identity.supportPhone ? (
        <MenuRow
          icon="call"
          onPress={() =>
            void Linking.openURL(`tel:${identity.supportPhone.replace(/\s/g, "")}`)
          }
          title={identity.supportPhone}
        />
      ) : null}
      {identity.supportEmail ? (
        <MenuRow
          icon="mail"
          onPress={() => void Linking.openURL(`mailto:${identity.supportEmail}`)}
          title={identity.supportEmail}
          tone="warning"
        />
      ) : null}
      {identity.address ? (
        <MenuRow icon="location" title={identity.address} tone="neutral" />
      ) : null}
    </MenuGroup>
  );
}
