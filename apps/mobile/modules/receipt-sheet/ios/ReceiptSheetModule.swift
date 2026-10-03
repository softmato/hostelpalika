import ExpoModulesCore

public class ReceiptSheetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ReceiptSheet")
    AsyncFunction("readSession") { () throws -> [String:String]? in try ReceiptCore.read() }
    AsyncFunction("writeSession") { (tokens: [String:String]?) throws in try ReceiptCore.write(tokens) }
    AsyncFunction("refreshSession") { (base: String) async throws -> String? in
      try await Task.detached { try ReceiptCore.refresh(base) }.value
    }
    AsyncFunction("configure") { (base: String, hostel: String?) throws in try ReceiptCore.configure(base, hostel) }
    AsyncFunction("getAutoSave") { (key: String) -> Bool in ReceiptCore.prefs.bool(forKey: key) }
    AsyncFunction("setAutoSave") { (key: String, enabled: Bool) in ReceiptCore.prefs.set(enabled, forKey: key) }
  }
}
