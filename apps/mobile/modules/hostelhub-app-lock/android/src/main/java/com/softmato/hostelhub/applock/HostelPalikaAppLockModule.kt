package com.softmato.hostelhub.applock

import android.os.Build
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Keeps the portal out of the Recents thumbnail while the fingerprint lock is
 * on (apps/mobile `lib/app-lock.ts`). The lock draws itself when the app
 * leaves, but Android takes the Recents snapshot first.
 *
 * Not `FLAG_SECURE`: that would also block screenshots, and residents
 * screenshot their receipts. Android 13+ only; older phones keep the snapshot.
 */
class HostelPalikaAppLockModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HostelHubAppLock")

    AsyncFunction("setRecentsHidden") { hidden: Boolean ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        appContext.currentActivity?.setRecentsScreenshotEnabled(!hidden)
      }
    }.runOnQueue(Queues.MAIN)
  }
}
