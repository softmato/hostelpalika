package com.softmato.receipts

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.Gravity
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** No React runtime, app navigation, splash, overlay permission or main-task launch. */
class ReceiptSheetActivity : Activity() {
  private lateinit var web: WebView
  private val worker = Executors.newSingleThreadExecutor()
  private var receipt: File? = null
  private var name = "receipt"
  private var mime = ""
  private var uploaded: String? = null
  private var requestId = UUID.randomUUID().toString()
  @Volatile private var closed = false
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    requestId = state?.getString("requestId") ?: requestId
    window.setGravity(Gravity.BOTTOM)
    window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
    window.setDimAmount(0.25f)
    web = WebView(this).apply {
      setBackgroundColor(Color.TRANSPARENT)
      settings.javaScriptEnabled = true
      settings.allowFileAccess = false; settings.allowContentAccess = false
      settings.blockNetworkLoads = true
      addJavascriptInterface(Bridge(), "ReceiptBridge")
      webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
      }
    }
    setContentView(web)
    window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, (resources.displayMetrics.heightPixels * .88).toInt())
    web.loadDataWithBaseURL("https://receipt.invalid/", assets.open("receipt-sheet.html").bufferedReader().use { it.readText() }, "text/html", "UTF-8", null)
  }
  @Suppress("DEPRECATION")
  private fun prepare() {
    if (receipt != null) return
    require(intent.action == Intent.ACTION_SEND) { "Share one payment screenshot or PDF." }
    val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
    val clips = intent.clipData
    require(clips == null || clips.itemCount <= 1) { "Share one receipt at a time." }
    val uri = stream ?: clips?.getItemAt(0)?.uri ?: error("The shared file was not attached. Share it again.")
    require(uri.scheme in listOf("content", "file"))
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) name = it.getString(0) ?: name
    }
    name = name.substringAfterLast('/').substringAfterLast('\\').take(180)
    mime = (contentResolver.getType(uri) ?: intent.type ?: "").substringBefore(';').lowercase()
    if (mime in listOf("", "application/octet-stream", "binary/octet-stream", "*/*", "application/x-pdf")) {
      mime = when (name.substringAfterLast('.').lowercase()) { "pdf" -> "application/pdf"; "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "webp" -> "image/webp"; "heic" -> "image/heic"; "heif" -> "image/heif"; else -> "" }
    }
    require(mime == "application/pdf" || mime.startsWith("image/")) { "Choose a payment screenshot or PDF." }
    // The receiving activity holds the temporary URI grant. Copy before closing it.
    val file = File.createTempFile("receipt-", ".tmp", cacheDir)
    try {
      val input = contentResolver.openInputStream(uri) ?: error("Could not open the shared file.")
      input.use { source -> file.outputStream().use { out ->
        val buffer = ByteArray(16384); var total = 0
        while (true) { val n = source.read(buffer); if (n < 0) break; total += n
          check(total <= 20 * 1024 * 1024) { "Choose a receipt under 20 MB." }; check(!closed)
          out.write(buffer, 0, n)
        }
      } }
      require(file.length() > 0) { "The shared receipt is empty." }
      val digest = java.security.MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input -> val bytes = ByteArray(16384); while (true) { val n = input.read(bytes); if (n < 0) break; digest.update(bytes, 0, n) } }
      requestId = "receipt-" + digest.digest().joinToString("") { "%02x".format(it) }.take(56)
      receipt = file
    } catch (e: Exception) { file.delete(); throw e }
  }
  inner class Bridge {
    @JavascriptInterface fun postMessage(raw: String) {
      if (closed) return
      val message = try { JSONObject(raw) } catch (_: Exception) { return }
      if (message.optString("action") == "close") { closed = true; runOnUiThread { finish() }; return }
      worker.execute {
        if (closed) return@execute
        val reply = JSONObject().put("id", message.optInt("id"))
        try {
          val value: Any = when (message.getString("action")) {
            "init" -> { prepare(); JSONObject().put("fileName", name).put("requestId", requestId) }
            "hostel" -> ReceiptCore.prefs(this@ReceiptSheetActivity).getString("hostel", "") ?: ""
            "upload" -> { prepare(); uploaded ?: ReceiptCore.upload(this@ReceiptSheetActivity, receipt!!, name, mime).also { uploaded = it } }
            "api" -> { check(!closed); ReceiptCore.api(this@ReceiptSheetActivity, message.getString("path"), message.optString("method", "GET"), message.optJSONObject("body")) }
            "preference" -> { val key = message.getString("key"); require(key.startsWith("hostelpalika.receipt-auto:"))
              val prefs = ReceiptCore.prefs(this@ReceiptSheetActivity)
              if (message.has("enabled")) prefs.edit().putBoolean(key, message.getBoolean("enabled")).commit()
              prefs.getBoolean(key, false)
            }
            else -> error("Unsupported receipt action")
          }
          reply.put("value", value)
        } catch (e: Exception) { reply.put("error", e.message ?: "Could not finish. Try again.") }
        runOnUiThread { if (!closed) web.evaluateJavascript("window.receiptReply($reply)", null) }
      }
    }
  }
  override fun onSaveInstanceState(out: Bundle) { out.putString("requestId", requestId); super.onSaveInstanceState(out) }
  override fun onDestroy() {
    closed = true
    worker.execute { receipt?.delete() }; worker.shutdown()
    web.removeJavascriptInterface("ReceiptBridge"); web.destroy()
    super.onDestroy()
  }
}
