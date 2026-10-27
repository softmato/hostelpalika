# Platform backup

`.github/workflows/db-backup.yml` dumps prod every night at 02:00 Nepal, encrypts the
dump with [age](https://age-encryption.org) to a public key, and stores it in a
backups-only R2 bucket. The private key that decrypts it is kept offline by the owner:
GitHub, Vercel and the bucket only ever hold ciphertext.

This is platform disaster recovery only. The customer Google Drive backup (I3–I7) and
the app's on-device cache (Phase 6) are separate systems.

## What lands in the bucket

| Path | Kept |
| --- | --- |
| `daily/hostelpalika-<UTC stamp>.archive.gz.age` + `.json` manifest | expiry rule on `daily/` |
| `monthly/…` — the 1st of each month, copied | expiry rule on `monthly/` |
| `latest.json` — the newest manifest | overwritten each run |

The manifest holds the file name, time, size, SHA-256 of the encrypted file, and the
document count per collection. A run that dumps fewer collections than
`BACKUP_MIN_COLLECTIONS` (default 20) fails instead of uploading.

## One-time setup (owner)

1. **Key pair**, on your own machine: `age-keygen -o hostelpalika-backup.key`.
   Keep the file in your password manager and on paper. It is the only way to read a
   backup — lose it and every archive is unreadable. The line starting `age1…` is the
   public key.
2. **Bucket**: in Cloudflare R2 create `hostelpalika-backups` (no public access). Add
   lifecycle rules: delete `daily/` objects after 35 days, `monthly/` after 400 days.
   Create an R2 API token with Object Read & Write on **this bucket only** — not the
   app's token, so a leaked app key cannot delete backups.
3. **Atlas**: a database user `backup` with the built-in *Only read any database* role.
   Its connection string must end in the database name (`…mongodb.net/<db>?…`) so only
   that database is dumped. Network access must admit GitHub's runners (the same
   `0.0.0.0/0` entry Vercel already relies on, if that is how prod is set).
4. **GitHub** → softmato/hostelpalika → Settings → Secrets and variables → Actions:
   - Secrets: `BACKUP_MONGODB_URI`, `BACKUP_R2_ENDPOINT`
     (`https://<account-id>.r2.cloudflarestorage.com`), `BACKUP_R2_ACCESS_KEY_ID`,
     `BACKUP_R2_SECRET_ACCESS_KEY`.
   - Variables: `BACKUP_R2_BUCKET` = `hostelpalika-backups`, `BACKUP_AGE_RECIPIENT` = the
     `age1…` public key.
5. Actions → **Database backup** → Run workflow. Check `latest.json` appears in the bucket.

A failed scheduled run emails the GitHub account that last edited the workflow's schedule.

## Status row

The workflow posts its manifest (counts and hash only) to `POST /api/v1/cron/platform-backup`
with the cron secret, and the restore drill posts its result there too. The superadmin
dashboard shows **Last backup … · N collections**, a red badge when none came in 30 hours,
and **Not verified** until a drill has passed. The server never gets a key to the backups
bucket. Set up (owner): GitHub secret `BACKUP_CRON_SECRET` = the app's `CRON_SECRET`, and
variable `BACKUP_REPORT_URL` = `https://hostelpalika.com/api/v1/cron/platform-backup`.

## Restore drill (I2)

Always into a **separate** database — a free M0 in a second Atlas project — never prod.
On your own machine, with `age`, MongoDB Database Tools and the repo's dependencies:

```bash
DRILL_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com DRILL_R2_ACCESS_KEY_ID=<read-only key> DRILL_R2_SECRET_ACCESS_KEY=<secret> DRILL_R2_BUCKET=hostelpalika-backups DRILL_AGE_KEY=./hostelpalika-backup.key DRILL_SOURCE_DB=<prod db name> DRILL_TARGET_URI=<spare cluster URI> DRILL_REPORT_URL=https://hostelpalika.com/api/v1/cron/platform-backup CRON_SECRET=<cron secret> node apps/web/scripts/backup-drill.mjs
```

It downloads the newest archive (or the one named as an argument), checks its SHA-256
against the manifest, pipes `age -d` straight into `mongorestore --nsFrom '<db>.*' --nsTo
'restore_check.*'`, counts every collection, prints the differences, and reports PASSED or
FAILED to the status row. It reads no `.env` and refuses a target on the same cluster as
`MONGODB_URI`. Give it its own **read-only** R2 token on the backups bucket.

A real recovery is the same command pointed at the new cluster, then the app's
`MONGODB_URI` switched to it once the counts match.

