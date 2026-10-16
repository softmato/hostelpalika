import { Tabs } from "expo-router";
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef } from "react";
import { Animated, type ColorValue, Easing, View } from "react-native";

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

/** How long a tab change runs. The fade is visible for all of it. */
const TRANSITION_MS = 220;

/**
 * Opacity against a scene's tab progress: 0 when focused, 1 to the right of the
 * focused tab, -1 to the left.
 *
 * Scenes stack in route order, not focus order: react-native-screens drops the
 * navigator's `zIndex` (its `Screen.tsx` overrides it with `undefined`). Of the
 * two tabs in a change the higher index is on top, and that is always the one
 * on the `[0, 1]` side of centre. So that side does all the fading, and the
 * `[-1, 0]` side stays fully opaque underneath until it reaches -1 exactly.
 *
 * Going right, the new tab fades in over the old one; going left, the old tab
 * fades off the new one. Either way the change shows from the first frame, and
 * every frame is the two tabs mixed with no background between them. Fading
 * both at once is what drew half a new tab over a quarter of the old one — and
 * a curve that assumed the focused tab was on top sat still going left.
 *
 * Both ends are 0 so a tab parked outside the change never shows through.
 */
const DISSOLVE = {
  inputRange: [-1, -0.999, 0, 1],
  outputRange: [0, 1, 1, 0],
};

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

/**
 * Mounts the tabs behind the landing one while the app is idle, so the first
 * tap on a tab only has to animate.
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

    quietUntil.current = Date.now() + TRANSITION_MS + 150;
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
 * The layer a tab fades on.
 *
 * The navigator would fade its own scene view, and on Android that is not a
 * fade of the screen: React Native views default to non-overlapping alpha, so
 * the opacity is pushed down onto every child separately. The tab's white
 * ground, its cards and its text each turn half-transparent on their own and
 * the other tab shows through every layer of them — a washed-out frame that is
 * neither tab. `needsOffscreenAlphaCompositing` draws the screen into one
 * buffer and fades that, so it fades as a picture. The buffer exists only while
 * opacity is below 1, which is the length of a change.
 *
 * The ground lives here, not in `sceneStyle`, because it has to fade with the
 * screen; an opaque scene view outside this layer would hide the tab beneath.
 */
function TabScene({
  background,
  children,
  progress,
}: {
  background: string;
  children: ReactNode;
  progress: Animated.Value | undefined;
}) {
  const opacity = useMemo(() => progress?.interpolate(DISSOLVE) ?? 1, [progress]);

  return (
    <Animated.View
      needsOffscreenAlphaCompositing
      style={{ backgroundColor: background, flex: 1, opacity }}
    >
      {children}
    </Animated.View>
  );
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
  const progressByKey = useRef(new Map<string, Animated.Value>());

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
      // The fade is drawn by `TabScene`, which says why the navigator can't.
      screenLayout={({ children, route }) => (
        <TabScene background={colors.background} progress={progressByKey.current.get(route.key)}>
          {children}
        </TabScene>
      )}
      screenOptions={({ route }) => ({
        headerShown: false,
        sceneStyle: { backgroundColor: "transparent" },
        // A dissolve with no slide — `DISSOLVE` says why only one scene fades.
        animation: "shift",
        transitionSpec: {
          animation: "timing",
          config: { duration: TRANSITION_MS, easing: Easing.out(Easing.cubic) },
        },
        // Styles nothing: it is the one place the navigator hands out a scene's
        // progress, and it runs before that scene's layout renders.
        sceneStyleInterpolator: ({ current }: { current: { progress: Animated.Value } }) => {
          progressByKey.current.set(route.key, current.progress);
          return { sceneStyle: {} };
        },
      })}
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
