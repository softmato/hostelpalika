const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

/*
 * Redirect `@react-native-community/netinfo` to a JS-only shim.
 *
 * `pusher-js/react-native` imports it at module load — see `src/shims/netinfo.js`
 * for what it reads and why the shim answers the way it does. Installing netinfo
 * for real would take the whole app out of Expo Go, which is a heavy price for a
 * reachability hint Pusher's own reconnect logic does not need.
 *
 * Same approach the reference app (`D:\Jiwan-Mijhar\app`) settled on. Delete this
 * block if netinfo is ever installed for real.
 */
const netinfoShim = path.resolve(__dirname, "src/shims/netinfo.js");

/*
 * The installable web app (PWA) — this app exported for the browser by
 * `scripts/export-pwa.mjs`. Where the phone leans on something a browser does
 * not have, the web bundle, and only the web bundle, gets a stand-in from
 * `web/`: requests from `src/` for these modules are redirected, and nothing in
 * `src/` changes. The phone bundle never takes this branch.
 */
const webRoot = path.resolve(__dirname, "web");
const srcRoot = path.resolve(__dirname, "src");
const WEB_STAND_INS = {
  "@/lib/session": "session.ts",
  "@/lib/session-refresh-lock": "session-refresh-lock.ts",
  "@/lib/receive-payment-share": "receive-payment-share.ts",
  "@/components/qr-camera": "qr-camera.tsx",
  "@/lib/documents": "documents.ts",
  "@/lib/google-auth": "google-auth.ts",
  "@/lib/push-notifications": "push-notifications.ts",
  "@/lib/questioncall": "questioncall.ts",
  "@/lib/unload-guard": "unload-guard.ts",
  "expo-file-system": "file-system.ts",
  "expo-secure-store": "secure-store.ts",
  "react-native-webview": "webview.tsx",
};

/*
 * `@hostel/calendar/*` — the platform's date rules, compiled into the app from
 * the same file the server imports.
 *
 * The app is deliberately outside the npm workspace (Expo keeps its own
 * `node_modules`), so `@hostel/shared` does not resolve here and hoisting it
 * would drag the package's root entry point — which pulls in the mail sender and
 * its Node dependencies — into a phone bundle. This alias points at one
 * directory instead: `packages/shared/src/calendar`, whose only import is
 * `nepali-date-converter`, and which the app already depends on.
 *
 * The point of the alias is that there is no second copy. A month boundary the
 * server bills on and a month boundary the app draws have to be the same
 * boundary, and the way that stops being true is somebody maintaining two
 * implementations of it — which is exactly what produced a Bhadra label over
 * September's arithmetic.
 */
const calendarRoot = path.resolve(__dirname, "../../packages/shared/src/calendar");

/*
 * `@hostel/plans/*` — the same trick, for the plans-and-pricing arithmetic.
 *
 * A price the Pricing screen quotes and a price `/plans-pricing` quotes are the
 * same price, computed from one monthly figure and one discount percentage. Two
 * implementations of that is two prices, so there is one file and both ends
 * import it. Unlike the calendar it pulls in nothing at all — see the note at
 * the top of `packages/shared/src/plans/catalog.ts` — so it needs no
 * `extraNodeModules` entry.
 */
const plansRoot = path.resolve(__dirname, "../../packages/shared/src/plans");

/*
 * `@hostel/food/*` — the meal-window rule, on the same terms.
 *
 * `meal-window.ts` decides when a cook's announce button unlocks, and the
 * server refuses an early announcement using the identical call. A second copy
 * of that arithmetic in the app is a button that lights up over an API that
 * says no, so there is one file and both ends import it. No dependencies at
 * all, so like the plans catalogue it needs no `extraNodeModules` entry.
 */
const foodRoot = path.resolve(__dirname, "../../packages/shared/src/food");

/*
 * `@hostel/night/*` — when a night starts, and when the hostel asks about it.
 *
 * The 17:00 boundary used to be a private constant in `lib/night-status.ts`,
 * whose own comment noted it had "no server counterpart". Once a cron asks who
 * has not answered tonight and a warden board renders the answer, a boundary
 * with no server counterpart is two boundaries — so it moved to the shared
 * package and both ends import it. `night-window.ts` imports `../food/`, which
 * is already a watch folder, and nothing else.
 */
