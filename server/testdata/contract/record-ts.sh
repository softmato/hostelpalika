#!/usr/bin/env bash
# Starts the TS server on :3100 against the contract fixture database, with
# the contract secrets and every outbound service switched off, for
# `go run ./cmd/dev record -base http://localhost:3100 -fixture ...`
# (TESTING.md §3). Run from the repo root; Ctrl-C stops it.
#
# The root .env only fills variables that are missing (load-root-env.ts
# fillMissing), so an empty value here keeps a key off.
set -euo pipefail
cd "$(dirname "$0")/../../../apps/web"

export APP_ENV=development APP_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000
export MONGODB_URI='mongodb://127.0.0.1:27018/hostelpalika_contract?directConnection=true'
export JWT_ACCESS_SECRET=contract-access-secret-0123456789abcdef
export JWT_REFRESH_SECRET=contract-refresh-secret-0123456789abcdef
export OTP_HASH_SECRET=contract-otp-secret
export GOOGLE_CLIENT_ID=contract-google-client.apps.googleusercontent.com
export SEARCH_QUOTA_SECRET=contract-search-quota-secret
export PERSONAL_DATA_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
export FINANCE_MASTER_KEY=0000000000000000000000000000000000000000000000000000000000000002
export CRON_SECRET=contract-cron-secret
for k in RESEND_API_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN PUSHER_APP_ID PUSHER_KEY PUSHER_SECRET PUSHER_CLUSTER \
  GEMINI_API_KEYS GROQ_API_KEYS OPENROUTER_API_KEYS MISTRAL_API_KEYS CEREBRAS_API_KEYS \
  SOFTMATO_BASE_URL SOFTMATO_SECRET SOFTMATO_WEBHOOK_SECRET QUESTIONCALL_WEBHOOK_SECRET \
  R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_PUBLIC R2_BUCKET_PRIVATE R2_PUBLIC_URL \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
  export "$k="
done
exec ../../node_modules/.bin/next dev -p 3100
