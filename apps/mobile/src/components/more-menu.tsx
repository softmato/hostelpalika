import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import {
  Children,
  type ComponentProps,
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { View } from "react-native";

import { ListRow } from "@/components/ui/list-row";
import { EmptyState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useLockEnabled } from "@/components/app-lock";
import { canOfferLock } from "@/lib/app-lock";
import { CALENDAR_LABELS } from "@/lib/calendar";
import { endSession } from "@/lib/auth-session";
import { openConfirm } from "@/lib/confirm";
import { setThemePreference } from "@/store/slices/uiSlice";

/**
 * The More screen's shape, shared by every portal: a centred face, then groups
 * of round-icon rows split by a short hairline. No cards — a menu on a page,
 * the way a phone's own Settings reads. Colour comes from our tokens only.
 */

export type MenuTone = "brand" | "danger" | "neutral" | "warning";

const MenuSearchContext = createContext("");
/** Matching rows report in here, so the screen knows when to say "no matches". */
const MenuHitsContext = createContext<(delta: number) => void>(() => {});

/**
 * The query typed into the header's search field. While it is non-empty the
 * profile hides, groups lose their hairlines and titles, anything that is not a
 * `<MenuRow>` drops out, and rows whose title does not match return nothing —
 * so the screen collapses to one flat list of matches.
 */
export function MenuSearch({ children, query }: { children: ReactNode; query: string }) {
  const typed = query.trim();
  const [hits, setHits] = useState(0);
  const count = useCallback((delta: number) => setHits((total) => total + delta), []);

  return (
    <MenuSearchContext.Provider value={typed.toLowerCase()}>
      <MenuHitsContext.Provider value={count}>
        {children}
        {typed && hits === 0 ? (
          <View className="pt-8">
            <EmptyState
              compact
              description="Try another word."
              icon="search-outline"
              title={`No matches for “${typed}”`}
            />
          </View>
        ) : null}
      </MenuHitsContext.Provider>
    </MenuSearchContext.Provider>
  );
}

/** Centred avatar, name and caption lines; `children` sit underneath (badges, chips, buttons). */
export function MenuProfile({
  avatar,
  children,
  lines = [],
  title,
}: {
  avatar: ReactNode;
  children?: ReactNode;
  lines?: (string | null | undefined)[];
  title: string;
}) {
  if (useContext(MenuSearchContext)) {
    return null;
  }

  return (
    <View className="items-center gap-1 pb-3 pt-2">
      {avatar}
      <Text
        className="pt-3 text-center text-xl font-medium text-foreground"
        numberOfLines={1}
        variant={null}
      >
        {title}
      </Text>
      {lines.filter(Boolean).map((line) => (
        <Text className="text-center" key={line} numberOfLines={2} variant="caption">
          {line}
        </Text>
      ))}
      {children ? (
        <View className="flex-row flex-wrap justify-center gap-2 pt-2">{children}</View>
      ) : null}
    </View>
  );
}

/** Groups with a hairline between them, inset past the icon column. Falsy children are skipped. */
export function MenuGroups({ children }: { children: ReactNode }) {
  const searching = Boolean(useContext(MenuSearchContext));

  return (
    <View>
      {Children.toArray(children).map((group, index) => (
        <View key={index}>
          {index > 0 && !searching ? <View className="my-2 ml-11 h-px bg-border/60" /> : null}
          {group}
        </View>
      ))}
    </View>
  );
}

/** One group. A title only where the rows don't explain themselves. */
export function MenuGroup({ children, title }: { children: ReactNode; title?: string }) {
  if (useContext(MenuSearchContext)) {
    return (
      <>
        {Children.toArray(children).filter(
          (child) => isValidElement(child) && child.type === MenuRow,
        )}
      </>
    );
  }

  return (
    <View>
      {title ? (
        <Text className="pb-1 pt-1" variant="caption">
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** `<ListRow>` with a filled round glyph in front. */
export function MenuRow({
  icon,
  tone = "brand",
  ...row
}: Omit<ComponentProps<typeof ListRow>, "icon" | "iconBgColor" | "iconColor" | "left"> & {
  icon: keyof typeof Ionicons.glyphMap;
  tone?: MenuTone;
}) {
  const { colors } = useAppTheme();
  const query = useContext(MenuSearchContext);
  const count = useContext(MenuHitsContext);
  const hit = Boolean(query) && row.title.toLowerCase().includes(query);

  useEffect(() => {
    if (!hit) {
      return;
    }
    count(1);
    return () => count(-1);
  }, [count, hit]);

  if (query && !hit) {
    return null;
  }

  const tint = {
    brand: colors.primary,
    danger: colors.destructive,
    neutral: colors.mutedForeground,
    warning: colors.warning,
  }[tone];

  return (
    <ListRow
      {...row}
      left={
        <View
          className="h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: tint }}
        >
          <Ionicons color="#FFFFFF" name={icon} size={17} />
        </View>
      }
    />
  );
}

/** Theme, the notification feed, notification settings and privacy — whichever this portal has. */
export function AppRows({
  feed = true,
  notificationSettings = false,
  privacy = true,
}: {
  feed?: boolean;
  notificationSettings?: boolean;
  privacy?: boolean;
}) {
  const preference = useAppSelector((state) => state.ui.themePreference);
  const account = useAppSelector((state) => state.auth.account);
  const calendar = useAppSelector((state) => state.ui.calendarPreference);
  const lockOn = useLockEnabled();
  const dispatch = useAppDispatch();
  const dark = preference === "dark";

  return (
    <MenuGroup>
      <MenuRow
        icon={dark ? "moon" : "sunny"}
        onPress={() => dispatch(setThemePreference(dark ? "light" : "dark"))}
        title="Dark mode"
        tone="neutral"
        value={dark ? "On" : "Off"}
      />
      {canOfferLock(account) ? (
        <MenuRow
          icon="lock-closed"
          onPress={() => router.push({ params: { section: "security" }, pathname: "/settings" })}
          title="App lock"
          value={lockOn ? "On" : "Off"}
        />
      ) : null}
      <MenuRow
        icon="calendar"
        onPress={() => router.push({ params: { section: "calendar" }, pathname: "/settings" })}
        title="Dates"
        tone="neutral"
        value={CALENDAR_LABELS[calendar]}
      />
      {feed ? (
        <MenuRow
          icon="notifications"
          onPress={() => router.push("/notifications")}
          title="Notifications"
          tone="danger"
        />
      ) : null}
      {notificationSettings ? (
        <MenuRow
          icon="options"
          onPress={() =>
            router.push({ params: { section: "notifications" }, pathname: "/settings" })
          }
          title="Notification settings"
          tone="neutral"
        />
      ) : null}
      {privacy ? (
        <MenuRow
          icon="shield-checkmark"
          onPress={() => router.push({ params: { section: "privacy" }, pathname: "/settings" })}
          title="Privacy & your data"
        />
      ) : null}
    </MenuGroup>
  );
}

export function SignOutRow({
  message = "You'll need your password to get back in.",
}: {
  message?: string;
}) {
  const { colors } = useAppTheme();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = useCallback(() => {
    openConfirm({
      confirmLabel: "Sign out",
      destructive: true,
      message,
      onConfirm: () => {
        setSigningOut(true);
        void endSession().finally(() => router.replace("/(browse)"));
      },
      title: "Sign out?",
    });
  }, [message]);

  return (
    <MenuRow
      icon="log-out"
      onPress={signOut}
      right={
        <Ionicons
          color={colors.destructive}
          name={signingOut ? "hourglass-outline" : "chevron-forward"}
          size={18}
        />
      }
      title="Sign out"
      tone="danger"
    />
  );
}
