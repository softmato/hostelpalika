package com.softmato.receipts

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One encrypted vault and rotation lock for React Native and the independent share activity. */
object ReceiptCore {
  private val lock = Any()
  private const val alias = "hostelpalika.receipt.session"
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  private fun file(c: Context) = File(c.noBackupFilesDir, "receipt-session")
  fun read(c: Context): JSONObject? = synchronized(lock) {
    if (!file(c).exists()) return@synchronized null
    val parts = file(c).readText().split(":")
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
    JSONObject(String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
  }
  fun write(c: Context, value: JSONObject?) = synchronized(lock) {
    if (value == null) { file(c).delete(); return@synchronized }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    val encrypted = cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
    val temp = File(c.noBackupFilesDir, "receipt-session.tmp")
    temp.writeText(Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP))
    check(temp.renameTo(file(c))) { "Could not save session" }
  }
  fun prefs(c: Context) = c.getSharedPreferences("receipt-settings", Context.MODE_PRIVATE)
  fun base(c: Context) = prefs(c).getString("base", "https://hostelpalika.com")!!
  /** Receipts handed to [ReceiptSaveService], kept until saved or reviewed; a day later they are swept. */
  fun pending(c: Context) = File(c.noBackupFilesDir, "receipts").apply {
    mkdirs(); listFiles()?.filter { it.lastModified() < System.currentTimeMillis() - 86_400_000 }?.forEach { it.delete() }
  }
  /** "Don't ask next time" for the signed-in account and hostel — the key the app last set via `setAutoKey`. */
  fun autoSaveOn(c: Context) = try {
    val key = prefs(c).getString("autoKey", null)
    key != null && prefs(c).getBoolean(key, false) && read(c) != null
  } catch (_: Exception) { false }
  fun configure(c: Context, base: String, hostel: String?) {
    require(URL(base).protocol == "https") { "Receipt sharing requires HTTPS" }
    prefs(c).edit().putString("base", base.trimEnd('/')).putString("hostel", hostel).apply()
  }
  private fun http(url: String, method: String, body: JSONObject?, token: String? = null, hostel: String? = null): Pair<Int, JSONObject> {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = method; connection.connectTimeout = 15000; connection.readTimeout = 45000
      connection.instanceFollowRedirects = false
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("x-hostelhub-client", "mobile")
      if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
      if (!hostel.isNullOrBlank()) connection.setRequestProperty("x-hostel-id", hostel)
      if (method != "GET") { connection.doOutput = true; connection.outputStream.use { it.write((body ?: JSONObject()).toString().toByteArray()) } }
      val status = connection.responseCode
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
      val result = try { JSONObject(raw) } catch (_: Exception) { JSONObject().put("message", "Server unavailable. Try again.") }
      // No disconnect(): the body is read and closed, so the socket goes back to the pool
      // and the next call of this share skips a fresh TLS handshake.
      return status to result
    } catch (e: Exception) { connection.disconnect(); throw e }
  }
  fun refresh(c: Context, base: String, previous: String? = null): String? = synchronized(lock) {
    require(URL(base).protocol == "https")
    val session = read(c) ?: return@synchronized null
    if (previous != null && session.getString("accessToken") != previous) return@synchronized session.getString("accessToken")
    val (status, result) = http(base.trimEnd('/') + "/api/v1/auth/refresh", "POST", JSONObject().put("refreshToken", session.getString("refreshToken")))
    if (status == 401 || status == 403) { write(c, null); return@synchronized null }
    check(status in 200..299) { result.optString("message", "Sign in to HostelPalika, then share again.") }
    val data = result.getJSONObject("data")
    val next = JSONObject().put("accessToken", data.getString("accessToken")).put("refreshToken", data.getString("refreshToken"))
    write(c, next)
    next.getString("accessToken")
  }
  fun api(c: Context, path: String, method: String = "GET", body: JSONObject? = null): Any {
    require((path == "/auth/me" && method == "GET") ||
      (path == "/hostel-admin/expenses" && method in listOf("GET", "POST")) ||
      (path in listOf("/files/presign", "/hostel-admin/expenses/receipt/read") && method == "POST") ||
      (Regex("/files/[a-f0-9]{24}/complete").matches(path) && method == "POST"))
    var token = read(c)?.getString("accessToken") ?: error("Sign in to HostelPalika, then share again.")
    val url = base(c) + "/api/v1" + path
    val hostel = prefs(c).getString("hostel", null)
    var response = http(url, method, body, token, hostel)
    if (response.first == 401) {
      token = refresh(c, base(c), token) ?: error("Sign in to HostelPalika, then share again.")
      response = http(url, method, body, token, hostel)
    }
    check(response.first in 200..299 && response.second.optBoolean("success")) { response.second.optString("message", "Could not finish. Try again.") }
    return response.second.opt("data") ?: JSONObject.NULL
  }
  fun upload(c: Context, file: File, name: String, mime: String): String {
    val signed = api(c, "/files/presign", "POST", JSONObject().put("accessLevel", "PRIVATE").put("kind", "EXPENSE_RECEIPT")
      .put("fileName", name).put("mimeType", mime).put("sizeBytes", file.length())) as JSONObject
    val url = URL(signed.getString("presignedUrl")); require(url.protocol == "https")
    val connection = url.openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "PUT"; connection.instanceFollowRedirects = false
      connection.connectTimeout = 15000; connection.readTimeout = 60000; connection.doOutput = true
      connection.setRequestProperty("Content-Type", mime); connection.setFixedLengthStreamingMode(file.length())
      connection.outputStream.use { out -> file.inputStream().use { it.copyTo(out) } }
      check(connection.responseCode in 200..299) { "Receipt upload failed. Try again." }
    } finally { connection.disconnect() }
    val id = signed.getString("assetId")
    api(c, "/files/$id/complete", "POST", JSONObject())
    return id
  }
}
