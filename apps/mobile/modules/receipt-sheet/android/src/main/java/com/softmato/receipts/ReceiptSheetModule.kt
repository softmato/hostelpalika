package com.softmato.receipts

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class ReceiptSheetModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  override fun definition() = ModuleDefinition {
    Name("ReceiptSheet")
    AsyncFunction("readSession") { ReceiptCore.read(context)?.let { mapOf("accessToken" to it.getString("accessToken"), "refreshToken" to it.getString("refreshToken")) } }
    AsyncFunction("writeSession") { tokens: Map<String, String>? -> ReceiptCore.write(context, tokens?.let { JSONObject(it) }); Unit }
    AsyncFunction("refreshSession") { base: String -> ReceiptCore.refresh(context, base) }
    AsyncFunction("configure") { base: String, hostel: String? -> ReceiptCore.configure(context, base, hostel) }
    AsyncFunction("getAutoSave") { key: String -> ReceiptCore.prefs(context).getBoolean(key, false) }
    AsyncFunction("setAutoSave") { key: String, enabled: Boolean -> ReceiptCore.prefs(context).edit().putBoolean(key, enabled).commit(); Unit }
  }
}
