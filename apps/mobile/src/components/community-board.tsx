import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { BlurView } from "expo-blur";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, {
  Easing,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { CommunityPostCard } from "@/components/community-post-card";
import { AppBar } from "@/components/ui/app-bar";
import { Glyph } from "@/components/ui/glyph";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Screen, useOwnScroll } from "@/components/ui/screen";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { REALTIME_TOPIC } from "@/constants/topics";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import {
  type CommunityFeed,
  type CommunityMedia,
  type CommunityPost,
  type CommunitySpaces,
  createCommunityPost,
  getCommunityFeed,
} from "@/lib/community-api";
import {
  communityQuery,
  DEFAULT_SORT,
  DEFAULT_SPACE,
} from "@/lib/community-queries";
import {
  audienceOptions,
  avatarInitial,
  avatarTone,
  canPublish,
  composerTarget,
  emptyFeedMessage,
  MAX_POST_BODY,
  MAX_POST_MEDIA,
  postVisibility,
  spaceChips,
  usableAvatarUrl,
} from "@/lib/community";
import {
  DEFAULT_NOTIFICATION_FILTER,
  notificationQuery,
} from "@/lib/notification-queries";
import type { NotificationFeed } from "@/lib/notifications-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

/**
 * The community feed.
 *
 * Ported from `apps/web/src/app/_components/community-page.tsx`, which is a
 * three-column layout: a spaces rail, the feed, and a sponsor rail. On a phone the
 * rail's space buttons become a horizontal chip row in the same order, the search
 * and new/top controls keep their place above the feed, and the composer sits where
 * the web's does — between the controls and the first post.
 *
 * **Not ported:** the sponsor rail, popular hostels, trending tags and the
 * guidelines card. All four are sidebar furniture served by `/community/sidebar`,
 * and none is in this milestone's checklist. Noted in `docs/MOBILE_APP_PHASES.md`
 * rather than silently dropped.
 *
 * ## Infinite scroll rather than a pager
 *
 * `useResource` holds one payload and has no notion of pages, so the feed keeps its
 * own list and appends. Page 1 replaces, later pages append, and a space/sort/search
 * change resets to page 1 — which is why the effect below keys off all three.
 *
 * ## Reading needs no account
 *
 * `GET /community` uses `loadApiPrincipal`, so this screen works signed out. What
 * changes is `spaces.viewer.canPost`: the composer is replaced by a sign-in line,
 * and reactions, comments and votes say so when tapped rather than being hidden.
 *
 * ## Why this is a component and not just a screen
 *
 * Two routes render it, for the same reason `public-home.tsx` is shared: it is a
 * **tab** in the `(browse)` shell a signed-in `PUBLIC_USER` gets, and a pushed
 * screen everywhere else — the role `more.tsx` menus and the `/community/[postId]`
 * share link both reach it that way. They differ in two things only, the back
 * button and the tab bar's reserved height, so both are props rather than a
 * second copy of a 500-line feed.
 *
 * ## What the redesign changed, and what it could not
 *
 * The header, the chip row, the sort strip and the composer follow the mockup:
 * a titled bar with the bell, one search pill, an All / own-hostel chip pair,
 * an underlined sort strip, and a composer that leads with the viewer's own face.
 * Posts sit flat on the page between hairlines — no card boxes.
 *
 * Two things in the mockup are **not** here, because nothing behind them exists:
 *
 * - **A "For you" sort.** `communityFeedQuerySchema` is
 *   `sort: z.enum(["new", "top"])`. A third tab would either repeat one of those
 *   under a name that promises personalisation, or send a value the server
 *   rejects. The strip therefore has the two sorts that are real.
 * - **A share count.** Nothing counts shares — `Share.share` hands off to the OS
 *   and the OS does not report back — so the share control is a label, not a
 *   number.
 */

const SEARCH_DEBOUNCE_MS = 300;

/** The chip row, and the floating search field that grows out of its first button. */
const ROW_HEIGHT = 38;
const FIELD_GLYPH = 16;
const SEARCH_MS = 240;
/** Clearance between a focused comment field and the top of the keyboard. */
const KEYBOARD_GAP = 24;
/** How far the header behind an open search is pushed back. "A bit", not a smear. */
const SEARCH_BLUR = 22;

