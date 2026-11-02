# Phase 6 closeout findings (to fold into review_fixes_needed.md)
- BKP-1: setBackupKey on TS read a non-base64 key with the lenient fromBase64; Go ports the same reader (`crypto.FromBase64`), no behaviour change. The restore insert count on a partial unique-index refusal is computed from BulkWriteException write errors in Go.
- FIN-6: waiveLateFine crashed (500) on an invoice row with no `lines` field (lean skips defaults). Go treats it as no lines; TS fixed with `(invoice.lines ?? [])`.
