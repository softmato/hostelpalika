# Receipt sharing

Android: a separate translucent bottom activity receives SEND via EXTRA_STREAM or ClipData, copies the temporary URI while its grant is alive, and runs the bundled receipt form without React Native or MainActivity. No overlay permission is used.

iOS: Expo's Share extension target runs our bundled WKWebView form inside the host share surface. Its controller is replaced at prebuild; the app is not launched. App Group and shared Keychain provisioning are required for both targets.

PWA: supported installed Chromium browsers receive a file via the service worker and open a lightweight page within /app scope. Browsers cannot display this page inside another app. iOS PWA uses Expenses → Import payment receipt because it cannot register a receiving share target.

Cold/uncontrolled multipart shares to `/app/share-payment` are rewritten to `/api/receipt-share` instead of falling through to the Expo HTML shell and losing the file. This fallback returns a nonce-protected, no-store HTML response that stages the receipt in the same browser cache and opens the automatic reader. It makes no database/storage write, but the file bytes transit the server for this fallback. Its limit is 3 MB to allow base64 inside the hosting response limit; the normal service-worker path retains its 20 MB limit. Oversized requests can also be rejected by the host before the handler runs. The standalone sheet registers/updates the worker for subsequent shares. Share error parameters survive the staff redirect.

The shared form always uses a white theme, short reading/ready statuses, collapsed description details, and hides the file picker after reading succeeds. Android/iOS native bundles reuse this HTML and need a new build to receive its visual changes.

2026-10-04: the second Android PWA recording reaches the `unsupported` share error before OCR. The manifest now includes PDF extensions, x-pdf and generic binary MIME metadata so Chrome can attach bank-exported PDFs. Worker, server fallback and manual import normalize x-pdf consistently; multipart receivers accept one file regardless of an older manifest's field name. Missing, empty, multiple, oversized and unsupported attachments have distinct short errors. The video does not expose the actual MIME type or multipart body, so real-device confirmation remains necessary. Existing Android WebAPK installs need the updated manifest; updating the worker alone cannot change Chrome's attachment filtering.

Native Android advertises x-pdf/binary shares and normalizes x-pdf even without an extension. Native iOS reads file-URL providers with `loadItem` and copies their security-scoped file before releasing access. iOS PWA still requires Import payment receipt, which starts reading immediately after selection; Safari does not implement receiving Web Share Target. Native iOS changes require macOS/Xcode signing and device validation.

The form shows read progress, amount, method, description, category, Save and Cancel. Auto-save is per account and selected hostel on this device. It is opt-in and only applies to a recognized outgoing, successful receipt with consistent amount, payee and transaction id; other receipts stay on the editable form. The switch lives in Expenses. Residents retain invoice selection on the PWA; the native expense extension explains that invoice proofs belong in the app.

Tokens never enter the native web view. Android stores one canonical encrypted session in noBackupFilesDir with a Keystore key. iOS uses a device-only shared Keychain item. The app migrates old SecureStore credentials once; the app and share target use the same native refresh code and rotation lock (an app-group file lock on iOS). No duplicate refresh-token copy is kept. Existing server authorization, upload verification, private storage, and hostel scoping still apply.

The receipt SHA-256 produces a stable idempotency key for all three platforms; retries and repeated shares of the same bytes cannot create duplicate expenses for that recorder and hostel. Uploads stream directly to the signed URL with no bearer token. Cancel prevents subsequent save; a save already submitted cannot be recalled by dismissing the OS sheet.

Build a new native binary. After installing, launch/sign in once to migrate the session. An OTA update alone cannot add the Android activity, local module, or iOS extension/entitlements.

Device acceptance: eSewa PDF + bank image, cold/warm app, expired access token, generic/absent MIME, unknown size, ClipData, empty/oversized/multiple file, offline/retry, cancel during read, repeat Save, repeat share, auto-save toggle, account/hostel change, logout, Android Back, iOS dismissal, and reduced motion. iOS compilation/signing and device performance require macOS/Xcode and real devices.


### Receipt save notifications (2026-10-03)
Shared receipt saves now create a recorder-only confirmation in the existing bell/native/Web Push pipeline, linking to Expenses. Manual and automatic saves both opt in through sharedReceipt; ordinary expenses stay quiet. Idempotent retries return before notification creation. Delivery failures do not fail a committed Save; push delivery runs after the response through the existing dispatcher and respects permissions/preferences. Receipt/expense regression tests passed (33). Native binaries must be rebuilt to bundle the updated sheet. iOS PWA direct incoming sharing remains unsupported; a separately implemented, securely paired Apple Shortcut could receive files and upload them without opening the PWA. That Shortcut is not implemented.
