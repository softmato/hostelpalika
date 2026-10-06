import CryptoKit
import UIKit
import WebKit
import UniformTypeIdentifiers

private final class ReceiptImportJob {
  let providers: [NSItemProvider]
  init(_ providers: [NSItemProvider]) { self.providers = providers }
  let worker = DispatchQueue(label: "hostelpalika.receipt")
  private var file: URL?
  private var fileName = "receipt"
  private var mime = ""
  private var assetId: String?
  private var requestId = UUID().uuidString
  private let cancellation = NSLock()
  private var isClosed = false
  var closed: Bool { cancellation.lock(); defer { cancellation.unlock() }; return isClosed }
  private func prepare() throws {
    if file != nil { return }
    let files = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || ($0.hasItemConformingToTypeIdentifier(UTType.data.identifier) && !$0.hasItemConformingToTypeIdentifier(UTType.text.identifier) && !$0.hasItemConformingToTypeIdentifier(UTType.url.identifier)) }
    guard files.count == 1, let provider = files.first else { throw ReceiptFailure.message("Share one payment screenshot or PDF.") }
    let type = provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) ? UTType.pdf.identifier : provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? UTType.image.identifier : UTType.data.identifier
    let done = DispatchSemaphore(value: 0)
    let copyLock = NSLock()
    var abandoned = false
    var outcome: Result<(URL, String, String), Error>?
    let receive: (URL?, Error?) -> Void = { source, error in
      defer { done.signal() }
      do {
        if let error = error { throw error }
        guard let source = source else { throw ReceiptFailure.message("Could not read the shared file.") }
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0 && size <= 20 * 1024 * 1024 else { throw ReceiptFailure.message("Choose a receipt under 20 MB.") }
        let suggestedName = provider.suggestedName ?? source.lastPathComponent
        let mime = [UTType(filenameExtension: source.pathExtension)?.preferredMIMEType,
          UTType(filenameExtension: (suggestedName as NSString).pathExtension)?.preferredMIMEType,
          UTType(type)?.preferredMIMEType].compactMap { $0 }
          .first { $0 == "application/pdf" || $0.hasPrefix("image/") } ?? ""
        guard mime == "application/pdf" || mime.hasPrefix("image/") else { throw ReceiptFailure.message("Choose a payment screenshot or PDF.") }
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("receipt-" + UUID().uuidString)
        try FileManager.default.copyItem(at: source, to: copy)
        copyLock.lock(); defer { copyLock.unlock() }
        if abandoned { try? FileManager.default.removeItem(at:copy); return }
        outcome = .success((copy, suggestedName, mime))
      } catch { outcome = .failure(error) }
    }
    // A file-URL provider supplies the receipt URL, not a public.data file
    // representation. Asking it for data can lose the incoming attachment.
    var progress: Progress?
    if type == UTType.data.identifier && provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
        receive(item as? URL, error)
      }
    } else {
      progress = provider.loadFileRepresentation(forTypeIdentifier: type, completionHandler: receive)
    }
    if done.wait(timeout:.now() + 30) == .timedOut {
      copyLock.lock(); abandoned = true
      if case .success(let value) = outcome { try? FileManager.default.removeItem(at:value.0) }
      copyLock.unlock(); progress?.cancel()
      throw ReceiptFailure.message("The payment app did not provide its receipt. Share it again.")
    }
    let value = try outcome!.get(); file = value.0; fileName = value.1; mime = value.2
    let handle = try FileHandle(forReadingFrom: value.0); defer { try? handle.close() }
    var digest = SHA256()
    while let bytes = try handle.read(upToCount: 16384), !bytes.isEmpty { digest.update(data: bytes) }
    requestId = "receipt-" + String(digest.finalize().map { String(format:"%02x", $0) }.joined().prefix(56))
  }
  func handle(_ request: [String:Any]) throws -> Any {
    guard !closed else { throw ReceiptFailure.message("Receipt cancelled.") }
    let action = request["action"] as? String ?? ""
    var value: Any = NSNull()
        switch action {
        case "init": try prepare(); value = ["fileName":fileName,"requestId":requestId]
        case "hostel": value = ReceiptCore.prefs.string(forKey: "hostel") ?? ""
        case "upload": try prepare(); if assetId == nil { assetId = try ReceiptCore.upload(file!, name:fileName, mime:mime) }; value = assetId!
        case "api":
          guard !closed, let path = request["path"] as? String else { throw ReceiptFailure.message("Receipt cancelled.") }
          value = try ReceiptCore.api(path, request["method"] as? String ?? "GET", request["body"] as? [String:Any])
        case "handoff": try handoff()
        case "preference":
          guard let key = request["key"] as? String, key.hasPrefix("hostelpalika.receipt-auto:") else { throw ReceiptFailure.message("Invalid receipt preference.") }
          if let enabled = request["enabled"] as? Bool { ReceiptCore.prefs.set(enabled, forKey:key) }
          value = ReceiptCore.prefs.bool(forKey:key)
        default: throw ReceiptFailure.message("Unsupported receipt action.")
        }
    return value
  }
  /// Residents claim against an invoice, which lives in the app. Leave the file
  /// exactly where expo-sharing's own extension would; its app side reads this
  /// payload and routes to /share-payment (invoice → claim → the usual checks).
  private func handoff() throws {
    try prepare()
    guard let group = Bundle.main.object(forInfoDictionaryKey: "AppGroupId") as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
      let defaults = UserDefaults(suiteName: group) else { throw ReceiptFailure.message("Open HostelPalika to add this receipt.") }
    let target = container.appendingPathComponent(requestId + "-" + (fileName as NSString).lastPathComponent)
    try? FileManager.default.removeItem(at: target)
    try FileManager.default.copyItem(at: file!, to: target)
    let size = (try? FileManager.default.attributesOfItem(atPath: target.path))?[.size] as? Int
    let payload = [SharePayload(type: mime.hasPrefix("image/") ? .image : .file, value: target.absoluteString, mimeType: mime,
      metadata: ShareMetadata(originalName: fileName, size: size))]
    defaults.set(try JSONEncoder().encode(payload), forKey: SHARE_INTO_DEFAULTS_KEY)
  }
  func cancel() {
    cancellation.lock(); isClosed = true; cancellation.unlock()
    worker.async { [self] in if let file = file { try? FileManager.default.removeItem(at:file) } }
  }
}

