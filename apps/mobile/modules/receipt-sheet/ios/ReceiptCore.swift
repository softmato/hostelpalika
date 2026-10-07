import Foundation
import Security
import Darwin

enum ReceiptFailure: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

/// Shared Keychain credentials; an app-group file lock serializes refresh across processes.
enum ReceiptCore {
  static let mutex = NSRecursiveLock()
  static var group: String { (Bundle.main.object(forInfoDictionaryKey: "AppGroupId") ?? Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId")) as? String ?? "group.com.softmato.hostelpalika" }
  static var prefs: UserDefaults { UserDefaults(suiteName: group)! }
  static var base: String { prefs.string(forKey: "base") ?? "https://hostelpalika.com" }
  static func locked<T>(_ work: () throws -> T) throws -> T {
    mutex.lock(); defer { mutex.unlock() }
    guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw ReceiptFailure.message("Shared receipt storage is unavailable.") }
    let descriptor = Darwin.open(directory.appendingPathComponent("receipt-session.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw ReceiptFailure.message("Could not access receipt session.") }
    defer { Darwin.close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else { throw ReceiptFailure.message("Could not lock receipt session.") }
    defer { flock(descriptor, LOCK_UN) }
    return try work()
  }
  static var query: [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "hostelpalika.receipt.session", kSecAttrAccount as String: "session"]
    if let accessGroup = Bundle.main.object(forInfoDictionaryKey: "ReceiptKeychainGroup") as? String { q[kSecAttrAccessGroup as String] = accessGroup }
    return q
  }
  // Internal functions are called only while locked. Keep Keychain writes atomic (SecItemUpdate).
  static func readUnlocked() throws -> [String: String]? {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw ReceiptFailure.message("Unlock your phone to read the receipt session.") }
    return try JSONSerialization.jsonObject(with: data) as? [String: String]
  }
  static func writeUnlocked(_ tokens: [String: String]?) throws {
    guard let tokens = tokens else { let code = SecItemDelete(query as CFDictionary); guard code == errSecSuccess || code == errSecItemNotFound else { throw ReceiptFailure.message("Could not clear receipt session.") }; return }
    let data = try JSONSerialization.data(withJSONObject: tokens)
    let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil) }
    guard status == errSecSuccess else { throw ReceiptFailure.message("Could not save receipt session.") }
  }
  static func read() throws -> [String: String]? { try locked { try readUnlocked() } }
  static func write(_ tokens: [String: String]?) throws { try locked { try writeUnlocked(tokens) } }
  static func configure(_ origin: String, _ hostel: String?) throws {
    guard URL(string: origin)?.scheme == "https" else { throw ReceiptFailure.message("Receipt sharing requires HTTPS.") }
    prefs.set(origin.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forKey: "base")
    prefs.set(hostel, forKey: "hostel")
  }
  final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  }
  /// Called on a worker queue only. Files stream directly; no base64 copy in the web view.
  static func send(_ request: URLRequest, file: URL? = nil) throws -> (Int, Data) {
    let done = DispatchSemaphore(value: 0)
    let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    var result: Result<(Int, Data), Error>?
    let completion: (Data?, URLResponse?, Error?) -> Void = { data, response, error in
      if let error = error { result = .failure(error) }
      else { result = .success(((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data())) }
      done.signal()
    }
    let task: URLSessionTask
    if let file = file { task = session.uploadTask(with: request, fromFile: file, completionHandler: completion) }
    else { task = session.dataTask(with: request, completionHandler: completion) }
    task.resume()
    if done.wait(timeout: .now() + 65) == .timedOut { task.cancel(); session.invalidateAndCancel(); throw ReceiptFailure.message("Connection timed out. Try again.") }
    session.finishTasksAndInvalidate()
    return try result!.get()
  }
  static func http(_ origin: String, _ path: String, _ method: String, _ body: [String: Any]?, _ token: String? = nil) throws -> (Int, [String: Any]) {
    guard let url = URL(string: origin + "/api/v1" + path), url.scheme == "https" else { throw ReceiptFailure.message("Invalid receipt service.") }
    var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 45
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("mobile", forHTTPHeaderField: "x-hostelhub-client")
    if let token = token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
    if let hostel = prefs.string(forKey: "hostel") { request.setValue(hostel, forHTTPHeaderField: "x-hostel-id") }
    if method != "GET" { request.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:]) }
    let (status, data) = try send(request)
    let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? ["message": "Server unavailable. Try again."]
    return (status, result)
  }
  static func refresh(_ origin: String, previous: String? = nil) throws -> String? {
    try locked {
      guard let current = try readUnlocked() else { return nil }
      if let previous = previous, current["accessToken"] != previous { return current["accessToken"] }
      let (status, response) = try http(origin, "/auth/refresh", "POST", ["refreshToken": current["refreshToken"] ?? ""])
      if status == 401 || status == 403 { try writeUnlocked(nil); return nil }
      guard (200..<300).contains(status), let data = response["data"] as? [String: Any], let access = data["accessToken"] as? String, let refresh = data["refreshToken"] as? String else { throw ReceiptFailure.message(response["message"] as? String ?? "Sign in to HostelPalika, then share again.") }
      try writeUnlocked(["accessToken": access, "refreshToken": refresh])
      return access
    }
  }
  static func api(_ path: String, _ method: String = "GET", _ body: [String: Any]? = nil) throws -> Any {
    let resident = (path == "/resident/finance/invoices" && method == "GET") || (method == "POST" && (path.range(of: "^/resident/finance/invoices/[a-f0-9]{24}/claims$", options: .regularExpression) != nil || path.range(of: "^/resident/finance/evidence/[a-f0-9]{24}/read\\?format=json$", options: .regularExpression) != nil))
    let allowed = resident || (path == "/auth/me" && method == "GET") || (path == "/hostel-admin/expenses" && ["GET","POST"].contains(method)) || (["/files/presign", "/hostel-admin/expenses/receipt/read"].contains(path) && method == "POST") || (path.range(of: "^/files/[a-f0-9]{24}/complete$", options: .regularExpression) != nil && method == "POST")
    guard allowed else { throw ReceiptFailure.message("Unsupported receipt action.") }
    guard let token = try read()?["accessToken"] else { throw ReceiptFailure.message("Sign in to HostelPalika, then share again.") }
    var response = try http(base, path, method, body, token)
    if response.0 == 401, let next = try refresh(base, previous: token) { response = try http(base, path, method, body, next) }
    guard (200..<300).contains(response.0), response.1["success"] as? Bool == true else { throw ReceiptFailure.message(response.1["message"] as? String ?? "Could not finish. Try again.") }
    return response.1["data"] ?? NSNull()
  }
  static func upload(_ file: URL, name: String, mime: String, kind: String = "EXPENSE_RECEIPT") throws -> String {
    // Staff save an expense receipt; residents send payment proof. Nothing else is uploaded from a share.
    guard kind == "EXPENSE_RECEIPT" || kind == "PAYMENT_PROOF" else { throw ReceiptFailure.message("Unsupported receipt upload.") }
    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    let value = try api("/files/presign", "POST", ["accessLevel":"PRIVATE","kind":kind,"fileName":name,"mimeType":mime,"sizeBytes":size])
    guard let signed = value as? [String:Any], let id = signed["assetId"] as? String, let raw = signed["presignedUrl"] as? String, let url = URL(string: raw), url.scheme == "https" else { throw ReceiptFailure.message("Could not start receipt upload.") }
    var request = URLRequest(url: url); request.httpMethod = "PUT"; request.timeoutInterval = 60
    request.setValue(mime, forHTTPHeaderField: "Content-Type")
    let (status, _) = try send(request, file:file)
    guard (200..<300).contains(status) else { throw ReceiptFailure.message("Receipt upload failed. Try again.") }
    _ = try api("/files/\(id)/complete", "POST", [:])
    return id
  }
}
