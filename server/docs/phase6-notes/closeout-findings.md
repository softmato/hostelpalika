# Phase 6 closeout findings (to fold into review_fixes_needed.md)
- BKP-1: setBackupKey on TS read a non-base64 key with the lenient fromBase64; Go ports the same reader (`crypto.FromBase64`), no behaviour change. The restore insert count on a partial unique-index refusal is computed from BulkWriteException write errors in Go.
- FIN-6: waiveLateFine crashed (500) on an invoice row with no `lines` field (lean skips defaults). Go treats it as no lines; TS fixed with `(invoice.lines ?? [])`.
- FIN-7: createFeeSchedule deleted or closed the open rate card before inserting its successor, and deleteFeeSchedule deleted before reopening the predecessor; a failure between them left the hostel with no open card. Go runs each pair in one transaction. TS owed: wrap both in `session.withTransaction`.
- FIN-8: listAllRoomTypes / listAvailableRoomTypes sorted on `roomType.localeCompare`, so one room configuration without a name 500'd the rate card screen. Fixed in TS and Go (`roomType ?? ""`).