final class ShareIntoViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
  private var web: WKWebView!
  private var job: ReceiptImportJob!
  override func viewDidLoad() {
    super.viewDidLoad()
    let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
    job = ReceiptImportJob(items.flatMap { $0.attachments ?? [] })
    preferredContentSize = CGSize(width:520, height:680)
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(self, name:"receipt")
    web = WKWebView(frame:view.bounds, configuration:configuration)
    web.autoresizingMask = [.flexibleWidth, .flexibleHeight]; web.navigationDelegate = self
    view.addSubview(web)
    web.loadHTMLString(receiptMarkup, baseURL:URL(string:"https://receipt.invalid/"))
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.navigationType == .other && (action.request.url?.absoluteString == "about:blank" || action.request.url?.host == "receipt.invalid") ? .allow : .cancel)
  }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let raw = message.body as? String, let data = raw.data(using:.utf8), let request = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else { return }
    if request["action"] as? String == "close" { finish(); return }
    let current = job!
    current.worker.async { [weak self] in
      if current.closed { return }
      var reply: [String:Any] = ["id":request["id"] ?? 0]
      do { reply["value"] = try current.handle(request) }
      catch { reply["error"] = error.localizedDescription }
      if request["action"] as? String == "handoff" && reply["error"] == nil {
        DispatchQueue.main.async { self?.openApp(); self?.finish() }
        return
      }
      if let data = try? JSONSerialization.data(withJSONObject:reply), let json = String(data:data,encoding:.utf8) {
        DispatchQueue.main.async { if !current.closed { self?.web.evaluateJavaScript("window.receiptReply(\(json))", completionHandler:nil) } }
      }
    }
  }
  /// expo-sharing's own way out of a share extension (its template's `openURL`).
  private func openApp() {
    guard let scheme = Bundle.main.object(forInfoDictionaryKey: "MainTargetUrlScheme") as? String,
      let url = URL(string: "\(scheme)://expo-sharing") else { return }
    var responder: UIResponder? = self
    while let current = responder {
      if let application = current as? UIApplication { application.open(url, options: [:], completionHandler: nil) }
      responder = current.next
    }
  }
  private func finish() {
    job?.cancel()
    web?.configuration.userContentController.removeScriptMessageHandler(forName:"receipt")
    extensionContext?.completeRequest(returningItems:nil, completionHandler:nil)
  }
  override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); if job?.closed == false { finish() } }
}
// ReceiptCore and receiptMarkup are appended by withReceiptSheet at prebuild.
