import { Linking, View } from "react-native";

import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
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
    <View>
      <SectionHeader title="Get in touch" />
      <Card>
        {identity.supportPhone ? (
          <ListRow
            icon="call-outline"
            onPress={() =>
              void Linking.openURL(`tel:${identity.supportPhone.replace(/\s/g, "")}`)
            }
            title={identity.supportPhone}
          />
        ) : null}
        {identity.supportPhone && identity.supportEmail ? <RowDivider inset /> : null}
        {identity.supportEmail ? (
          <ListRow
            icon="mail-outline"
            onPress={() => void Linking.openURL(`mailto:${identity.supportEmail}`)}
            title={identity.supportEmail}
          />
        ) : null}
        {identity.address && (identity.supportPhone || identity.supportEmail) ? (
          <RowDivider inset />
        ) : null}
        {identity.address ? (
          <ListRow icon="location-outline" title={identity.address} />
        ) : null}
      </Card>
    </View>
  );
}
