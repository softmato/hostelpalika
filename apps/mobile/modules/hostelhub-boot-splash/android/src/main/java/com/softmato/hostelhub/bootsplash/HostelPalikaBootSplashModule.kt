package com.softmato.hostelhub.bootsplash

import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS side of [BootSplash] — `src/components/brand-splash.tsx`. */
class HostelPalikaBootSplashModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HostelHubBootSplash")

    // Resolves when the splash has finished fading — the fingerprint lock waits for it.
    AsyncFunction("hide") { promise: Promise ->
      BootSplash.hide { promise.resolve(null) }
    }.runOnQueue(Queues.MAIN)
  }
}
