/**
 * Entry point of the installable web app: the phone app, exported for the
 * browser by `scripts/export-pwa.mjs` and served by the website at `/app`.
 *
 * `metro.config.js` puts this in front of `expo-router/entry` in the web bundle
 * only. Everything in `web/` is a stand-in for something the phone has natively
 * and the browser does not; nothing under `src/` knows the web build exists.
 *
 * The file system goes first: it records the size of every `blob:` URL as it is
 * minted, and a picker must not mint one before it is listening.
 *
 * `./nativewind` goes before any screen: it lets Reanimated's `Animated.View`
 * read `className` in the browser, which the tab bar (`absolute bottom-0
 * flex-row`) and four other views are laid out by.
 */
import "./file-system";
import "./alert";
import "./nativewind";
import "./push-open";
import "./focus-ring";

import "expo-router/entry";
