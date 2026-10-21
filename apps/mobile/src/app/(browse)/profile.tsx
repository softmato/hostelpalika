import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, SignOutRow } from "@/components/more-menu";
import { AdminSearchBar } from "@/components/admin-search-bar";
import { HeldHostelCard } from "@/components/held-hostel-card";
import { ProviderStatusCard } from "@/components/provider-status-card";
import { SupportContact } from "@/components/support-contact";
import { PersonAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { readableRole } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { useSiteConfig } from "@/hooks/use-site-config";
import type { ProviderApplication } from "@/lib/provider-api";
import { providerQuery } from "@/lib/provider-queries";
import { isApplicationInFlight } from "@/lib/provider-status";
import { getHeldHostels, type HeldHostel } from "@/lib/registration-api";

/**
 * Profile — and, since the tab bar replaced the signed-out shell, the app's
 * whole menu.
 *
 * ## What this screen is now
 *
 * The website's header and footer, natively. Everything they link to — Offer
 * Program, Register Hostel, Service Providers, About, Contact, Pricing, Terms,
 * Privacy, the support channels and the social links — is reachable in the app.
 * The doors (Register, Service provider, Offer Program, Pricing, Inquiry,
 * Compare) are tiles on Home now (`HomeShortcuts`); this screen keeps the
 * account, the app settings and the company pages, and nothing a tab already
 * opens.
 *
 * Privacy and Terms open **in the app**. They used to hand off to the browser,
 * which meant the one screen that answers "what do you do with my data" was the
 * one screen that left the product to answer it.
 *
 * ## Signed out is not a different app
 *
 * There is no signed-out shell any more. The same five tabs render for everyone,
 * and the only difference is the card at the top of this screen: an account, or
 * an invitation to make one. Everything below that card is identical, because
 * everything below it is either public (the documents, the partner pages) or
 * device-local (saved hostels, theme).
 *
 * That is deliberate and it is the reason the floating Log in pill is gone. The
 * pill sat over the home screen of someone who had come to look at hostels and
 * had nothing to sign in with, and it made the first thing the app asked for the
 * one thing a new user does not have.
 *
 * Rows that genuinely need a session — Notifications, Privacy & your data, sign
 * out — are hidden while signed out rather than shown and refused. Rows that
 * only *look* like they need one are not: `/settings` takes
 * `requireApiPrincipal`, so a browsing account reaches it like anybody else.
 *
 * ## The feature flags are honoured
 *
 * Compare, Inquiries, Hostel registration and Service-provider signup each have
 * a switch in Website Config, and the web header and footer drop their links
 * when it is off. So does this. A surface the platform owner has switched off
 * must not still be advertised on the phone.
 */
export default function BrowseProfileScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const saved = useAppSelector((state) => state.saved.items);
  const [search, setSearch] = useState("");
  const { colors } = useAppTheme();
  const { config, refresh, refreshing } = useSiteConfig();

  /*
   * Whether this account has a service provider application in motion.
   *
   * Asked only with a session — the route reads the caller's own `userId`, so
   * there is nothing to ask signed out — and a failure answers `null`, which is
   * also what "never applied" answers. Both mean "draw nothing", so a flaky
   * lookup costs a banner rather than an error on a menu screen.
   */
  /*
   * Keyed only when signed in: the `null` a signed-out shell renders is a
   * placeholder, not an answer, and writing it to the shared entry would hand
   * the provider card an empty application on the first frame after sign-in.
   */
  const query = providerQuery.application();
  const application = useResource<ProviderApplication | null>(
    useCallback(
      () => (account ? query.load().catch(() => null) : Promise.resolve(null)),
      [account, query],
    ),
    { cacheKey: account ? query.key : undefined, topics: query.topics },
  );

  /*
   * A hostel this account took off the platform and can still claim back. Empty
   * for nearly everyone; a failure draws nothing, same as the provider card.
   */
  const held = useResource<HeldHostel[]>(
    useCallback(() => (account ? getHeldHostels().catch(() => []) : Promise.resolve([])), [account]),
    { cacheKey: account ? "account:held-hostels" : undefined },
  );

  const { identity, social } = config;

  const socialLinks = (
    [
      ["Facebook", social.facebook],
      ["Instagram", social.instagram],
      ["YouTube", social.youtube],
      ["TikTok", social.tiktok],
      ["LinkedIn", social.linkedin],
      ["Website", social.website],
    ] as const
  ).filter(([, href]) => Boolean(href));

  return (
    <Screen
      header={<AdminSearchBar onQueryChange={setSearch} placeholder="Search" query={search} title="Profile" />}
      insideTabs
      onRefresh={refresh}
      refreshing={refreshing}
      scroll
    >
      <MenuSearch query={search}>
        {search ? null : account ? (
          <MenuProfile
            // `PersonAvatar`, not a bare URL: a card photo is ours, behind auth.
            avatar={<PersonAvatar image={account.image} name={account.name} size="xl" />}
            lines={[
              account.email || account.phone,
              `${readableRole(account.role)} account`,
            ]}
            title={account.name || "Your account"}
          />
        ) : (
          /*
           * The sign-in block. It is the *only* thing on this screen that differs
           * between a signed-out reader and a signed-in one, and it sits at the top
           * so it is the first thing read.
           */
          <View className="gap-2 pb-3">
            <MenuProfile
              avatar={
                <View className="h-24 w-24 items-center justify-center rounded-full bg-brand-soft">
                  <Glyph color={colors.primary} name="person" size={40} />
                </View>
              }
              lines={["Sign in to send inquiries, post in the community and keep your shortlist across devices."]}
              title="You're browsing as a guest"
            />
            <Button label="Sign in" onPress={() => router.push("/(auth)/login")} />
            <Button
              label="Create account"
              onPress={() => router.push("/(auth)/register")}
              variant="outline"
            />
          </View>
        )}

        {/*
          A service provider application in motion, on the screen the applicant is
          actually holding. Only for a record *in motion*, hence no skeleton.
        */}
        {!search && !application.loading && isApplicationInFlight(application.data) ? (
          <View className="pb-3">
            <ProviderStatusCard application={application.data} />
          </View>
        ) : null}

        {!search && held.data?.length ? (
          <View className="gap-3 pb-3">
            {held.data.map((hostel) => (
              <HeldHostelCard hostel={hostel} key={hostel.requestId} />
            ))}
          </View>
        ) : null}

        <MenuGroups>
          <MenuGroup>
            {/* Device-local, so it works signed out. `/saved` is the list and nothing else. */}
            <MenuRow
              icon="bookmark"
              onPress={() => router.push("/saved")}
              title="Saved hostels"
              value={saved.length > 0 ? String(saved.length) : undefined}
            />
            {account ? (
              <MenuRow
                icon="calendar"
                onPress={() => router.push("/bookings")}
                title="My bookings"
                tone="warning"
              />
            ) : null}
          </MenuGroup>

          {/* Notification settings and privacy need a session; the theme does not. */}
          <AppRows feed={false} notificationSettings={Boolean(account)} privacy={Boolean(account)} />

          <MenuGroup>
            <MenuRow
              icon="information-circle"
              onPress={() => router.push("/about")}
              title="About us"
              tone="neutral"
            />
            <MenuRow
              icon="chatbubbles"
              onPress={() => router.push("/contact")}
              title="Contact"
              tone="neutral"
            />
            <MenuRow
              icon="document-text"
              onPress={() => router.push("/legal/terms")}
              title="Terms & Regulations"
              tone="neutral"
            />
            <MenuRow
              icon="lock-closed"
              onPress={() => router.push("/legal/privacy")}
              title="Privacy Policy"
              tone="neutral"
            />
          </MenuGroup>

          <SupportContact />

          {account ? <SignOutRow /> : null}
        </MenuGroups>

        {search ? null : (
          <View className="items-center gap-3 pt-5">
            {socialLinks.length > 0 ? (
              <View className="flex-row flex-wrap justify-center gap-2">
                {socialLinks.map(([label, href]) => (
                  <Pressable
                    accessibilityRole="link"
                    className="rounded-full border border-border px-3 py-1.5 active:opacity-70"
                    key={label}
                    onPress={() => void Linking.openURL(href)}
                  >
                    <Text variant="caption">{label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Text className="text-center" variant="caption">
              {`© ${new Date().getFullYear()} ${identity.siteName}. All rights reserved.`}
            </Text>
          </View>
        )}
      </MenuSearch>
    </Screen>
  );
}