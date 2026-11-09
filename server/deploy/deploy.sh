#!/usr/bin/env bash
# deploy.sh <git-sha> — roll the API on the VPS to ghcr.io/softmato/hostelpalika-api:<sha>
# with no gap. CI (.github/workflows/server.yml, job "deploy") copies server/deploy/ to
# ~/hostelpalika/incoming/ and runs this; by hand (rollback) it is the same command
# with an older sha: `bash ~/hostelpalika/deploy/deploy.sh <old-sha>`.
#
# Layout on the VPS:  ~/hostelpalika/.env            (secrets, mode 600, never in git)
#                     ~/hostelpalika/deploy/         (compose.yaml, Caddyfile, redis.conf, this)
#                     ~/hostelpalika/deployed.txt    (current sha, then the one before)
#
# Order: config in place → Redis up → indexes (only ever create) → new replicas beside
# the old → wait healthy → old ones drain on SIGTERM (Caddy retries on the others) →
# Caddy up/reloaded → deep health through Caddy. Any failure before the old replicas
# stop leaves the old release serving.
set -euo pipefail

TAG=${1:?usage: deploy.sh <git-sha>}
ROOT=${HOSTELPALIKA_ROOT:-$HOME/hostelpalika}
REPLICAS=${API_REPLICAS:-1}
HEALTH_WAIT=${HEALTH_WAIT:-120}
SRC=$(cd "$(dirname "$0")" && pwd)
DST=$ROOT/deploy

log() { printf '%s deploy %s: %s\n' "$(date -u +%FT%TZ)" "$TAG" "$*"; }
die() { log "FAILED: $*"; exit 1; }

[ -f "$ROOT/.env" ] || die "$ROOT/.env is missing"
grep -Eq '^REDIS_PASSWORD=[0-9a-f]{32,}$' "$ROOT/.env" || die "REDIS_PASSWORD (hex, 32+ chars: openssl rand -hex 32) is missing from $ROOT/.env"

# 1. Config. Files are rewritten in place (same inode): Docker bind-mounts single
#    files by inode, so replacing one would leave Caddy reading the old copy.
mkdir -p "$DST"
caddy_changed=0 redis_changed=0
for f in compose.yaml Caddyfile redis.conf redis-cache.conf deploy.sh; do
  [ "$SRC" = "$DST" ] && break
  [ -f "$SRC/$f" ] || continue
  if ! cmp -s "$SRC/$f" "$DST/$f"; then
    [ -f "$DST/$f" ] || : >"$DST/$f"
    cat "$SRC/$f" >"$DST/$f"
    case $f in Caddyfile) caddy_changed=1 ;; redis.conf | redis-cache.conf) redis_changed=1 ;; esac
    log "updated $f"
  fi
done
cd "$DST"
export API_TAG=$TAG
# The VPS .env feeds compose interpolation too (REDIS_PASSWORD).
dc() { docker compose --env-file "$ROOT/.env" -f compose.yaml "$@"; }

# 2. Image. Pulled, never built here: the VPS's memory belongs to the running API.
log "pulling"
dc pull --quiet api

# 3. Redis first: the new replicas need it, and --no-deps below skips the wait.
dc up -d --no-deps redis redis-cache
[ "$redis_changed" = 1 ] && { log "redis config changed, restarting redis"; dc restart redis redis-cache; }

# 4. Indexes are a migration (RULES.md §6): create-only and idempotent, so it runs
#    every deploy. A failure (a unique index the data breaks) stops here.
log "indexes"
dc run --rm --no-deps --entrypoint indexes api || die "indexes failed; old release still serving"

# 5. New replicas beside the old ones.
old=$(dc ps -q api || true)
n_old=$(printf '%s\n' "$old" | grep -c . || true)
log "starting $REPLICAS new replica(s) beside $n_old old"
dc up -d --no-deps --no-recreate --scale "api=$((n_old + REPLICAS))" api
new=$(dc ps -q api | grep -vxF -f <(printf '%s\n' "$old" | grep .) || true)
[ -n "$new" ] || die "no new replica was created"

deadline=$((SECONDS + HEALTH_WAIT))
for id in $new; do
  while :; do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo gone)
    [ "$s" = healthy ] && break
    if [ "$s" = unhealthy ] || [ "$s" = gone ] || [ $SECONDS -ge $deadline ]; then
      docker logs --tail 50 "$id" 2>&1 || true
      # shellcheck disable=SC2086
      docker rm -f $new >/dev/null 2>&1 || true
      die "new replica $id is $s; removed the new ones, old release still serving"
    fi
    sleep 2
  done
done
log "new replica(s) healthy"

# 6. Old replicas drain: SIGTERM, in-flight requests finish (shutdownGrace 25 s),
#    Caddy sends new requests to the healthy ones.
if [ -n "$old" ]; then
  # shellcheck disable=SC2086
  docker stop -t 30 $old >/dev/null
  # shellcheck disable=SC2086
  docker rm $old >/dev/null
  log "old replica(s) stopped"
fi

# 7. Caddy: started on the first deploy, recreated if compose changed it, reloaded
#    (no dropped connections) if only the Caddyfile changed.
dc up -d --no-deps caddy
if [ "$caddy_changed" = 1 ]; then
  log "Caddyfile changed, reloading"
  dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi

# 8. Deep health through Caddy (Mongo + Redis pinged). On a first deploy Caddy is
#    still getting its certificate, which outlasted a 30 s loop on 2026-11-09, so the
#    wait is HEALTH_WAIT like the replicas'.
host=$(dc exec -T caddy printenv API_HOST 2>/dev/null | tr -d '\r' || true)
host=${host:-api.hostelpalika.com}
ok=0
deadline=$((SECONDS + HEALTH_WAIT))
while [ $SECONDS -lt "$deadline" ]; do
  if curl -fsS --max-time 5 --resolve "$host:443:127.0.0.1" "https://$host/api/v1/health?deep=1" >/dev/null; then
    ok=1; break
  fi
  sleep 2
done
[ "$ok" = 1 ] || die "deep health through Caddy failed after the roll; roll back: bash $DST/deploy.sh $(head -n1 "$ROOT/deployed.txt" 2>/dev/null || echo '<previous-sha>')"

# 9. Record, then keep only this image and the previous one (rollback) on disk.
prev=$(head -n1 "$ROOT/deployed.txt" 2>/dev/null || true)
[ "$prev" = "$TAG" ] || printf '%s\n%s\n' "$TAG" "$prev" | grep . >"$ROOT/deployed.txt"
repo=${API_IMAGE:-ghcr.io/softmato/hostelpalika-api}
docker images "$repo" --format '{{.Tag}}' | grep -vxF -e "$TAG" -e "${prev:-none}" -e latest \
  | while read -r t; do docker rmi "$repo:$t" >/dev/null 2>&1 || true; done
docker image prune -f >/dev/null
log "done (previous: ${prev:-none})"