## Drills (I8)

Run each after setup and after any change to backup code; write the date and result in the
table.

| Drill | How | Pass when | Last run |
| --- | --- | --- | --- |
| Lost database | Restore drill above, into the spare cluster | every count matches, status row says passed | — |
| Deleted rows | On a test hostel, delete a few residents/invoices, then app → Backup → Restore from the last backup | the rows are back, nothing else changed, `BACKUP_RESTORED` rows in the audit log | — |
| Revoked Drive | In the Google account → Security → Third-party access → remove HostelPalika, then Back up now | screen says "Access removed" with Reconnect; reconnecting and backing up works | — |
| Drive full | Fill a test Google account, Back up now | screen says "Drive is full" with Google's reason; the run is listed as Failed | — |
| Lost kit / phone | Sign in on a second phone with no key, open Restore | only the recovery code opens it; a wrong code is refused by the checksum; with neither, nothing opens | — |
| Tampered archive | Upload any file over a backup in Drive (or flip a byte of a downloaded one), then Restore | refused: "not the backup we made" before decryption | — |
| Cross-tenant restore | Owner of hostel A calls restore with hostel B's run id or chunk | 404 for the run; a chunk not recorded for A is refused; covered by `backup.service.test.ts` | automated |

# Customer backup (Google Drive)

A hostel owner on Pro or Max can back their own hostel up to their own Google Drive.
Code: `apps/web/src/modules/backup/`, format `packages/shared/src/backup/sealed-archive.ts`.
This is separate from the platform backup above and from the app's on-device cache.

## How it works

1. **Recovery key** — the owner's phone makes an X25519 key pair (`tweetnacl`). The
   private key stays in the phone's SecureStore and in the printed recovery kit
   (14 groups of 4 characters + a QR of the same). Only the public key is sent to us.
2. **Drive** — the owner allows the `drive.appdata` scope: a hidden folder only this
   app can see. The refresh token is stored sealed with `FINANCE_MASTER_KEY`
   (`sealValue`, scope `{hostelId, DRIVE_REFRESH_TOKEN}`).
3. **Backup** — the `customer-backup` cron (hourly; each hostel once a day) exports the
   hostel (`tenant-export.ts`: the hostel + its branches, every mapped collection),
   cuts it into chunks and records each chunk's SHA-256, encrypts it with a fresh
   random key (XSalsa20-Poly1305), seals that key to the owner's public key, wipes the
   plaintext and the key from memory, uploads the file, and compares Drive's MD5 with
   ours ("checked"). The newest 30 files stay in Drive.
4. **Restore** (app) — download the file → recovery key from the phone or the kit →
   check its SHA-512 against our record and its hostel against the open hostel →
   decrypt on the phone → preview the counts → confirm → the phone sends each chunk
   back; the server accepts a chunk only if its hash is the one recorded for this
   hostel's backup, and only adds rows that are missing. Each chunk is audit-logged.

## Threat model (for review — no "end-to-end encrypted" wording until it is signed off)

| Who | Can | Cannot |
| --- | --- | --- |
| Us / someone with our DB and server | see the public key, history, chunk hashes; make *new* backups (they are made from live data we already hold) | decrypt any backup already made: the data key is gone and only the owner's private key opens it |
| Google / someone with the owner's Drive | delete or replace files | read them; a replaced file fails the SHA-512 check against our record |
| Someone with the public key | make a well-formed archive | get it restored: restore takes only chunks whose hash we recorded for that hostel |
| A different hostel's owner | — | fetch or restore another hostel's backup: every read is scoped to the owner's hostel in the query, and rows of another hostel are refused |
| Someone with the phone unlocked | open the backup screen as the owner | — the app lock (PIN / fingerprint) is the guard here |
| Someone with the paper kit | decrypt any backup file they also obtain | — the kit must be kept like a house key |

Honest limits:
- We are trusted for **integrity**, not for confidentiality of past backups. While the
  hostel runs on our servers we hold its live data anyway; the claim is only that a
  backup file, once made, is unreadable to us.
- The cipher is NaCl's XSalsa20-Poly1305 + X25519 (libsodium's sealed-box design),
  not AES-256-GCM: the phone has no audited pure-JS AES-GCM and Hermes has no WebCrypto,
  while `tweetnacl` is audited (Cure53) and already shipped with Pusher.
- File bytes (photos, documents) are not in the archive, only their records.
- Lose both the phone's key and the kit, and every backup is unreadable — by design.
- A master-key rotation (`scripts/rotate-finance-master-key.mjs`) rewraps the Drive tokens too.
