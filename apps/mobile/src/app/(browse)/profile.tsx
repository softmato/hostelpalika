import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Linking, View } from "react-native";

import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, SignOutRow } from "@/components/more-menu";
import { AdminSearchBar } from "@/components/admin-search-bar";
import { ProviderStatusCard } from "@/components/provider-status-card";
import { SupportContact } from "@/components/support-contact";
import { PersonAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { toastInfo } from "@/lib/toast";

/**
 * Profile — and, since the tab bar replaced the signed-out shell, the app's
 * whole menu.
 *
 * ## What this screen is now
 *
 * The website's header and footer, natively. Everything they link to — Offer
 * Program, Register Hostel, Service Providers, About, Contact, Pricing, Terms,
 * Privacy, the support channels and the social links — is reachable from here,
 * grouped the way the site groups it: Explore, Partners, Company, Legal. On the
 * web those live in a nav bar and a four-column footer; a phone has neither, and
 * a menu is where a phone puts them.
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

  const { features, identity, social } = config;

  const soon = useCallback((what: string) => {
    toastInfo(`${what} is coming`, "It lands in the next release.");
  }, []);

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
              `${readableRole(account.role)} account — you're browsing, not living in a hostel yet.`,
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
                  <Ionicons color={colors.primary} name="person-outline" size={40} />
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
            {/* The one honest "not yet" left: nothing lists what you have sent. */}
            {account ? (
              <MenuRow icon="mail" onPress={() => soon("Your inquiries")} title="Inquiries" tone="neutral" />
            ) : null}
          </MenuGroup>

          <MenuGroup>
            <MenuRow icon="search" onPress={() => router.push("/(browse)/search")} title="Browse hostels" />
            {features.compare ? (
              <MenuRow
                icon="git-compare"
                onPress={() => router.push("/(browse)/compare")}
                title="Compare hostels"
                tone="warning"
              />
            ) : null}
            <MenuRow
              icon="people"
              onPress={() => router.push("/(browse)/community")}
              title="Community"
              tone="warning"
            />
            {features.inquiries ? (
              <MenuRow
                icon="chatbubble-ellipses"
                onPress={() => router.push("/inquiry")}
                title="Send an inquiry"
              />
            ) : null}
            <MenuRow
              icon="sparkles"
              onPress={() => router.push("/offer-program")}
              title="Resident Offer Program"
              tone="danger"
            />
          </MenuGroup>

          {features.publicRegistration || features.serviceProviderSignup ? (
            <MenuGroup>
              {features.publicRegistration ? (
                <MenuRow
                  icon="business"
                  onPress={() => router.push("/register-hostel")}
                  title="Register your hostel"
                />
              ) : null}
              {features.serviceProviderSignup ? (
                <MenuRow
                  icon="construct"
                  onPress={() => router.push("/service-providers")}
                  title="Become a service provider"
                  tone="warning"
                />
              ) : null}
              {features.publicRegistration ? (
                <MenuRow
                  icon="pricetags"
                  onPress={() => router.push("/pricing")}
                  title="Pricing"
                  tone="danger"
                />
              ) : null}
            </MenuGroup>
          ) : null}

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

          {socialLinks.length > 0 ? (
            <MenuGroup>
              {socialLinks.map(([label, href]) => (
                <MenuRow
                  icon="open-outline"
                  key={label}
                  onPress={() => void Linking.openURL(href)}
                  title={label}
                  tone="neutral"
                />
              ))}
            </MenuGroup>
          ) : null}

          {account ? <SignOutRow /> : null}
        </MenuGroups>

        {search ? null : (
          <Text className="pt-4 text-center" variant="caption">
            {`© ${new Date().getFullYear()} ${identity.siteName}. All rights reserved.`}
          </Text>
        )}
      </MenuSearch>
    </Screen>
  );
}