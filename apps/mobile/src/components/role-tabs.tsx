import { Tabs } from "expo-router";
import { type ComponentProps, useEffect, useRef } from "react";
import { type ColorValue, View } from "react-native";

import { AnimatedTabBar } from "@/components/tab-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import type { RoleAccentKey } from "@/constants/theme";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { usePortalWarmup } from "@/hooks/use-portal-warmup";
import { prefetchCommunity } from "@/lib/community-queries";
import { prefetchNotifications } from "@/lib/notification-queries";

export type TabDef = {
  /**
   * Draw the signed-in account's picture instead of `icon` — for the Profile
   * tab, which means "you" rather than a category. `icon` still has to be given:
   * `Avatar` falls back to an initial, and a signed-out shell falls back to the
   * glyph.
   */
  avatar?: boolean;
  /**
   * A count over the icon's corner. `0` draws nothing.
   *
   * Whoever passes this owns the fetch behind it. The admin group can afford one
   * because its layout already holds the shared alerts queue; a tab bar that
   * fetched its own counts would be a request per role per launch for a number
   * most people glance at once.
   */
  badge?: number;
  icon: GlyphName;
  label: string;
  name: string;
};

/**
 * How long after a tab change the preloader keeps its hands off. A change is
 * instant now (see `RoleTabs`), so this only has to cover the focused tab's own
 * first render.
 */
const QUIET_MS = 300;

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

/**
 * Mounts the tabs behind the landing one while the app is idle, so the first
 * tap on a tab only has to show it.
 *
 * The navigator mounts a tab on its first visit and starts the change animation
 * only after that render commits, so a first visit sat still while a whole
 * screen was built. `usePortalWarmup` already has the data; this builds the
 * screens.
 *
 * One tab per idle callback, and never inside a change: a preload is a state
 * update, and the navigator answers one mid-change by snapping the outgoing
 * scene to its end. No tab screen acts on mount beyond reading — the store's
 * Categories redirect needs a `?slug=`, which a preload never passes.
 */
function TabPreloader({
  names,
  navigation,
  state,
}: Pick<TabBarProps, "navigation" | "state"> & { names: readonly string[] }) {
  const focused = state.routes[state.index]?.name;
  const latest = useRef({ names, navigation, state });
  const quietUntil = useRef(0);
  const visited = useRef(new Set<string>());

  useEffect(() => {
    latest.current = { names, navigation, state };
  });

  // The first mount and every change open a window the chain waits out.
  useEffect(() => {
    if (focused) {
      visited.current.add(focused);
    }

    quietUntil.current = Date.now() + QUIET_MS;
  }, [focused]);

  useEffect(() => {
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function wait(ms: number) {
      timer = setTimeout(() => {
        idle = requestIdleCallback(step);
      }, ms);
    }

    function step() {
      const remaining = quietUntil.current - Date.now();

      if (remaining > 0) {
        wait(remaining);
        return;
      }

      const { names: tabNames, navigation: nav, state: current } = latest.current;
      const route = current.routes.find(
        (candidate) =>
          tabNames.includes(candidate.name) &&
          !visited.current.has(candidate.name) &&
          !current.preloadedRouteKeys.includes(candidate.key),
      );

      if (!route) {
        return;
      }

      visited.current.add(route.name);
      nav.preload(route.name);
      wait(0);
    }

    wait(0);

    return () => {
      clearTimeout(timer);

      if (idle !== undefined) {
        cancelIdleCallback(idle);
      }
    };
  }, []);

  return null;
}

/**
 * The bottom tab bar for a signed-in role.
 *
 * One component for all five signed-in audiences, differing only in accent
 * colour and the list of tabs — so a fix to inset handling, press feedback or
 * the hide-on-scroll animation lands everywhere at once instead of five times.
 *
 * The bar itself is `AnimatedTabBar`, not the navigator's default: the default
 * cannot be driven from a screen's scroll offset. Screens pass `insideTabs` to
 * `<Screen>`, which both reserves the bar's height and wires the scroll handler.
 */
