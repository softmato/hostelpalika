package com.softmato.hostelhub.appupdate

import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Google Play's in-app updates: Play answers whether a newer store build is
 * out, and runs the update in its own full-screen flow, so the "Update now"
 * button updates the app without sending anyone to the store listing.
 *
 * Only an install that came from Play gets an answer — a sideloaded APK always
 * hears "no update", which is the right answer for a test build.
 */
class HostelPalikaAppUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HostelHubAppUpdate")

    /** `{ versionCode }` of the newer build, or `null`. Never rejects. */
    AsyncFunction("check") { promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.resolve(null)

      AppUpdateManagerFactory.create(context).appUpdateInfo
        .addOnSuccessListener { info ->
          promise.resolve(
            if (canUpdate(info)) mapOf("versionCode" to info.availableVersionCode()) else null,
          )
        }
        .addOnFailureListener { promise.resolve(null) }
    }

    /**
     * Starts Play's immediate update. Resolves whether Play's screen was shown
     * — accepted or backed out of — and `false` only when it could not be
     * started, which is the caller's cue to open the store listing instead.
     * On accept Play installs and restarts the app.
     */
    AsyncFunction("start") { promise: Promise ->
      val activity = appContext.currentActivity ?: return@AsyncFunction promise.resolve(false)
      val manager = AppUpdateManagerFactory.create(activity)

      manager.appUpdateInfo
        .addOnSuccessListener { info ->
          if (!canUpdate(info)) {
            promise.resolve(false)
            return@addOnSuccessListener
          }

          manager.startUpdateFlow(info, activity, AppUpdateOptions.defaultOptions(AppUpdateType.IMMEDIATE))
            .addOnSuccessListener { promise.resolve(true) }
            .addOnFailureListener { promise.resolve(false) }
        }
        .addOnFailureListener { promise.resolve(false) }
    }
  }

  /** A newer build, or one whose update was started and left half-done. */
  private fun canUpdate(info: AppUpdateInfo) =
    (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE ||
      info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) &&
      info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)
}
