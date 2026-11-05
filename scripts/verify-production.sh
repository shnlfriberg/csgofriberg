#!/usr/bin/env bash
# Disposable Linux production-image acceptance. No host ports, data mounts,
# production secrets, image publishing or shared Redis commands.
set -euo pipefail
image=${1:?Usage: verify-production.sh LOCAL_IMAGE}
root=$(cd "$(dirname "$0")/.." && pwd)
project="soup-release-qa-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
network="$project-net"
assets="$project-assets"
envfile=$(mktemp)
chmod 600 "$envfile"
if command -v cygpath >/dev/null 2>&1; then
  # Docker Desktop expects Windows bind paths, while container paths must stay
  # untouched by Git Bash's automatic argument conversion.
  root=$(cygpath -m "$root")
  envfile=$(cygpath -m "$envfile")
  export MSYS_NO_PATHCONV=1
fi
cleanup() {
  local result=$?
  if [ "$result" -ne 0 ]; then
    for host in "$project-app" "$project-app2"; do
      docker inspect --format '{{json .State}}' "$host" 2>/dev/null || true
    done
    docker logs --tail 100 "$project-app" 2>&1 || true
    docker logs --tail 100 "$project-app2" 2>&1 || true
  fi
  # Remove anonymous image-declared volumes as well as these disposable containers.
  docker rm -fv "$project-app" "$project-app2" "$project-pg" "$project-redis" >/dev/null 2>&1 || true
  docker volume rm "$assets" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$envfile"
}
trap cleanup EXIT
secret=$(openssl rand -hex 32)
cat > "$envfile" <<EOF
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=192
DB_POOL_MIN=0
DB_POOL_MAX=10
PASSWORD_WORKERS=1
POSTGRES_PASSWORD=$secret
DB_CLIENT=pg
DB_URL=postgres://qa:$secret@postgres:5432/soup_release_qa
REDIS_URL=redis://redis:6379
REDIS_PREFIX=soup-release-qa:
REDIS_REQUIRED=true
JWT_SECRET=$(openssl rand -hex 32)
GUEST_ID_SALT=$(openssl rand -hex 32)
TRUST_PROXY=true
CORS_ORIGINS=https://soup-release-qa.invalid
GEETEST_CAPTCHA_ID=release-qa-unconnected
GEETEST_PRIVATE_KEY=$(openssl rand -hex 32)
EOF
# Keep the gate's enforced budgets synchronized with the deployable defaults.
# Only assertions are printed; Compose's resolved environment contains QA secrets.
docker compose --env-file "$envfile" -f "$root/compose.yaml" config --format json | docker run --rm -i "$image" -e '
const assert=require("node:assert/strict"),fs=require("node:fs");
const s=JSON.parse(fs.readFileSync(0,"utf8")).services;
for(const name of ["app-1","app-2"]){
  assert.equal(Number(s[name].mem_limit),512*1024*1024);
  for(const [k,v] of Object.entries({NODE_OPTIONS:"--max-old-space-size=192",DB_POOL_MIN:"0",DB_POOL_MAX:"10",PASSWORD_WORKERS:"1"})) assert.equal(String(s[name].environment[k]),v);
}
for(const [name,mb] of [["migrate",192],["postgres",384],["redis",128]]) assert.equal(Number(s[name].mem_limit),mb*1024*1024);
console.log("PASS production acceptance budgets match Compose defaults");'
docker network create "$network" >/dev/null
docker volume create "$assets" >/dev/null
docker run -d --name "$project-pg" --network "$network" --network-alias postgres \
  --memory 384m --memory-swap 384m \
  -e POSTGRES_USER=qa -e POSTGRES_PASSWORD="$secret" -e POSTGRES_DB=soup_release_qa \
  --tmpfs /var/lib/postgresql/data postgres:17-alpine postgres \
  -c shared_buffers=64MB -c effective_cache_size=256MB -c work_mem=1MB -c maintenance_work_mem=32MB -c max_connections=40 >/dev/null
