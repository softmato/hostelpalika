package com.softmato.receipts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.io.File
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * "Don't ask next time" without a sheet over the banking app. The share activity
 * starts this while it is still in front (so Android allows it) and leaves; this
 * uploads, reads and saves the receipt and says how it went in a notification.
 * A plain started service has minutes in the background and a receipt takes
 * seconds, so no foreground-service type has to be declared to Play. Anything
 * it cannot finish waits behind a "tap to finish" notice that reopens the sheet.
 */
class ReceiptSaveService : Service() {
  private val worker = Executors.newSingleThreadExecutor()
  private val running = ConcurrentHashMap<String, Intent>()
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val job = intent?.takeIf { it.hasExtra("receiptPath") && it.hasExtra("requestId") }
    if (job == null) { stopSelf(startId); return START_NOT_STICKY }
    val id = job.getStringExtra("requestId")!!
    running[id] = job
    ReceiptNotices.post(this, id, "Reading receipt…", job.getStringExtra("name") ?: "", null, progress = true)
    worker.execute { try { save(job, id) } finally { running.remove(id); stopSelf(startId) } }
    return START_NOT_STICKY
  }
  private fun save(job: Intent, id: String) {
    val file = File(job.getStringExtra("receiptPath")!!)
    try {
      val assetId = job.getStringExtra("assetId")
        ?: ReceiptCore.upload(this, file, job.getStringExtra("name") ?: "receipt", job.getStringExtra("mime") ?: "").also { job.putExtra("assetId", it) }
      val read = ReceiptCore.api(this, "/hostel-admin/expenses/receipt/read", "POST", JSONObject().put("assetId", assetId)) as JSONObject
      val saved = read.optJSONObject("alreadySaved")
      if (saved != null) {
        file.delete()
        val by = saved.optString("by").let { if (it.isBlank()) "" else "added by $it" }
        val where = saved.optString("where").takeIf { it.isNotBlank() && it != "null" }?.let { " in $it" } ?: ""
        ReceiptNotices.post(this, id, "Already added", ReceiptNotices.line(saved.optInt("amount"), by + where), ReceiptNotices.expenses(this))
        return
      }
      val fields = read.getJSONObject("fields")
      val amount = fields.optInt("amount")
      if (!read.optBoolean("autoSaveEligible") || amount <= 0) return review(job, id, "Check this receipt", "Tap to review and save.")
      val method = fields.optString("method").takeIf { it == "ESEWA" || it == "KHALTI" } ?: "BANK"
      val expense = ReceiptCore.api(this, "/hostel-admin/expenses", "POST", JSONObject().put("amount", amount).put("category", "OTHER")
        .put("paidBy", method).put("what", read.optString("description").ifBlank { "Shared payment receipt" })
        .put("photoAssetId", assetId).put("clientRequestId", id).put("sharedReceipt", true).put("notifiedOnDevice", true)) as JSONObject
      file.delete()
      ReceiptNotices.saved(this, id, expense)
    } catch (e: Exception) { review(job, id, "Receipt not saved", e.message ?: "Tap to try again.") }
  }
  private fun review(job: Intent, id: String, title: String, text: String) =
    ReceiptNotices.post(this, id, title, text, Intent(this, ReceiptSheetActivity::class.java).putExtras(job).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  override fun onDestroy() {
    // Stopped by Android mid-job: leave the receipt one tap away. A job that still finishes replaces this notice.
    running.forEach { (id, job) -> review(job, id, "Receipt not saved", "Tap to finish.") }
    worker.shutdown()
    super.onDestroy()
  }
}

/** One notice per receipt (keyed by its request id), replaced in place as it moves along. */
object ReceiptNotices {
  private const val RESULTS = "shared-receipts"
  private const val PROGRESS = "shared-receipts-progress"
  private fun manager(c: Context) = c.getSystemService(NotificationManager::class.java)
  fun line(amount: Int, detail: String) =
    "Rs. " + NumberFormat.getIntegerInstance(Locale("en", "IN")).format(amount) + if (detail.isBlank()) "" else " · $detail"
  fun expenses(c: Context): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse("hostelpalika://expenses")).setPackage(c.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  fun saved(c: Context, requestId: String, expense: JSONObject) =
    post(c, requestId, "Receipt saved", line(expense.optInt("amount"), expense.optString("what")), expenses(c))
  @Suppress("DEPRECATION")
  fun post(c: Context, requestId: String, title: String, text: String, tap: Intent?, progress: Boolean = false) {
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      manager(c).createNotificationChannels(listOf(
        NotificationChannel(RESULTS, "Shared receipts", NotificationManager.IMPORTANCE_DEFAULT),
        NotificationChannel(PROGRESS, "Reading shared receipts", NotificationManager.IMPORTANCE_LOW)))
      // A process killed mid-read must not leave "Reading…" behind for ever.
      Notification.Builder(c, if (progress) PROGRESS else RESULTS).apply { if (progress) setTimeoutAfter(120_000) }
    } else Notification.Builder(c)
    val icon = c.resources.getIdentifier("notification_icon", "drawable", c.packageName).takeIf { it != 0 } ?: c.applicationInfo.icon
    builder.setSmallIcon(icon).setColor(0xFF0A8A4B.toInt()).setContentTitle(title).setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text)).setAutoCancel(true)
    if (progress) builder.setProgress(0, 0, true)
    if (tap != null) builder.setContentIntent(PendingIntent.getActivity(c, requestId.hashCode(), tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    // Notifications refused on Android 13+: the receipt is still saved, just quietly.
    try { manager(c).notify(requestId.hashCode(), builder.build()) } catch (_: SecurityException) {}
  }
}
