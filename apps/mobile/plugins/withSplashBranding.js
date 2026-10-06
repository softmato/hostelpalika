/* global __dirname */
const fs = require("fs");
const path = require("path");
const { withDangerousMod, withMainActivity } = require("expo/config-plugins");
const { addImports } = require("@expo/config-plugins/build/android/codeMod");
const { mergeContents } = require("@expo/config-plugins/build/utils/generateCode");

/**
 * The Android launch screen: our own native splash, not the system's.
 *
 * The system splash looked different from phone to phone. Android 11 and below
 * have no branding slot, some OEM skins skip `windowSplashScreenBrandingImage`,
 * and where it does draw, Android forces the image into a 200x80dp box — so
 * "Powered by Softmato" was missing on one phone and oversized on the next.
 * The background and the centred logo are the only things every phone draws
 * identically, so the system splash (the `expo-splash-screen` block in app.json)
 * now carries only those.
 *
 * Everything else is `modules/hostelhub-boot-splash`: MainActivity puts that
 * view up on its first frame — the same logo in the same place, then the strip
 * rising in and a shine across the logo — and releases the system splash at
 * once instead of holding it until JS boots. JS hides the view when it is up
 * (`src/components/brand-splash.tsx`).
 *
 * This plugin
 *   1. copies the strip into the app's drawables (one PNG per density, cut for
 *      136x55dp) so MainActivity can hand it over by `R.drawable`, and
 *   2. adds the two calls to MainActivity.onCreate.
 */

const DRAWABLE_NAME = "splashscreen_branding";
const SOURCE_RES_DIR = path.join(__dirname, "splash-branding-res");

const BOOT_SPLASH = "com.softmato.hostelhub.bootsplash.BootSplash";
const SPLASH_MANAGER = "expo.modules.splashscreen.SplashScreenManager";

function withStripDrawables(config) {
  return withDangerousMod(config, [
    "android",
    (mod) => {
      const resDir = path.join(mod.modRequest.platformProjectRoot, "app", "src", "main", "res");

      for (const bucket of fs.readdirSync(SOURCE_RES_DIR)) {
        const source = path.join(SOURCE_RES_DIR, bucket, `${DRAWABLE_NAME}.png`);
        if (!fs.existsSync(source)) continue;

        const targetDir = path.join(resDir, bucket);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(source, path.join(targetDir, `${DRAWABLE_NAME}.png`));
      }

      // This plugin used to write a values-v31 theme putting the strip on the
      // system splash. A non-clean prebuild leaves it behind; it must not survive.
      const staleTheme = path.join(resDir, "values-v31", "styles.xml");
      if (fs.existsSync(staleTheme) && fs.readFileSync(staleTheme, "utf8").includes("withSplashBranding")) {
        fs.rmSync(staleTheme);
      }

      return mod;
    },
  ]);
}

function withBootSplash(config) {
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== "kt") {
      throw new Error("withSplashBranding: expected a Kotlin MainActivity");
    }

    const src = addImports(mod.modResults.contents, [BOOT_SPLASH, SPLASH_MANAGER], false);

    mod.modResults.contents = mergeContents({
      anchor: /super\.onCreate\(/,
      comment: "    //",
      newSrc: [
        `    BootSplash.show(this, R.color.splashscreen_background, R.drawable.splashscreen_logo, R.drawable.${DRAWABLE_NAME})`,
        "    // Our splash is the first frame now; the system one can go.",
        "    SplashScreenManager.hide()",
      ].join("\n"),
      offset: 1,
      src,
      tag: "hostelpalika-boot-splash",
    }).contents;

    return mod;
  });
}

module.exports = function withSplashBranding(config) {
  return withBootSplash(withStripDrawables(config));
};
