package com.softmato.hostelhub.applock

import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The native half of the fingerprint lock (apps/mobile `lib/app-lock.ts`).
 *
 * ## Recents
 *
 * Keeps the portal out of the Recents thumbnail while the lock is on. Not
 * `FLAG_SECURE`: that would also block screenshots, and residents screenshot
 * their receipts. Android 13+ only; older phones keep the snapshot.
 *
 * ## The return guard
 *
 * JS cannot decide a return in time: the first frame after `onResume` is drawn
 * from the view tree as it stood, before the `active` event reaches JS. So the
 * lock used to go up the moment the app left — and a quick trip to Recents came
 * back to the keypad fading off the portal.
 *
 * This decides it here instead, synchronously in `onResume`, before that first
 * frame: away past the grace, and an opaque cover in the lock's own background
 * goes over the window and `onLockDue` tells JS to lock under it (JS lifts the
 * cover once the lock has painted); inside the grace, nothing is drawn at all.
 * Only while `armed` — the lock is on and currently open.
 */
class HostelPalikaAppLockModule : Module() {
  private var armed = false
  private var graceMs = 30_000L
  private var coverColor = Color.WHITE
  private var pausedAt: Long? = null
  private var cover: View? = null

  override fun definition() = ModuleDefinition {
    Name("HostelHubAppLock")

    Events("onLockDue")

    AsyncFunction("setRecentsHidden") { hidden: Boolean ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        appContext.currentActivity?.setRecentsScreenshotEnabled(!hidden)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setGuard") { on: Boolean, grace: Double, color: Int ->
      armed = on
      graceMs = grace.toLong()
      coverColor = color
      cover?.setBackgroundColor(color)
      if (!on) pausedAt = null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("removeCover") {
      cover?.let { (it.parent as? ViewGroup)?.removeView(it) }
      cover = null
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersBackground {
      if (armed && pausedAt == null) pausedAt = SystemClock.elapsedRealtime()
    }

    OnActivityEntersForeground {
      val leftAt = pausedAt ?: return@OnActivityEntersForeground
      pausedAt = null
      if (!armed || SystemClock.elapsedRealtime() - leftAt < graceMs) return@OnActivityEntersForeground
      showCover()
      sendEvent("onLockDue")
    }
  }

  private fun showCover() {
    if (cover != null) return
    val activity = appContext.currentActivity ?: return
    val root = activity.window?.decorView as? ViewGroup ?: return
    cover = View(activity).apply {
      setBackgroundColor(coverColor)
      // Swallows the taps meant for the portal underneath.
      isClickable = true
      isFocusable = true
    }
    root.addView(
      cover,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }
}
