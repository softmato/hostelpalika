import "@/global.css";

import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { BlurTargetView } from "expo-blur";
import { router, Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useRef, useState } from "react";
import { Platform, StatusBar as RNStatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import { Provider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";

import { hydrateQueryCache } from "@/lib/query-cache-persist";

import { BottomChromeProvider } from "@/components/bottom-chrome";
import { AppLockHost, AppLockOffer } from "@/components/app-lock";
import { AssetViewer } from "@/components/asset-viewer";
import {
  BootSplashCover,
  bootSplashGone,
  BrandSplash,
  releaseBootSplash,
} from "@/components/brand-splash";
import { HostelSuspensionHost } from "@/components/hostel-suspension-host";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { UpdateSheet } from "@/components/update-sheet";
import { PushOffer } from "@/components/push-offer";
import { UploadToaster } from "@/components/upload-toaster";
import { ReceiptNativeSync } from "@/components/receipt-native-sync";
import { SharedPaymentResume } from "@/components/shared-payment-resume";
import { ResidencyInviteHost } from "@/components/residency-invite-host";
import { useAppDispatch } from "@/hooks/redux";
import { primeColorScheme, useAppTheme } from "@/hooks/use-app-theme";
import { usePush } from "@/hooks/use-push";
import { useRealtime } from "@/hooks/use-realtime";
import { useRoleSync } from "@/hooks/use-role-sync";
import { useUploads } from "@/hooks/use-uploads";
import { resolveHome } from "@/constants/roles";
import { bootstrapSession, revalidateSession } from "@/lib/auth-session";
import { appBlurTarget } from "@/lib/blur-target";
import { startUploadNotifications } from "@/lib/upload-notifier";
import { persistor, store } from "@/store";
import { setReady } from "@/store/slices/authSlice";

// Held until the boot gate in app/index.tsx has chosen a route. See §0 of
// docs/MOBILE_APP_PHASES.md — hiding it earlier is what causes the login flash.
void SplashScreen.preventAutoHideAsync();

function RootShell() {
  const dispatch = useAppDispatch();
  const { colors, isDark } = useAppTheme();
  const [splashGone, setSplashGone] = useState(false);

  useEffect(() => {
    void bootSplashGone().then(() => setSplashGone(true));
  }, []);

  /*
   * The route this launch started on, read through a ref so the boot effect can
   * look at it after an await without re-running when it changes.
   *
   * `/` is the boot gate. Anything else means a deep link mounted its own screen
   * — see the re-route guard below.
   */
  const pathname = usePathname();
  const pathRef = useRef(pathname);

  useEffect(() => {
    pathRef.current = pathname;
  });

  /*
   * Both live at the root, and both are no-ops while signed out.
   *
   * Push registration has to outlive any one screen — a notification tapped
   * from the tray can mount any route, and the listener that routes it must
   * already exist. The socket is here for the same reason the upload toaster
   * is: it belongs to the session, not to whatever happens to be on screen.
   */
  usePush();
  useRealtime();

  /*
   * And the third way an account catches up with itself: the app coming back to
   * the front. Cold start is handled by the boot effect below and a delivered
   * push by `usePush`; this is the resume in between, which is where most
   * approvals actually land. See `useRoleSync`.
   */
  useRoleSync();

  /*
   * The shade's half of the universal uploader.
   *
   * At the root for the same reason the toaster is: a transfer outlives the
   * screen that started it, and the case this exists for is the user *leaving*
   * the app mid-upload — where the toaster, and every screen, is gone. It posts
   * nothing unless notification permission has already been granted; it never
   * asks (§4.5).
   */
  useEffect(() => startUploadNotifications(), []);

  /*
   * The splash is uncovered here, not in the boot gate.
   *
   * `app/index.tsx` used to own this, which worked for every launch that starts
   * at `/` — but a deep link does not. `hostelpalika://ref/<code>` mounts
   * `app/ref/[code].tsx` directly and never renders the gate, so the hide never
   * fired and the splash stayed over the app permanently. The root layout is the
   * one component mounted on every route, deep-linked or not.
   *
   * It fires on mount rather than waiting for `isReady`, and the handover is
   * still seamless because `BrandSplash` is the launch screen's end state with
   * the same pixels. On Android the system splash is already gone by now —
   * MainActivity let it go for the native launch screen — so `hideAsync` matters
   * on iOS, and `releaseBootSplash` lets the launch screen leave once its
   * animation has played (see `components/brand-splash.tsx`).
   *
   * There is still nothing to flash past. This effect runs after the subtree
   * below has committed, and while `isReady` is false every route under it —
   * the gate, and `PersistGate` above it — renders `BrandSplash`. The login
   * screen the boot contract exists to hide is never among them.
   */
  useEffect(() => {
    void SplashScreen.hideAsync();
    releaseBootSplash();
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Captured before anything awaits: by the time revalidation answers, the
    // gate has long since redirected, so "are we at `/` now" would always be
    // false. What matters is where this launch came in.
    const startedAt = pathRef.current;

    async function boot() {
      // Restores the token into memory and returns the *cached* account. No
      // network — index.tsx routes off this synchronously.
      await bootstrapSession();

      if (cancelled) return;

      dispatch(setReady(true));

      /*
       * Now that a screen is on its way, confirm the cache against the server.
       * A failure is ignored, because an offline launch should still show the
       * last known dashboard.
       *
       * The result was previously discarded, which made the "and the role has
       * not changed" half of the boot contract (§0 step 3) a no-op: a resident
       * promoted to warden on the web, an account whose provider application
       * was approved, or a QR activated on another device all stayed on the
       * stale screen until the next cold start. `revalidateSession` only
       * returns an account when something actually moved, so this re-routes
       * exactly then and never on an ordinary launch.
       */
      const changed = await revalidateSession();

      if (cancelled || !changed) {
        return;
      }

      /*
       * Only re-route a launch that started at the boot gate.
       *
       * A deep link mounts its own screen — `hostelpalika://ref/<code>`,
       * `guardian-invite?token=…`, a notification's invoice — and the user is
       * looking at the thing they tapped. Replacing it a second later because
       * revalidation noticed a changed role is the app taking the screen away
       * mid-read, and it lands hardest on exactly the links where a flag *has*
       * just moved: a QR activated on another device, an invitation accepted.
       *
       * `/` is the gate's own path, so this is true only for an ordinary launch.
       * Anything else keeps its screen; the store is already updated, so the
       * correct tabs are underneath when they navigate back.
       */
      if (startedAt !== "/") {
        return;
      }

      router.replace(
        resolveHome({
          isApprovedProvider: changed.isServiceProvider,
          isResidentActivated: store.getState().auth.isResidentActivated ?? true,
          role: changed.role,
        }),
      );
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    /*
     * Force the window to draw under the status bar.
     *
     * Edge-to-edge is mandatory from RN 0.86 — but that is a property of the
     * *activity*, and in Expo Go the activity belongs to Expo Go, not to us.
     * Its theme paints an opaque status bar, so the app window starts below it:
     * `insets.top` comes back as 0, the AppBar sits flush under a black band,
     * and no amount of padding helps because the band is not ours to paint.
     *
     * The giveaway is that changing the system theme fixes it — that is a
     * configuration change, which tears down and rebuilds the activity with the
     * flags re-applied. Setting them here does the same thing at launch.
     *
     * Harmless in a development or production build, where the activity is
     * already edge-to-edge and these are no-ops.
     */
    RNStatusBar.setTranslucent(true);
    RNStatusBar.setBackgroundColor("transparent", false);
  }, []);

  useEffect(() => {
    /*
     * The window's own background shows through during rotation and while a
     * screen is mounting, so it has to match the theme — otherwise a white
     * flash appears on a dark app, and vice versa.
     */
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);

  return (
    <>
      {/*
        The status bar is always translucent now — edge-to-edge is mandatory in
        SDK 57, so `translucent` was removed from the props entirely and the
        AppBar's colour runs to the top of the screen by default. All that is
        left to choose is the glyph colour: dark on the light theme's white bar,
        light on dark — and dark while the white launch screen is still up.
      */}
      <StatusBar style={isDark && splashGone ? "light" : "dark"} />

      {/*
        Everything the confirm dialog's backdrop blurs, named as one view.

        Android cannot sample what is behind a layer the way iOS does, so
        `expo-blur@57` requires the content to be captured to be pointed at
        explicitly — without this the dialog logged "blurTarget has not been
        configured" and fell back to a flat tint. See `lib/blur-target.ts`.

        Layout-neutral: it is the `flex: 1` box the navigator was already filling
        on its own.
      */}
      <BlurTargetView ref={appBlurTarget} style={{ flex: 1 }}>
      {/*
        Screens fade up in place rather than sliding in from the edge.

        Every detail view here used to be `slide_from_right`, which is the
        platform default and reads as *travel*: the screen you tapped from is
        pushed sideways and the new one arrives from off-canvas. On a product
        that is mostly a grid of icon tiles opening the thing under your thumb,
        that made a two-tap round trip feel like a journey.

        `fade` is the popup reading of the same push: tap, and the destination
        resolves where you already are. It stays a real push — the back gesture,
        the stack and the tab bar underneath are all unchanged — so nothing here
        is a modal presentation, only a different way of arriving.

        `animationDuration` is set once, on the default, because a crossfade
        that runs for the length of a slide reads as lag rather than as motion:
        the whole screen is mid-opacity for the middle of it, which is the one
        frame a slide never shows. 180ms is inside the Doherty budget and long
        enough not to strobe.

        The four `slide_from_bottom` screens below keep their animation on
        purpose — those are the "fill this in and finish" forms, and rising from
        the bottom edge is what tells you the thing is dismissible.
      */}
      <Stack
        screenOptions={{
          animation: "fade",
          animationDuration: 180,
          contentStyle: { backgroundColor: colors.background },
          headerShown: false,
        }}
      >
        <Stack.Screen name="index" options={{ animation: "none" }} />
        {/*
          The discovery shell, and the app's home for everyone who is not routed
          to a role dashboard — signed in or not. There is no separate signed-out
          group; see `constants/roles.ts` for what that replaced.
        */}
        <Stack.Screen name="(browse)" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(resident)" />
        <Stack.Screen name="(guardian)" />
        <Stack.Screen name="(cook)" />
        <Stack.Screen name="(provider)" />
        <Stack.Screen name="(admin)" />
        {/*
          The supply store, entered from the shortcut on admin Home.

          Its own group with its own tab bar rather than four screens pushed onto
          the admin stack: a shop is a place you move around inside, and pushing
          would have meant no way to reach Orders without going through the shop
          first. The back arrow on its header leaves the group entirely, which is
          why it sits here on the root stack beside `(admin)` rather than under
          it.
        */}
        <Stack.Screen name="(store)" />
        <Stack.Screen name="activate" />
        {/*
          Detail screens live at the root, not inside a role's tab group: a
          folder nested under a `<Tabs>` layout becomes another tab. Pushed
          from the root stack, the invoice fades in over the tab bar the way a
          detail view should.
        */}
        <Stack.Screen name="invoice/[id]/index" />
        <Stack.Screen name="invoice/[id]/pay" />
        <Stack.Screen name="invoice/[id]/claim" />
        <Stack.Screen name="checkout/[reference]" />
        {/*
          Discovery detail screens, also at the root: they are reachable from
          the signed-out public stack *and* from a resident's More tab, so they
          cannot live inside either group.
        */}
        <Stack.Screen name="hostel/[slug]/index" />
        <Stack.Screen name="hostel/[slug]/inquiry" />
        {/* The map, opened by the distance badge on any card that has one. */}
        <Stack.Screen name="map" />
        <Stack.Screen name="directions/[slug]" />
        <Stack.Screen name="compare" />
        {/* Browse with a back button, for the roles whose More tab links to it. */}
        <Stack.Screen name="hostels" />
        {/*
          The shortlist, on its own. At the root rather than inside `(browse)`
          because the Profile tab is where it is reached from, and a fifth tab
          for a list that is empty on a fresh install is a tab bar that spends a
          slot on nothing.
        */}
        <Stack.Screen name="saved" />
        {/*
          The website's header and footer, natively (see `(browse)/profile.tsx`).
          At the root because they are reachable from the Profile tab *and* from
          a role's More tab, so they cannot live inside either group — and
          because a legal document opening over the tab bar is a detail view.
        */}
        <Stack.Screen name="about" />
        <Stack.Screen name="contact" />
        <Stack.Screen name="pricing" />
        {/*
          Two screens, one programme, and the split is deliberate.

          `offer-program/index` is the **public explainer** — it renders signed
          out, because the two moments somebody most wants to read about the
          programme are the confirmation email after submitting a proof and a
          conversation with a parent who has no account at all.

          `offer-program/mine` is the **resident's own** view: which code is live
          for them, what has been certified, what is still being checked. It is a
          different question asked at a different moment, which is why it is a
          second destination rather than a tab on the first.
        */}
        <Stack.Screen name="offer-program/index" />
        <Stack.Screen name="offer-program/mine" />
        <Stack.Screen name="register-hostel/index" />
        <Stack.Screen name="service-providers/index" />
        {/*
          The two application wizards. They used to be `WebBrowser.openBrowserAsync`
          calls — see `lib/web-portal.ts`, whose `WEB_PUBLIC_PATHS` no longer has
          anything in it. Both are long forms someone works through in one sitting,
          so they fade in like any other detail screen and keep the
          back gesture that a browser tab took away.
        */}
        <Stack.Screen name="register-hostel/apply" />
        <Stack.Screen name="service-providers/apply" />
        <Stack.Screen name="legal/terms" />
        <Stack.Screen name="legal/privacy" />
        <Stack.Screen name="legal/refund-policy" />
        <Stack.Screen name="legal/how-booking-works" />
        {/* Room booking: checkout, the person's list, one booking. docs/BOOKINGS.md items 22–23. */}
        <Stack.Screen name="book/[slug]" />
        <Stack.Screen name="bookings/index" />
        <Stack.Screen name="booking/[id]" />
        {/*
          The SOS floating button's tap destination. At the root rather than in
          `(resident)/`, so pushing it opens over the tab bar — and so the
          button that opens it, which lives in the resident layout, is not
          rendering a screen inside itself.
        */}
        <Stack.Screen name="sos" options={{ animation: "slide_from_bottom" }} />
        {/*
          Complaints, reached from the More tab and from a push. At the root for
          the same reason invoices are — and because a complaint push arrives for
          a resident whose complaint may be open on any tab.
        */}
        <Stack.Screen name="complaints/index" />
        <Stack.Screen name="complaints/new" options={{ animation: "slide_from_bottom" }} />
        <Stack.Screen name="complaints/[id]" />
        {/* Reached from More and from the dashboard's night-status card. */}
        <Stack.Screen name="night-status" />
        {/* The resident's own record of those answers, night by night. */}
        <Stack.Screen name="night-status-history" />
        {/* Khata: the resident's own (Payments), and the kitchen's asks (cook Today). */}
        <Stack.Screen name="khata" />
        <Stack.Screen name="khata-asks" />
        {/* The cook's Kitchen stock: what was taken from the store (docs/INVENTORY_PLAN.md). */}
        <Stack.Screen name="kitchen-stock" />
        {/*
          What the app has recorded about where the resident was, and the two
          controls over it. At the root beside `night-status` because the two are
          the same subject from opposite ends — one is what the resident says,
          the other is what their phone reported.
        */}
        <Stack.Screen name="attendance" />
        {/*
          A provider's job detail. At the root for the same reason an invoice is:
          it opens over the tab bar rather than becoming a fourth tab.
        */}
        <Stack.Screen name="job/[id]" />
        <Stack.Screen name="profile" />
        {/*
          Who the resident has shared their record with. At the root rather than
          inside `(resident)` because it is reached from Profile, which is itself
          a root screen — and because the guardian relationship outlives the tab
          you happened to be on when you went looking for it.
        */}
        <Stack.Screen name="guardians/index" />
        {/* A form you open, fill and finish — same shape as `complaints/new`. */}
        <Stack.Screen name="guardians/new" options={{ animation: "slide_from_bottom" }} />
        <Stack.Screen name="id-card/index" />
        {/*
          Bottom, not right: this is a form you open, fill and finish — the same
          shape as `complaints/new` — and on the web it is literally a modal. The
          card it belongs to fades in like every other destination.
        */}
        <Stack.Screen name="id-card/edit" options={{ animation: "slide_from_bottom" }} />
        <Stack.Screen name="referrals" />
        <Stack.Screen name="review" />
        {/*
          Community is readable signed out, so it sits on the root stack next to
          the public group rather than inside any role's tabs — and
          `community/[postId]` is a push and share-link target.
        */}
        <Stack.Screen name="community/index" />
        <Stack.Screen name="community/[postId]" />
        {/*
          The admin management screens (tasks.md §12). At the root rather than
          inside `(admin)`, because that group's file names *are* its tab bar —
          a file added there becomes a tab or has to be named in `HIDDEN`. These
          are detail views reached from More, from Settings and from the roster,
          and they open over the tab bar like every other one.
        */}
        <Stack.Screen name="manage/rooms" />
        <Stack.Screen name="manage/notices" />
        <Stack.Screen name="manage/push-notices/index" />
        <Stack.Screen name="manage/push-notices/[id]" />
        <Stack.Screen name="manage/inquiries" />
        <Stack.Screen name="manage/bookings" />
        <Stack.Screen name="manage/roll-call" />
        <Stack.Screen name="manage/food" />
        <Stack.Screen name="manage/maintenance" />
        <Stack.Screen name="manage/complaints" />
        <Stack.Screen name="manage/reports" />
        <Stack.Screen name="manage/settings" />
        <Stack.Screen name="manage/wardens" />
        <Stack.Screen name="manage/referrals" />
        <Stack.Screen name="manage/invite-hostels" />
        <Stack.Screen name="manage/attendance" />
        <Stack.Screen name="manage/announcements" />
        <Stack.Screen name="manage/move-history" />
        <Stack.Screen name="manage/finance/index" />
        <Stack.Screen name="manage/finance/history" />
        <Stack.Screen name="manage/finance/room-rates" />
        <Stack.Screen name="manage/finance/rates" />
        <Stack.Screen name="manage/finance/payment-setup" />
        <Stack.Screen name="manage/finance/payouts" />
        <Stack.Screen name="manage/finance/gateway/[provider]" />
        <Stack.Screen name="manage/statements" />
        {/* Money Out — owner, warden and cook share these two (docs/EXPENSES_PLAN.md). */}
        <Stack.Screen name="expenses/index" />
        <Stack.Screen name="expenses/new" />
        {/* Stock — Bought, Send, Count across the main hostel and its branches (docs/INVENTORY_PLAN.md). */}
        <Stack.Screen name="stock/index" />
        <Stack.Screen name="stock/use" />
        <Stack.Screen name="stock/buy" />
        <Stack.Screen name="stock/send" />
        <Stack.Screen name="stock/count" />
        <Stack.Screen name="stock/history" />
        <Stack.Screen name="stock/item/[id]" />
        <Stack.Screen name="stock/entry/[id]" />
        <Stack.Screen name="stock/receive/[id]" />
        <Stack.Screen name="stock/suppliers" />
        <Stack.Screen name="stock/supplier/[id]" />
        <Stack.Screen name="stock/reports" />
        <Stack.Screen name="stock/usage" />
        {/* Overall: one subject over every branch, from the Overall Home's tiles. */}
        <Stack.Screen name="overall/[topic]" />
        <Stack.Screen name="manage/existing-residents" />
        <Stack.Screen name="manage/resident/[id]" />
        {/* Bottom, like every other "fill this in and finish" form in the app. */}
        <Stack.Screen
          name="manage/resident/new"
          options={{ animation: "slide_from_bottom" }}
        />
        {/*
          The card scanner, and the dossier it opens.

          The scanner rises from the bottom for the same reason `sos` and
          `complaints/new` do: it is a thing you open, use once and throw away,
          not a place you navigate to. Its chevron points down to say so.

          The dossier it pushes fades like every other detail view — it is a
          destination, and it has to survive a back gesture landing on a live
          camera rather than on a second copy of itself.
        */}
        <Stack.Screen name="manage/scan/index" options={{ animation: "slide_from_bottom" }} />
        <Stack.Screen name="manage/scan/[residentId]" />
        {/*
          The `store` folder owns a nested stack for product, order and
          checkout details. Its grandchildren are configured by
          `store/_layout.tsx`, while the root stack only owns the folder route.

          The product screen still bleeds its artwork to the top of the display;
          it remains outside the `(store)` tabs and above their tab bar.
        */}
        <Stack.Screen name="settings" />
        {/*
          The bell's destination. At the root because `GET /notifications` is
          scoped to the caller's own user id with no role branch — one screen
          serves every audience, so it cannot live inside any one tab group.
        */}
        <Stack.Screen name="notifications" />
        {/*
          The referral deep link. The file name is the handler — expo-router
          resolves `hostelpalika://ref/<code>` here on a cold start and while the
          app is already running, so there is no cold-start case to forget.
        */}
        <Stack.Screen name="ref/[code]" />
        {/*
          The guardian invitation deep link. The file name matches the path in
          the email — `guardian-invite.service.ts` builds
          `{siteUrl}/guardian-invite?token=…` — so the https link routes here
          the day verified app links are configured, and
          `hostelpalika://guardian-invite?token=…` already does.
        */}
        <Stack.Screen name="guardian-invite" />
        {/*
          The cook invitation deep link, on the same rule and for the same
          reason — `cook-roster.service.ts` builds
          `{siteUrl}/cook-invite?token=…`.
        */}
        <Stack.Screen name="cook-invite" />
      </Stack>

      {/*
        Above the transient toasts and below nothing: an upload can outlive the
        screen that started it, so its report is drawn at the app root.
      */}
      <UploadToaster />

      {/*
        The one asset viewer. At the root because any screen can open it, and
        because a `Modal` mounted inside a tab would still be inside that tab's
        navigator — this one has to draw over the tab bar and the SOS button.
      */}
      <AssetViewer />

      {/*
        "Your hostel added you as a resident" — at the root so it reaches a
        signed-in public account on any screen, and on the way back from a push.
      */}
      <ResidencyInviteHost />
      <UpdateSheet />
      <AppLockOffer />
      <PushOffer />
      <SharedPaymentResume />
      <ReceiptNativeSync />
      </BlurTargetView>

      {/*
        The app's alert card, and the only things outside the blur target: a
        view cannot blur a buffer it is itself drawn into. Being siblings *after*
        the target is also what puts them over the tab bar — neither is a
        `Modal`, see `confirm-dialog.tsx` for why.

        The hostel suspension goes first, so a question asked while it is up
        still draws above it.
      */}
      <HostelSuspensionHost />
      <ConfirmDialogHost />

    </>
  );
}

/**
 * Transient toasts move down to clear the upload cards rather than stacking on
 * top of them — 88px is one card plus its gap, which is the only case that
 * overlaps in practice.
 *
 * Mounted after `BottomSheetModalProvider`, not inside it: the provider draws
 * every sheet in a portal after its children, so a toast inside it rendered
 * *under* an open sheet — an error from a sheet's own button was invisible.
 */
function ToastHost() {
  const uploads = useUploads();

  return <Toast topOffset={uploads.length > 0 ? 60 + 88 * uploads.length : 60} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Provider store={store}>
        {/*
          The gate cannot read the cached account until rehydration finishes, so
          the same BrandSplash covers that wait — identical pixels to the native
          splash, so the user sees one continuous screen.
        */}
        <PersistGate
          loading={<BrandSplash />}
          // The last session's answers, back in the query cache before any
          // screen mounts, so a cold start paints instead of loading — and the
          // saved theme in place, so it paints in the right one.
          onBeforeLift={() => {
            primeColorScheme(store.getState().ui.themePreference);
            return hydrateQueryCache();
          }}
          persistor={persistor}
        >
          <SafeAreaProvider>
            {/* Drives `Screen`'s keyboard-aware scroll and sticky footer on both platforms. */}
            <KeyboardProvider>
              <BottomSheetModalProvider>
                {/*
                  At the root, not inside the tab navigator: the signed-out home
                  is a plain stack with a floating Log in pill and no tabs, and it
                  must hide and return on scroll exactly like a tab bar does.
                */}
                <BottomChromeProvider>
                  <RootShell />
                </BottomChromeProvider>
              </BottomSheetModalProvider>
              <ToastHost />
              {/*
                The fingerprint lock: last, so nothing — no sheet, no toast —
                draws above it. Only the boot splash cover sits higher, which is
                what makes it "splash, then fingerprint".
              */}
              <AppLockHost />
            </KeyboardProvider>
          </SafeAreaProvider>
        </PersistGate>
      </Provider>
      <BootSplashCover />
    </GestureHandlerRootView>
  );
}
