# Receipt sharing

Android: a separate translucent bottom activity receives SEND via EXTRA_STREAM or ClipData, copies the temporary URI while its grant is alive, and runs the bundled receipt form without React Native or MainActivity. No overlay permission is used.

iOS: Expo's Share extension target runs our bundled WKWebView form inside the host share surface. Its controller is replaced at prebuild; the app is not launched. App Group and shared Keychain provisioning are required for both targets.

PWA: supported installed Chromium browsers receive a file via the service worker and open a lightweight page within /app scope. Browsers cannot display this page inside another app. iOS PWA uses Expenses → Import payment receipt because it cannot register a receiving share target.

The form shows read progress, amount, method, description, category, Save and Cancel. Auto-save is per account and selected hostel on this device. It is opt-in and only applies to a recognized outgoing, successful receipt with consistent amount, payee and transaction id; other receipts stay on the editable form. The switch lives in Expenses. Residents retain invoice selection on the PWA; the native expense extension explains that invoice proofs belong in the app.

Tokens never enter the native web view. Android stores one canonical encrypted session in noBackupFilesDir with a Keystore key. iOS uses a device-only shared Keychain item. The app migrates old SecureStore credentials once; the app and share target use the same native refresh code and rotation lock (an app-group file lock on iOS). No duplicate refresh-token copy is kept. Existing server authorization, upload verification, private storage, and hostel scoping still apply.

The receipt SHA-256 produces a stable idempotency key for all three platforms; retries and repeated shares of the same bytes cannot create duplicate expenses for that recorder and hostel. Uploads stream directly to the signed URL with no bearer token. Cancel prevents subsequent save; a save already submitted cannot be recalled by dismissing the OS sheet.

Build a new native binary. After installing, launch/sign in once to migrate the session. An OTA update alone cannot add the Android activity, local module, or iOS extension/entitlements.

Device acceptance: eSewa PDF + bank image, cold/warm app, expired access token, generic/absent MIME, unknown size, ClipData, empty/oversized/multiple file, offline/retry, cancel during read, repeat Save, repeat share, auto-save toggle, account/hostel change, logout, Android Back, iOS dismissal, and reduced motion. iOS compilation/signing and device performance require macOS/Xcode and real devices.


### Receipt save notifications (2026-10-03)
Shared receipt saves now create a recorder-only confirmation in the existing bell/native/Web Push pipeline, linking to Expenses. Manual and automatic saves both opt in through sharedReceipt; ordinary expenses stay quiet. Idempotent retries return before notification creation. Delivery failures do not fail a committed Save; push delivery runs after the response through the existing dispatcher and respects permissions/preferences. Receipt/expense regression tests passed (33). Native binaries must be rebuilt to bundle the updated sheet. iOS PWA direct incoming sharing remains unsupported; a separately implemented, securely paired Apple Shortcut could receive files and upload them without opening the PWA. That Shortcut is not implemented.