const nightRoot = path.resolve(__dirname, "../../packages/shared/src/night");
/** `@hostel/brand/*` — the platform name, shared with the web and the emails. */
const brandRoot = path.resolve(__dirname, "../../packages/shared/src/brand");
/**
 * `@hostel/expenses/*` — the spending categories and payment methods. The add
 * screen's tiles and the API's accepted values are one list, so a tile can never
 * offer a category the server refuses. No imports at all.
 */
const expensesRoot = path.resolve(__dirname, "../../packages/shared/src/expenses");
const baseResolveRequest = config.resolver.resolveRequest;

// `.lottie` is a zip Metro doesn't know; without this `require()` of one fails to resolve.
config.resolver.assetExts = [...config.resolver.assetExts, "lottie"];

config.watchFolders = [
  ...(config.watchFolders ?? []),
  calendarRoot,
  plansRoot,
  foodRoot,
  nightRoot,
  brandRoot,
  expensesRoot,
];

/*
 * And the one package that file imports, resolved from *this* app's tree.
 *
 * Metro resolves a bare specifier by walking up from the importing file, so
 * `bs.ts` looks in `packages/shared/node_modules` and then the repo root — and
 * the repo root is not a watch folder, so Metro will not read it however
 * installed the package is there. Adding the root to `watchFolders` would fix
 * the resolution by making Metro crawl every dependency of the web app and the
 * server on each start, which is a heavy price for one small library.
 *
 * `nepali-date-converter` is already a declared dependency of this app, so the
 * copy to bundle is the one beside it. `extraNodeModules` is Metro's documented
 * fallback for exactly this shape of monorepo import.
 */
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "nepali-date-converter": path.resolve(__dirname, "node_modules/nepali-date-converter"),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web") {
    const origin = context.originModulePath;

    // `index.js` → `web/entry.ts`, which loads the stand-ins and then the router.
    if (moduleName === "expo-router/entry" && !origin.startsWith(webRoot)) {
      return { filePath: path.join(webRoot, "entry.ts"), type: "sourceFile" };
    }

    if (WEB_STAND_INS[moduleName] && (origin.startsWith(srcRoot) || (moduleName === "@/lib/session" && origin.startsWith(webRoot)))) {
      return { filePath: path.join(webRoot, WEB_STAND_INS[moduleName]), type: "sourceFile" };
    }
  }

  if (moduleName === "@react-native-community/netinfo") {
    return { filePath: netinfoShim, type: "sourceFile" };
  }

  if (moduleName.startsWith("@hostel/plans/")) {
    return {
      filePath: path.join(plansRoot, `${moduleName.slice("@hostel/plans/".length)}.ts`),
      type: "sourceFile",
    };
  }

  if (moduleName.startsWith("@hostel/food/")) {
    return {
      filePath: path.join(foodRoot, `${moduleName.slice("@hostel/food/".length)}.ts`),
      type: "sourceFile",
    };
  }

  if (moduleName.startsWith("@hostel/brand/")) {
    return {
      filePath: path.join(brandRoot, `${moduleName.slice("@hostel/brand/".length)}.ts`),
      type: "sourceFile",
    };
  }

  if (moduleName.startsWith("@hostel/expenses/")) {
    return {
      filePath: path.join(expensesRoot, `${moduleName.slice("@hostel/expenses/".length)}.ts`),
      type: "sourceFile",
    };
  }

  if (moduleName.startsWith("@hostel/night/")) {
    return {
      filePath: path.join(nightRoot, `${moduleName.slice("@hostel/night/".length)}.ts`),
      type: "sourceFile",
    };
  }

  if (moduleName.startsWith("@hostel/calendar/")) {
    return {
      filePath: path.join(calendarRoot, `${moduleName.slice("@hostel/calendar/".length)}.ts`),
      type: "sourceFile",
    };
  }

  return typeof baseResolveRequest === "function"
    ? baseResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./src/global.css" });
