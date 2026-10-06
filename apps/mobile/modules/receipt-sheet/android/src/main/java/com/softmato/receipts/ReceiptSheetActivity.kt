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
    if (state == null && intent.action == Intent.ACTION_SEND) {
      window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      if (ReceiptCore.prefs(this).getString("role", null) == "RESIDENT") return openApp()
      if (ReceiptCore.autoSaveOn(this)) return saveInBackground()
    }
    showSheet()
  }
  /**
   * Residents claim against an invoice, which lives in the app: hand it this share.
   * expo-sharing turns a SEND at MainActivity into /share-payment (invoice → claim → the
   * usual checks). The read grant is passed on before this activity, which holds it, goes.
   */
  @Suppress("DEPRECATION")
  private fun openApp() {
    closed = true
    ReceiptCore.prefs(this).edit().putString("role", "RESIDENT").apply()
    packageManager.getLaunchIntentForPackage(packageName)?.component?.let { main ->
      startActivity(Intent(intent).setComponent(main).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }
    finish(); overridePendingTransition(0, 0)
  }
  /** "Don't ask next time": copy while the share grant lives, hand off to [ReceiptSaveService], get out of the way. */
  @Suppress("DEPRECATION")
  private fun saveInBackground() = worker.execute {
    try {
      prepare()
      val kept = File(ReceiptCore.pending(this), requestId)
      check(receipt!!.renameTo(kept))
      receipt = null
      startService(Intent(this, ReceiptSaveService::class.java).putExtra("receiptPath", kept.path)
        .putExtra("name", name).putExtra("mime", mime).putExtra("requestId", requestId))
      runOnUiThread { finish(); overridePendingTransition(0, 0) }
    } catch (_: Exception) {
      // The sheet runs the same steps again and shows what went wrong.
      runOnUiThread { if (!isFinishing) showSheet() }
    }
  }
  private fun showSheet() {
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
    window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, (resources.displayMetrics.heightPixels * .5).toInt())
    web.loadDataWithBaseURL("https://receipt.invalid/", assets.open("receipt-sheet.html").bufferedReader().use { it.readText() }, "text/html", "UTF-8", null)
  }
  @Suppress("DEPRECATION")
  private fun prepare() {
    if (receipt != null) return
    intent.getStringExtra("receiptPath")?.let { return resume(File(it)) }
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
    if (mime == "application/x-pdf") mime = "application/pdf"
    if (mime in listOf("", "application/octet-stream", "binary/octet-stream", "*/*")) {
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
  /** Opened from a "tap to finish" notice: the copy [ReceiptSaveService] kept. This activity is exported, so only that folder is accepted. */
  private fun resume(file: File) {
    require(file.isFile && file.canonicalFile.parentFile == ReceiptCore.pending(this).canonicalFile) { "This receipt is no longer on the phone. Share it again." }
    name = intent.getStringExtra("name") ?: name
    mime = intent.getStringExtra("mime") ?: ""
    require(mime == "application/pdf" || mime.startsWith("image/")) { "Choose a payment screenshot or PDF." }
    requestId = intent.getStringExtra("requestId") ?: requestId
    uploaded = intent.getStringExtra("assetId")
    receipt = file
  }
  inner class Bridge {
    @JavascriptInterface fun postMessage(raw: String) {
      if (closed) return
      val message = try { JSONObject(raw) } catch (_: Exception) { return }
      if (message.optString("action") == "close") { closed = true; runOnUiThread { finish() }; return }
      if (message.optString("action") == "handoff") { runOnUiThread { if (!isFinishing) openApp() }; return }
      if (message.optString("action") == "size") {
        // Fit the sheet to the page (CSS px → device px), never above 90% of the screen.
        val metrics = resources.displayMetrics
        val height = (message.optDouble("height", 0.0) * metrics.density).toInt().coerceIn(metrics.heightPixels / 4, (metrics.heightPixels * .9).toInt())
        runOnUiThread { if (!closed) window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, height) }
        return
      }
      worker.execute {
        if (closed) return@execute
        val reply = JSONObject().put("id", message.optInt("id"))
        try {
          val value: Any = when (message.getString("action")) {
            "init" -> { prepare(); JSONObject().put("fileName", name).put("requestId", requestId) }
            "hostel" -> ReceiptCore.prefs(this@ReceiptSheetActivity).getString("hostel", "") ?: ""
            "upload" -> { prepare(); uploaded ?: ReceiptCore.upload(this@ReceiptSheetActivity, receipt!!, name, mime).also { uploaded = it } }
            "api" -> { check(!closed)
              val path = message.getString("path"); val method = message.optString("method", "GET"); val body = message.optJSONObject("body")
              // A push would land while this sheet is in front, where Expo drops it; the notice is drawn here instead.
              val saving = path == "/hostel-admin/expenses" && method == "POST"
              if (saving) body?.put("notifiedOnDevice", true)
              ReceiptCore.api(this@ReceiptSheetActivity, path, method, body).also { if (saving && it is JSONObject) ReceiptNotices.saved(this@ReceiptSheetActivity, requestId, it) }
            }
            "preference" -> { val key = message.getString("key"); require(key.startsWith("hostelpalika.receipt-auto:"))
              // The sheet just worked this key out for the signed-in account + hostel, so the next share can skip the sheet.
              val prefs = ReceiptCore.prefs(this@ReceiptSheetActivity).also { it.edit().putString("autoKey", key).commit() }
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
    if (::web.isInitialized) { web.removeJavascriptInterface("ReceiptBridge"); web.destroy() }
    super.onDestroy()
  }
}