/*
 * `intensity` is a native prop, so ramping the blur means animated props, not a
 * style — the same reason `confirm-dialog.tsx` gives. No `blurTarget` here: this
 * view lives inside the app's own blur target, and Android cannot capture a
 * target from a view drawn within it, so Android gets expo-blur's frosted tint.
 */
const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/** The composer's avatar, and the author avatar on a card. Kept in step. */
const AVATAR = 38;

export type CommunityBoardProps = {
  /**
   * Rendered in the bar ahead of the bell.
   *
   * One board serves every role, and one role has something extra to do with
   * it: staff moderate. Rather than branching this component on who is signed
   * in — which would put an admin-only import into the screen residents and the
   * signed-out public both load — the group that owns the power passes the
   * control in.
   */
  actions?: ReactNode;
  /** Set when this renders as a tab, so the list clears the tab bar. */
  insideTabs?: boolean;
  /** A pushed screen keeps its back button; a tab is a destination and has none. */
  showBack?: boolean;
};

export function CommunityBoard({
  actions,
  insideTabs = false,
  showBack = false,
}: CommunityBoardProps) {
  const { colors, isDark } = useAppTheme();

  /*
   * The feed hides and restores the tab bar like every other screen does.
   * `<Screen scroll>` wires that up on its own and this screen cannot use it,
   * so the list asks for the same handler — and for the bottom clearance it now
   * has to reserve for itself.
   */
  const feedScroll = useOwnScroll(insideTabs);

  /*
   * Both reads go through `lib/community-queries.ts` rather than through a
   * loader written here, so a warm-up can run *these* requests under *these*
   * keys. A board reached from a tab has usually had both answered seconds
   * before it mounted — see `prefetchCommunity`.
   */
  const spacesQuery = communityQuery.spaces();

  const spaces = useResource<CommunitySpaces>(spacesQuery.load, {
    cacheKey: spacesQuery.key,
    topics: spacesQuery.topics,
  });

  const [space, setSpace] = useState(DEFAULT_SPACE);
  const [sort, setSort] = useState<"new" | "top">(DEFAULT_SORT);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [rowWidth, setRowWidth] = useState(0);
  const searchInput = useRef<TextInput>(null);
  const searchProgress = useSharedValue(0);

  /*
   * Page 1 goes through `useResource` like every other GET in the app — it already
   * owns the four states, the silent refocus revalidate and the realtime topic. It
   * has no notion of pages, so later pages are fetched imperatively and kept beside
   * it in `appended`.
   *
   * Splitting it this way is also what keeps the mount effect free of a
   * synchronous `setState`: the fetch that runs on a filter change is
   * `useResource`'s, whose shape is already written around that lint rule.
   */
  const feedQuery = communityQuery.feed(space, sort);

  /*
   * The searched feed, which is the one question here that is **not** cached.
   *
   * A key has to carry everything that changes the answer, so a cached search
   * would have to be keyed on the text — and `community-queries.ts` says at
   * length why that is the wrong thing to keep: the descriptor registry would
   * grow per phrase typed, and four searches would evict a portal's worth of
   * warm answers to make going *back* to a search fast, which nobody does.
   *
   * So a search behaves exactly as this whole screen did before the cache
   * existed: its own loader, its own state, gone on unmount. Clearing the box
   * returns to the cached feed, and that is the transition people do make.
   */
  const searchFeed = useCallback(
    () => getCommunityFeed({ page: 1, q: query, sort, space }),
    [query, sort, space],
  );

  const firstPage = useResource<CommunityFeed>(
    query ? searchFeed : feedQuery.load,
    {
      cacheKey: query ? undefined : feedQuery.key,
      topics: [REALTIME_TOPIC.COMMUNITY],
    },
  );

  const [appended, setAppended] = useState<CommunityPost[]>([]);
  const [lastPage, setLastPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  /** `null` until a later page has been fetched; then that page's own flag. */
  const [tailHasMore, setTailHasMore] = useState<boolean | null>(null);

  const resetTail = useCallback(() => {
    setAppended([]);
    setLastPage(1);
    setTailHasMore(null);
  }, []);

  /*
   * Debounced so typing a phrase is one request rather than one per keystroke. The
   * input stays controlled by `search`; only `query` reaches the server — the web's
   * arrangement, and the reason the two pieces of state are separate.
   *
   * Both `setState` calls are inside the timeout callback, not the effect body.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      resetTail();
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [resetTail, search]);

  const posts = [...(firstPage.data?.posts ?? []), ...appended];
  const hasMore = tailHasMore ?? firstPage.data?.pagination.hasMore ?? false;

  const loadMore = useCallback(() => {
    if (loadingMore || firstPage.refreshing || !hasMore) {
      return;
    }

    setLoadingMore(true);

    const next = lastPage + 1;

    void getCommunityFeed({
      page: next,
      ...(query ? { q: query } : {}),
      sort,
      space,
    })
      .then((feed) => {
        setLastPage(next);
        setTailHasMore(feed.pagination.hasMore);
        setAppended((current) => [...current, ...feed.posts]);
      })
      // A failed "load more" keeps the feed already on screen — only a first page
      // has nothing to fall back to.
      .catch((caught: unknown) =>
        toastError("Could not load more", readApiError(caught)),
      )
      .finally(() => setLoadingMore(false));
  }, [firstPage.refreshing, hasMore, lastPage, loadingMore, query, sort, space]);

  const refresh = useCallback(() => {
    resetTail();
    firstPage.refresh();
  }, [firstPage, resetTail]);

  const viewer = spaces.data?.viewer;
  const canPost = Boolean(viewer?.canPost);
  const chips = spaceChips(spaces.data);

  const chooseSpace = useCallback(
    (id: string) => {
      setSpace(id);
      resetTail();
    },
    [resetTail],
  );

  const afterPost = useCallback(() => {
    resetTail();
    spaces.refresh();
    firstPage.refresh();
  }, [firstPage, resetTail, spaces]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    searchProgress.set(
      withTiming(1, { duration: SEARCH_MS, easing: Easing.out(Easing.cubic) }),
    );
    searchInput.current?.focus();
  }, [searchProgress]);

  /** Closing keeps the phrase — it stays in the row as the "searched" pill. */
  const closeSearch = useCallback(() => {
    searchInput.current?.blur();
    setSearchOpen(false);
    searchProgress.set(
      withTiming(0, { duration: SEARCH_MS, easing: Easing.in(Easing.cubic) }),
    );
  }, [searchProgress]);

  /** The X: throws the phrase away and returns to the plain feed. */
  const cancelSearch = useCallback(() => {
    setSearch("");
    closeSearch();
  }, [closeSearch]);

  /** The keyboard's search key runs it now rather than after the debounce. */
  const submitSearch = useCallback(() => {
    setQuery(search.trim());
    resetTail();
    closeSearch();
  }, [closeSearch, resetTail, search]);

  const searchBarStyle = useAnimatedStyle(() => ({
    opacity: interpolate(searchProgress.value, [0, 0.35], [0, 1], "clamp"),
    width: interpolate(
      searchProgress.value,
      [0, 1],
      [ROW_HEIGHT, Math.max(rowWidth, ROW_HEIGHT)],
    ),
  }));

  const blurProps = useAnimatedProps(() => ({
    intensity: searchProgress.value * SEARCH_BLUR,
  }));

  const blurStyle = useAnimatedStyle(() => ({
    opacity: searchProgress.value,
  }));

  const searched = search.trim();

  const appBar = (
    <AppBar
      actions={
        actions ? (
          <View className="flex-row items-center gap-2">
            {actions}
            <NotificationBell />
          </View>
        ) : (
          <NotificationBell />
        )
      }
      showBack={showBack}
      subtitle="Connect, share and grow together"
      title="Community"
    />
  );

  const header = (
    <View className="gap-3 pb-1">
      {/*
        One row: search, All, and the viewer's hostel. Search is an icon until
        tapped; once a phrase has been searched and the field closed, the icon
        becomes a pill carrying that phrase, which reopens the field.
      */}
      <View
        className="flex-row items-center gap-2"
        onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
        style={{ height: ROW_HEIGHT }}
      >
        {searched ? (
          <Pressable
            accessibilityLabel={`Searched for ${searched}. Edit search`}
            accessibilityRole="button"
            className="max-w-[45%] flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70"
            onPress={openSearch}
            style={{
              borderColor: colors.primary,
              borderWidth: 1,
              height: ROW_HEIGHT,
            }}
          >
            <Glyph color={colors.primary} name="search" size={14} />
            <Text
              numberOfLines={1}
              style={{ color: colors.primary, flexShrink: 1, fontSize: 13, fontWeight: "600" }}
            >
              {searched}
            </Text>
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={8}
              onPress={cancelSearch}
            >
              <Glyph color={colors.primary} name="close" size={14} />
            </Pressable>
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="Search the community"
            accessibilityRole="search"
            className="items-center justify-center rounded-full active:opacity-70"
            onPress={openSearch}
            style={{
              backgroundColor: colors.muted,
              height: ROW_HEIGHT,
              width: ROW_HEIGHT,
            }}
          >
            <Glyph color={colors.foreground} name="search" size={17} />
          </Pressable>
        )}

          {chips.map((chip) => {
            const active = chip.id === space;

            return (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                className="shrink justify-center rounded-full px-4 active:opacity-70"
                key={chip.id}
                onPress={() => chooseSpace(chip.id)}
                style={{
                  backgroundColor: active ? colors.primary : colors.muted,
                  height: 36,
                }}
              >
                <Text
                  numberOfLines={1}
                  className={`text-sm font-medium ${
                    active ? "text-primary-foreground" : "text-foreground"
                  }`}
                >
                  {chip.name}
                </Text>
              </Pressable>
            );
          })}
      </View>

      {/*
        An underlined strip rather than the filled pills this row used to be.
        The chips directly above it are already filled pills for a different
        axis, and two rows of the same control shape meant the space and the sort
        read as one eight-item group where picking any of them did something
        unpredictable. Underline for "which view", fill for "which room".
      */}
      <View className="flex-row items-center gap-5 border-b border-border">
        {SORTS.map((option) => {
          const active = sort === option.id;

          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              className="pb-2.5 pt-1 active:opacity-70"
              key={option.id}
              onPress={() => {
                setSort(option.id);
                resetTail();
              }}
            >
              <Text
                style={{
                  color: active ? colors.foreground : colors.mutedForeground,
                  fontSize: 15,
                  fontWeight: active ? "700" : "500",
                }}
              >
                {option.label}
              </Text>

              {/*
                The bar sits on the container's own bottom border, which is why
                it is `-bottom-px` and two points tall: one point would be
                indistinguishable from the border it covers.
              */}
              {active ? (
                <View
                  className="absolute inset-x-0 -bottom-px rounded-full"
                  style={{ backgroundColor: colors.primary, height: 2 }}
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {canPost ? (
        <Composer onPosted={afterPost} spaces={spaces.data} />
      ) : spaces.data ? (
        <Text className="py-2" variant="muted">
          Sign in to post, comment and react. Reading is open to everyone.
        </Text>
      ) : null}

      {/*
        The header behind an open search, frosted a little. Tapping it closes the
        field and keeps whatever was typed as the searched pill.
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { pointerEvents: searchOpen ? "auto" : "none" },
          blurStyle,
        ]}
      >
        <Pressable
          accessibilityLabel="Close search"
          onPress={closeSearch}
          style={StyleSheet.absoluteFill}
        >
          <AnimatedBlurView
            animatedProps={blurProps}
            style={StyleSheet.absoluteFill}
            tint={isDark ? "dark" : "light"}
          />
        </Pressable>
      </Animated.View>

      {/*
        The floating field. It grows out of the search button's spot to the
        row's full width, over the chips, with its own X at the end.
      */}
      <Animated.View
        className="absolute left-0 top-0 flex-row items-center gap-2 overflow-hidden rounded-full border border-primary bg-background"
        style={[
          {
            height: ROW_HEIGHT,
            paddingHorizontal: 12,
            pointerEvents: searchOpen ? "auto" : "none",
          },
          searchBarStyle,
        ]}
      >
        <Glyph color={colors.primary} name="search" size={FIELD_GLYPH} />

        <TextInput
          className="h-full flex-1 text-base text-foreground"
          onChangeText={setSearch}
          onSubmitEditing={submitSearch}
          placeholder="Search in community…"
          placeholderTextColor={colors.mutedForeground}
          ref={searchInput}
          returnKeyType="search"
          style={{ paddingVertical: 0 }}
          value={search}
        />

        <Pressable
          accessibilityLabel="Close and clear search"
          accessibilityRole="button"
          className="h-7 w-7 items-center justify-center rounded-full active:opacity-70"
          hitSlop={8}
          onPress={cancelSearch}
          style={{ backgroundColor: colors.muted }}
        >
          <Glyph color={colors.foreground} name="close" size={15} />
        </Pressable>
      </Animated.View>
    </View>
  );

  if (firstPage.loading) {
    return (
      <Screen header={appBar} insideTabs={insideTabs}>
        <FeedSkeleton />
      </Screen>
    );
  }

  if (firstPage.error && posts.length === 0) {
    return (
      <Screen header={appBar} insideTabs={insideTabs}>
        <ErrorState message={firstPage.error} onRetry={firstPage.reload} />
      </Screen>
    );
  }

  return (
    <Screen header={appBar} insideTabs={insideTabs} ownScroll padded={false}>
      {/*
        A `FlatList` rather than `<Screen scroll>`: this is the one screen with an
        unbounded list, so rows have to be recycled and `onEndReached` is what
        drives paging. The header travels with the list so search and the chips
        scroll away instead of eating a third of the viewport.

        Reanimated's list, because the handler behind the tab bar animation is a
        worklet: on a plain `FlatList` it would run on the JS thread, which is
        the thread already busy rendering these rows.

        Its content padding is a style rather than the `contentContainerClassName`
        the rest of the app writes, because NativeWind only styles components it
        has an interop for and an animated list is not one of them — a class here
        would be dropped without a word.
      */}
      <Animated.FlatList<CommunityPost>
        ListEmptyComponent={
          <EmptyState icon="chatbubbles" description={emptyFeedMessage(query)} title="Nothing here" />
        }
        ListFooterComponent={
          loadingMore ? (
            <View className="py-6">
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : null
        }
        ListHeaderComponent={header}
        ItemSeparatorComponent={FeedDivider}
        contentContainerStyle={{
          paddingBottom: feedScroll.scrollPaddingBottom,
          paddingHorizontal: 20,
          paddingTop: 8,
        }}
        data={posts}
        keyExtractor={(post) => post.id}
        keyboardShouldPersistTaps="handled"
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        onRefresh={refresh}
        onScroll={feedScroll.onScroll}
        refreshing={firstPage.refreshing}
        /*
          The keyboard-aware scroller under the list, so a comment or reply field
          opened on a post low in the feed scrolls up above the keyboard instead
          of being hidden by it. `<Screen scroll>` does the same for every form.
        */
        renderScrollComponent={(props) => (
          <KeyboardAwareScrollView {...props} bottomOffset={KEYBOARD_GAP} />
        )}
        renderItem={({ item }) => (
          <CommunityPostCard canPost={canPost} onChanged={afterPost} post={item} />
        )}
        scrollEventThrottle={feedScroll.scrollEventThrottle}
      />
    </Screen>
  );
}

/**
 * What the feed loads into: flat posts split by the same hairline, never cards.
 *
 * `SkeletonRows` is the wrong shape here for the one reason that matters about a
 * skeleton — it draws bordered boxes with page showing between them, and this
 * list has neither. The placeholder has to reflow into the real thing, not into
 * something a border away from it.
 */
function FeedSkeleton() {
  return (
    <View>
      {[0, 1, 2].map((post, index) => (
        <View key={post}>
          {index > 0 ? <FeedDivider /> : null}

          <View className="gap-3 py-4">
            <View className="flex-row items-center gap-3">
              <Skeleton height={36} radius={18} width={36} />
              <View className="flex-1 gap-1.5">
                <Skeleton height={12} width="45%" />
                <Skeleton height={10} width="25%" />
              </View>
            </View>

            <SkeletonText lines={3} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Posts sit flat on the page, split by a hairline instead of boxed in cards. */
function FeedDivider() {
  return <View className="h-px bg-border" />;
}

/** The sort strip. Two entries, because the API's `sort` enum has two values. */
const SORTS: { id: "new" | "top"; label: string }[] = [
  { id: "new", label: "New" },
  { id: "top", label: "Top" },
];

/**
 * The bell, with a dot when something is unread.
 *
 * A **dot**, not the count `discovery-header` draws. The home screen's bell is
 * the only one on that screen and has room to be specific; this one sits beside
 * a title and a subtitle in a bar that also has to hold a back button on every
 * pushed instance. What a reader does with the number here is the same thing
 * they do with the dot — open the screen — so the digits buy nothing and cost
 * the width.
 *
 * Signed out there is nothing to count, and `/notifications` would 401 on every
 * mount and refocus, so the bell is **absent** rather than empty.
 */
function NotificationBell() {
  const { colors } = useAppTheme();
  const account = useAppSelector((state) => state.auth.account);

  /*
   * The same entry `<NotificationBell>` and `app/notifications.tsx` read — this
   * used to be its own unkeyed `filter=unread` request, which is the second
   * request for one answer that `lib/notification-queries.ts` exists to remove.
   * The count is over the whole mailbox, not over the page, so the `all` payload
   * carries everything this dot needs.
   */
  const query = notificationQuery.feed(DEFAULT_NOTIFICATION_FILTER);
  const feed = useResource<NotificationFeed>(
    useCallback(
      async () =>
        account
          ? await query.load()
          : { actionCount: 0, notifications: [], unreadCount: 0 },
      [account, query],
    ),
    { cacheKey: account ? query.key : undefined, topics: query.topics },
  );

  if (!account) {
    return null;
  }

  // A failed count shows no dot, which is what "nothing unread" shows anyway.
  const unread = feed.data?.unreadCount ?? 0;

  return (
    <Pressable
      accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      accessibilityRole="button"
      className="h-10 w-10 items-center justify-center rounded-full active:opacity-70"
      hitSlop={6}
      onPress={() => router.push("/notifications")}
    >
      <Glyph color={colors.foreground} name="notifications" size={22} />

      {unread > 0 ? (
        <View
          className="absolute right-2 top-2 rounded-full"
          style={{
            backgroundColor: colors.primary,
            // Ringed in the bar's own colour so the dot reads as sitting on top
            // of the bell rather than as part of its outline.
            borderColor: colors.background,
            borderWidth: 2,
            height: 12,
            width: 12,
          }}
        />
      ) : null}
    </Pressable>
  );
}

/**
 * The composer.
 *
 * Media uploads on pick — same reasoning as the complaint form — and goes up
 * **`PUBLIC`**, matching the web's `useUploader({ accessLevel: "PUBLIC" })`. It has
 * to: a public post is read by people who are neither the asset's owner nor in the
 * author's hostel, and the file route default-denies exactly that.
 *
 * The picker is images-only. `expo-video` is not a dependency, so a video could be
 * posted and then not played by anyone on this client — and a post nobody on the
 * phone can watch is not a feature. Existing videos in the feed open in the OS
 * player.
 *
 * **There is no anonymous toggle.** `communityPostCreateSchema` is
 * `{ body, visibility, media }` — no `isAnonymous` field exists on the schema or
 * the model, so the control would be a lie.
 *
 * ## The mockup's shape: a face, a line, and one row of controls
 *
 * This was a stacked form — textarea, then a row, then an audience line, then a
 * members-only checkbox — four rows deep before the first post in the feed. The
 * mockup collapses it: the viewer's avatar beside a single-line field, and one
 * footer row holding Photo, the audience, and Post.
 *
 * The audience stopped being a checkbox in that move and became the thing it
 * always was: a **choice of where this lands**, phrased as the destination
 * rather than as a restriction. "Members only" ticked and unticked is the same
 * two options as "Public" and "Green View", except the checkbox only makes sense
 * to somebody who already knows what it would otherwise default to.
 *
 * A public-space author still gets no chevron. `createCommunityPost` forces
 * `PUBLIC` for them because there is no narrower room to fall back to, so the
 * line states where the post is going and does not pretend to ask.
 *
 * No box around it: the field is a filled pill and a hairline below separates
 * the composer from the first post, the same divider the posts use.
 */
function Composer({
  onPosted,
  spaces,
}: {
  onPosted: () => void;
  spaces: CommunitySpaces | null;
}) {
  const { colors } = useAppTheme();
  const account = useAppSelector((state) => state.auth.account);
  const [body, setBody] = useState("");
  const [media, setMedia] = useState<{ assetId: string; uri: string }[]>([]);
  const [membersOnly, setMembersOnly] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [audienceOpen, setAudienceOpen] = useState(false);

  const target = composerTarget(spaces);
  const audiences = audienceOptions(spaces);

  const addPhoto = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to attach an image.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    const picked = result.canceled ? null : result.assets[0];

    if (!picked) {
      return;
    }

    setUploading(true);

    try {
      const assetId = await uploadAsset(picked, {
        accessLevel: "PUBLIC",
        kind: "GENERIC",
        label: "Community photo",
      });

      setMedia((current) => [...current, { assetId, uri: picked.uri }]);
    } catch (caught) {
      toastError("That image did not attach", readApiError(caught));
    } finally {
      setUploading(false);
    }
  }, []);

  const publish = useCallback(async () => {
    setPosting(true);

    try {
      const attachments: CommunityMedia[] = media.map((item) => ({
        assetId: item.assetId,
        kind: "IMAGE",
      }));

      await createCommunityPost({
        body: body.trim(),
        media: attachments,
        visibility: postVisibility(spaces, membersOnly),
      });

      setBody("");
      setMedia([]);
      setMembersOnly(false);
      toastSuccess("Posted");
      onPosted();
    } catch (caught) {
      toastError("Could not post", readApiError(caught));
    } finally {
      setPosting(false);
    }
  }, [body, media, membersOnly, onPosted, spaces]);

  const ready = canPublish(body, media.length) && !uploading;
  const name = account?.name ?? "You";
  const avatarUrl = usableAvatarUrl(account?.image);
  const [tone, ink] = avatarTone(name);
  const audience = membersOnly ? audiences.restricted : audiences.open;

  return (
    <View className="gap-3 border-b border-border pb-4 pt-1">
      <View className="flex-row items-start gap-2.5">
        {avatarUrl ? (
          <Image
            cachePolicy="memory-disk"
            contentFit="cover"
            source={{ uri: avatarUrl }}
            style={{ borderRadius: AVATAR / 2, height: AVATAR, width: AVATAR }}
          />
        ) : (
          <View
            className="items-center justify-center rounded-full"
            style={{ backgroundColor: tone, height: AVATAR, width: AVATAR }}
          >
            <Text style={{ color: ink, fontSize: 15, fontWeight: "700" }}>
              {avatarInitial(name)}
            </Text>
          </View>
        )}

        {/*
          The field grows from one line to five and then scrolls, rather than
          starting at the old fixed 76dp. Empty, the composer is a prompt and
          should take a prompt's worth of room; typing a paragraph into a box
          that cannot show it is the reason people post half a thought.
        */}
        <TextInput
          className="flex-1 rounded-2xl px-4 text-base text-foreground"
          maxLength={MAX_POST_BODY}
          multiline
          onChangeText={setBody}
          placeholder="What's on your mind?"
          placeholderTextColor={colors.mutedForeground}
          style={{
            backgroundColor: colors.muted,
            maxHeight: 132,
            minHeight: AVATAR,
            paddingTop: 9,
            paddingBottom: 9,
            textAlignVertical: "top",
          }}
          value={body}
        />
      </View>

      {media.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {media.map((item) => (
            <View className="relative" key={item.assetId}>
              <Image
                cachePolicy="memory-disk"
                contentFit="cover"
                source={{ uri: item.uri }}
                style={{
                  backgroundColor: colors.muted,
                  borderRadius: 10,
                  height: 72,
                  width: 72,
                }}
              />
              <Pressable
                accessibilityLabel="Remove image"
                accessibilityRole="button"
                className="absolute -right-1.5 -top-1.5 h-6 w-6 items-center justify-center rounded-full"
                hitSlop={8}
                onPress={() =>
                  setMedia((current) =>
                    current.filter((entry) => entry.assetId !== item.assetId),
                  )
                }
                style={{ backgroundColor: colors.destructive }}
              >
                <Glyph color="#ffffff" name="close" size={13} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View className="flex-row items-center gap-3">
        {media.length < MAX_POST_MEDIA ? (
          <Pressable
            accessibilityRole="button"
            className="flex-row items-center gap-1.5 active:opacity-70"
            disabled={uploading}
            hitSlop={6}
            onPress={() => void addPhoto()}
          >
            <Glyph
              color={colors.mutedForeground}
              name={uploading ? "hourglass" : "image"}
              size={18}
            />
            <Text variant="caption">{uploading ? "Adding…" : "Photo"}</Text>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityLabel={`Posting to ${audience}`}
          accessibilityRole={target.canChooseAudience ? "button" : "text"}
          className="min-w-0 flex-1 flex-row items-center gap-1.5 active:opacity-70"
          disabled={!target.canChooseAudience}
          hitSlop={6}
          onPress={() => setAudienceOpen(true)}
        >
          <Glyph
            color={colors.mutedForeground}
            name={membersOnly ? "people" : "globe"}
            size={16}
          />
          <Text
            numberOfLines={1}
            style={{ color: colors.primary, fontSize: 12, fontWeight: "600" }}
          >
            {audience}
          </Text>
          {target.canChooseAudience ? (
            <Glyph color={colors.primary} name="chevron-down" size={13} />
          ) : null}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: posting, disabled: !ready }}
          className="h-10 flex-row items-center gap-1.5 rounded-xl px-4 active:opacity-80"
          disabled={!ready || posting}
          onPress={() => void publish()}
          style={{ backgroundColor: ready ? colors.primary : colors.muted }}
        >
          {/*
            The send arrow becomes the spinner while the post is at the server,
            in the button's own ink. Swapping the label to "Posting…" on its own
            left nothing on the screen moving, which on a slow hostel connection
            is indistinguishable from a tap that missed.
          */}
          {posting ? (
            <ActivityIndicator color={colors.primaryForeground} size="small" />
          ) : (
            <Glyph
              color={ready ? colors.primaryForeground : colors.mutedForeground}
              name="send"
              size={14}
            />
          )}
          <Text
            className="text-sm font-semibold"
            style={{ color: ready ? colors.primaryForeground : colors.mutedForeground }}
          >
            {posting ? "Posting…" : "Post"}
          </Text>
        </Pressable>
      </View>

      {/* Only a hostel post has an audience to narrow — a public-space author has
          no smaller room, and the service forces PUBLIC for them regardless. */}
      {target.canChooseAudience ? (
        <Sheet
          bare
          onClose={() => setAudienceOpen(false)}
          open={audienceOpen}
          title="Post to"
        >
          <SheetRow
            label={audiences.open}
            onPress={() => {
              setMembersOnly(false);
              setAudienceOpen(false);
            }}
            selected={!membersOnly}
            subtitle="Anyone can read it, signed in or not"
          />
          <SheetRow
            label={audiences.restricted}
            onPress={() => {
              setMembersOnly(true);
              setAudienceOpen(false);
            }}
            selected={membersOnly}
            subtitle="Only people in your hostel"
          />
        </Sheet>
      ) : null}
    </View>
  );
}
