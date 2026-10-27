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

## Restore

Always into a separate database first, never straight over prod.

```bash
aws s3 cp --endpoint-url "$R2_ENDPOINT" s3://hostelpalika-backups/daily/<file> .
age -d -i hostelpalika-backup.key <file> | mongorestore --uri "$TARGET_URI" --archive --gzip --nsFrom '<db>.*' --nsTo 'restore_check.*'
```

Compare the restored counts with the archive's `.json` manifest before trusting it.

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
