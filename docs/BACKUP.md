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
