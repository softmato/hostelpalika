// Runs on `npm install` / `npm ci` (postinstall), locally and on EAS.
//
// Two native bugs found in the 2026-10-29 field log, both fixed upstream or
// trivially fixable but not in the versions Expo 57 pins:
//
// 1. Reanimated 4.5.1 on RN 0.86 writes animated props through reflection and,
//    when the view is gone, logs a ~140-line stack trace on the UI thread — per
//    view, per event. Thousands per minute = the "app feels heavy" jank.
//    Backport of 4.7.1: skip views that no longer exist, log one line.
// 2. MapLibre RN 11.4.1 `MLRNOfflineModule.invalidate()` frees the JS emitter
//    while a queued offline-pack progress event still runs → SIGSEGV. Drop
//    events once the module is invalidated.
//
// 3. react-native-screens toggles a hardware layer around each transition,
//    and the AppBar blinks out on both toggles (see below).
//
// Each patch is idempotent and throws if its anchor moved, so a library bump
// fails the install instead of silently shipping the bug again.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
const MARK = "patched by scripts/patch-native-deps.mjs";

const patches = [
  {
    file: "react-native-reanimated/android/src/main/java/com/swmansion/reanimated/NativeProxy.kt",
    edits: [
      [
        "    @DoNotStrip\n    fun synchronouslyUpdateUIProps(",
        `    // ${MARK}\n    private val getViewExistsMethod by lazy {\n        runCatching { mountingManager.javaClass.getMethod("getViewExists", Int::class.javaPrimitiveType) }.getOrNull()\n    }\n\n    @DoNotStrip\n    fun synchronouslyUpdateUIProps(`,
      ],
      [
        "                try {\n                    updatePropsSynchronouslyMethod.invoke(mountingManager, viewTag, props)\n                } catch (e: Exception) {\n                    Log.w(\"Reanimated\", \"synchronouslyUpdateUIProps failed for tag $viewTag\", e)\n                }",
        "                try {\n                    if (getViewExistsMethod?.invoke(mountingManager, viewTag) == false) {\n                        return@parse\n                    }\n                    updatePropsSynchronouslyMethod.invoke(mountingManager, viewTag, props)\n                } catch (e: Exception) {\n                    Log.w(\"Reanimated\", \"synchronouslyUpdateUIProps failed for tag $viewTag: ${e.cause ?: e}\")\n                }",
      ],
    ],
  },
  {
    file: "@maplibre/maplibre-react-native/android/src/main/java/org/maplibre/reactnative/modules/MLRNOfflineModule.kt",
    edits: [
      [
        "    private val regions = HashMap<String, OfflineRegion>()\n",
        `    private val regions = HashMap<String, OfflineRegion>()\n\n    // ${MARK}\n    @Volatile private var invalidated = false\n`,
      ],
      [
        "                override fun onStatusChanged(status: OfflineRegionStatus) {\n",
        "                override fun onStatusChanged(status: OfflineRegionStatus) {\n                    if (invalidated) return\n",
      ],
      [
        "                override fun onError(error: OfflineRegionError) {\n",
        "                override fun onError(error: OfflineRegionError) {\n                    if (invalidated) return\n",
      ],
      [
        "                override fun mapboxTileCountLimitExceeded(limit: Long) {\n",
        "                override fun mapboxTileCountLimitExceeded(limit: Long) {\n                    if (invalidated) return\n",
      ],
      [
        "    override fun invalidate() {\n",
        "    override fun invalidate() {\n        invalidated = true\n",
      ],
    ],
  },
  {
    // 3. A screen becomes a hardware layer for its transition and drops it at
    //    the end; on the user's Mali phone the AppBar vanished for exactly those
    //    two frames (field video 2026-10-29). Keep every screen a plain view.
    file: "react-native-screens/android/src/main/java/com/swmansion/rnscreens/Screen.kt",
    edits: [
      [
        "            if (transitioning && !isWebViewInScreen) LAYER_TYPE_HARDWARE else LAYER_TYPE_NONE,\n",
        `            // ${MARK}\n            LAYER_TYPE_NONE,\n`,
      ],
    ],
  },
];

for (const { file, edits } of patches) {
  const path = join(root, file);
  let text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (text.includes(MARK)) continue;

  for (const [from, to] of edits) {
    if (text.split(from).length !== 2) {
      throw new Error(`patch-native-deps: anchor not found exactly once in ${file}:\n${from}`);
    }
    text = text.replace(from, () => to);
  }
  writeFileSync(path, text);
  console.log(`patch-native-deps: patched ${file}`);
}
