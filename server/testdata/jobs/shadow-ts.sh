#!/usr/bin/env bash
# The TS half of the Phase 9 shadow (PHASES.md): the TS server on :3100 against
# the shadow's TS copy of live data, every outbound host blocked
# (block-outbound.cjs) and every provider key blank. Run from the repo root,
# then `go run ./cmd/dev shadow-phase9` from server/. Ctrl-C stops it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
cd "$here/../../../apps/web"

export APP_ENV=development APP_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000
export MONGODB_URI='mongodb://127.0.0.1:27018/hp_shadow_ts?directConnection=true'
export CRON_SECRET=shadow-cron-secret
export NODE_OPTIONS="--require $here/block-outbound.cjs"
export SHADOW_OUTBOUND_LOG="$here/outbound.log"
for k in RESEND_API_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN PUSHER_APP_ID PUSHER_KEY PUSHER_SECRET PUSHER_CLUSTER \
  GEMINI_API_KEYS GROQ_API_KEYS OPENROUTER_API_KEYS MISTRAL_API_KEYS CEREBRAS_API_KEYS EXPO_ACCESS_TOKEN \
  SOFTMATO_BASE_URL SOFTMATO_SECRET SOFTMATO_WEBHOOK_SECRET QUESTIONCALL_WEBHOOK_SECRET \
  GOOGLE_DRIVE_CLIENT_ID GOOGLE_DRIVE_CLIENT_SECRET GOOGLE_MAPS_API_KEY \
  R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_PUBLIC R2_BUCKET_PRIVATE R2_PUBLIC_URL \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
  export "$k="
done
exec ../../node_modules/.bin/next dev -p 3100