docker run -d --name "$project-redis" --network "$network" --network-alias redis \
  --memory 128m --memory-swap 128m \
  redis:7.4-alpine redis-server --save '' --appendonly yes --appendfsync everysec --maxmemory 96mb --maxmemory-policy noeviction >/dev/null
for i in $(seq 1 60); do
  if docker exec "$project-pg" pg_isready -U qa -d soup_release_qa >/dev/null 2>&1 && docker exec "$project-redis" redis-cli ping | grep -q PONG; then break; fi
  sleep 1
done
run() {
  local budget=512m
  if [ "${1:-}" = server/dist/db/migrate.js ]; then budget=192m; fi
  docker run --rm --memory "$budget" --memory-swap "$budget" --network "$network" --env-file "$envfile" --mount "type=volume,src=$assets,dst=/app/location-assets" --read-only --tmpfs /tmp:size=16m,mode=1777 \
    --security-opt no-new-privileges --mount "type=bind,src=$root/scripts/verify-production.cjs,dst=/qa/verify-production.cjs,readonly" --mount "type=bind,src=$root/scripts/verify-card-link.cjs,dst=/qa/verify-card-link.cjs,readonly" \
    --mount "type=bind,src=$root/scripts/verify-card-load.cjs,dst=/qa/verify-card-load.cjs,readonly" \
    --mount "type=bind,src=$root/scripts/production-poll.cjs,dst=/qa/production-poll.cjs,readonly" "$image" "$@"
}
run server/dist/db/migrate.js
run /qa/verify-production.cjs legacy
run server/dist/db/migrate.js
run server/dist/db/migrate.js
run /qa/verify-production.cjs migration
run /qa/verify-production.cjs password-reset
docker run -d --name "$project-app" --network "$network" --network-alias app \
  --memory 512m --memory-swap 512m --env-file "$envfile" --mount "type=volume,src=$assets,dst=/app/location-assets" --read-only --tmpfs /tmp:size=16m,mode=1777 --security-opt no-new-privileges "$image" >/dev/null
docker run -d --name "$project-app2" --network "$network" --network-alias app2 \
  --memory 512m --memory-swap 512m --env-file "$envfile" --mount "type=volume,src=$assets,dst=/app/location-assets" --read-only --tmpfs /tmp:size=16m,mode=1777 --security-opt no-new-privileges "$image" >/dev/null
for host in "$project-app" "$project-app2"; do
  for i in $(seq 1 60); do
    if docker exec "$host" /nodejs/bin/node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
    if [ "$i" = 60 ]; then docker logs "$host"; exit 1; fi
    sleep 1
  done
done
run /qa/verify-production.cjs location
run /qa/verify-production.cjs http
run /qa/verify-card-load.cjs
run /qa/verify-card-link.cjs
for host in "$project-app" "$project-app2"; do
  docker exec "$host" /nodejs/bin/node -e '
const assert=require("node:assert/strict"),fs=require("node:fs");
const events=Object.fromEntries(fs.readFileSync("/sys/fs/cgroup/memory.events","utf8").trim().split("\n").map(l=>l.split(" ")));
assert.equal(Number(events.oom_kill),0);assert.equal(Number(events.oom),0);
console.log(JSON.stringify({memoryMax:fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim(),memoryPeak:fs.readFileSync("/sys/fs/cgroup/memory.peak","utf8").trim(),events}));'
done
docker stop "$project-app" >/dev/null
run /qa/verify-card-link.cjs resume

# Service-only benchmark has no sockets. Stop the remaining application so its
# online-presence worker cannot mutate these synthetic players during the run.
docker stop "$project-app2" >/dev/null
# Separate disposable database contents, exercising the service layer under load.
docker run --rm --network "$network" --env-file "$envfile" --read-only --tmpfs /tmp \
  --security-opt no-new-privileges --mount "type=bind,src=$root/server/scripts/benchmark-card-link.cjs,dst=/app/server/scripts/benchmark-card-link.cjs,readonly" \
  "$image" /app/server/scripts/benchmark-card-link.cjs /tmp/card-benchmark.json
echo 'PASS disposable production image acceptance (external GeeTest/SMTP and real TLS edge excluded)'