export function RoleTabs({
  accent,
  hidden,
  tabs,
}: {
  accent: RoleAccentKey;
  /**
   * Routes that live in the group but are not tabs — reached by a push from one
   * of them.
   *
   * Needed because a `<Tabs>` navigator adopts **every** file in its directory:
   * a route left out of `tabs` would otherwise appear as an unlabelled sixth
   * tab. `href: null` is expo-router's own way of saying "not a tab", and it
   * keeps the bar on screen during the drill-down, which is the reason the
   * screen stays in the group rather than moving to the root stack.
   */
  hidden?: readonly string[];
  tabs: readonly TabDef[];
}) {
  const { colors } = useAppTheme();
  const account = useAppSelector((state) => state.auth.account);

  const hasCommunity = tabs.some((tab) => tab.name === "community");
  const tabNames = tabs.map((tab) => tab.name);

  /*
   * The community warm-up lives here rather than in six group layouts, because
   * this is the one place that knows whether Community is a tab in this role.
   *
   * It is deliberately not in `prefetchAdminPortal` — that module says why, and
   * the reason generalises: the board is platform-wide, so it belongs to
   * whatever shell puts it on screen and not to any one portal's registry.
   *
   * Nothing is awaited and nothing can throw: `prefetchQuery` swallows failures
   * by design, and both reads work signed out, which is what lets `(browse)`
   * run this at all. Fired in the same wave as the portal's own warm-up — the
   * group layout's effect runs after this one, so the portal's reads queue
   * behind the screen's, and the board's two reads sit alongside them.
   */
  usePortalWarmup(prefetchCommunity, hasCommunity);

  /*
   * The bell's feed, warmed for whichever shell this is — and here for the same
   * reason Community is: `/notifications` is scoped to `principal.userId` with no
   * role branch, so it is the one read every portal makes and belongs to no
   * portal's registry.
   *
   * At once rather than four seconds in, because this is not a
   * guess about where somebody will go next. Nearly every tab in every shell
   * draws a `<NotificationBell>`, so the count is *already on screen* — the only
   * question is whether it appears with the tab or a round trip later. The
   * shells whose landing tab has no bell (the store, most of all) are exactly
   * the ones this exists for; where a bell does mount in the same frame,
   * `prefetchQuery` joins its request instead of making a second.
   *
   * Signed out it does nothing: the endpoint is a 401 for `(browse)`'s anonymous
   * half, and `prefetchQuery` would swallow that silently once per visit.
   */
  const signedIn = Boolean(account);

  usePortalWarmup(prefetchNotifications, signedIn);

  return (
    <Tabs
      // Rendered outside the scene, so it keeps its own animated transform
      // while screens change underneath it.
      tabBar={(props) => (
        <>
          <TabPreloader names={tabNames} navigation={props.navigation} state={props.state} />
          <AnimatedTabBar {...props} accent={accent} />
        </>
      )}
      /*
       * A tab change is instant, the way the system's own tab bars are. The
       * dissolve that was here drew both tabs through an offscreen buffer for
       * every frame of it, and on a budget phone the two showed through each
       * other for half a second (field video, 2026-10-27).
       *
       * No `freezeOnBlur`: a frozen tab came back as a blank screen until React
       * caught up on every change it had skipped (field video, 2026-10-28).
       */
      screenOptions={{
        animation: "none",
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      {tabs.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            // Line when idle, solid when focused: the one place the solid set
            // exists for. Swapping the variant is the whole selected state, so
            // the tab bar itself needs no icon knowledge.
            tabBarIcon: ({ color, focused, size }) =>
              tab.avatar && account ? (
                <AvatarTabIcon
                  account={account}
                  focused={focused}
                  tint={color}
                />
              ) : (
                <Glyph
                  color={color}
                  name={tab.icon}
                  size={size}
                  variant={focused ? "solid" : "line"}
                />
              ),
            tabBarBadge: tab.badge && tab.badge > 0 ? tab.badge : undefined,
            title: tab.label,
          }}
        />
      ))}

      {/*
        `?? []`, not `hidden?.map(...)`.

        The optional-chaining form renders `undefined` as a child, and the
        assumption that React drops those is **wrong**: `Children.forEach` maps
        `undefined` to `null` and then invokes the callback with it anyway
        (`mapIntoArray`: `if (null === children) invokeCallback = true`).
        expo-router's `useFilterScreenChildren` receives that null, finds it is
        not a `Screen`, and warns "Layout children must be of type Screen" —
        naming whichever group did not pass `hidden`, which was `(browse)`, the
        only one with no non-tab routes. An empty array iterates zero times and
        the callback never fires.
      */}
      {(hidden ?? []).map((name) => (
        <Tabs.Screen key={name} name={name} options={{ href: null }} />
      ))}
    </Tabs>
  );
}

/**
 * The Profile tab's icon: the account's own face.
 *
 * The selected state cannot be a filled-vs-hollow glyph swap here, so it is a
 * ring in the accent colour — the same signal the label underneath already
 * carries, which is what keeps the tab readable for anyone who cannot tell the
 * two tints apart at 22px.
 *
 * `useAvatarSource` because `user.image` is a Google URL for a Google sign-in
 * and a relative, authenticated path for the photo on their ID card — it makes
 * the second absolute and gives it the bearer token, which is what the card
 * photo needs to render at all. `Avatar` handles the third case, where the URL
 * exists and cannot be drawn, by falling back to the initial.
 */
function AvatarTabIcon({
  account,
  focused,
  tint,
}: {
  account: { image: string | null; name: string };
  focused: boolean;
  tint: ColorValue;
}) {
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{
        borderColor: focused ? tint : "transparent",
        borderWidth: 1.5,
        height: 27,
        width: 27,
      }}
    >
      <PersonAvatar image={account.image} name={account.name} size="xs" />
    </View>
  );
}
