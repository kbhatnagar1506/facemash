#!/bin/bash
# GT Campus Quest game server: the Go WebSocket server behind Caddy (automatic HTTPS).
IMAGE="us-central1-docker.pkg.dev/patchguard-reakon/cloud-run-source-deploy/gt-campus-quest@sha256:e8a03b31ee0a13e81de544d765a8b16898e23c301956da2899fa63ec42e20be4"
HOST="35-188-1-8.sslip.io"
export HOME=/home/chronos
docker-credential-gcr configure-docker --registries us-central1-docker.pkg.dev
mkdir -p /mnt/stateful_partition/gt/data
[ -f /mnt/stateful_partition/gt/geo.json ] || docker cp $(docker create "$IMAGE"):/app/geo.json /mnt/stateful_partition/gt/geo.json
docker network create gt 2>/dev/null || true
docker rm -f game caddy 2>/dev/null || true
# Sign in with Google: the OAuth web client ID lives in instance metadata (google-client-id),
# so it can change without editing this script. Accounts and progress: Cloud SQL facemash-db,
# which only accepts this VM's IP and only over TLS; the app user's password is in
# /mnt/stateful_partition/gt/db.env (root-only; also in Secret Manager: facemash-db-app).
GOOGLE_CLIENT_ID=$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/google-client-id || true)
docker run -d --restart=always --name game --network gt \
  -e ALLOWED_ORIGINS='https://gt-campus-quest*.vercel.app' \
  -e GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  -e DB_HOST=136.65.18.145 -e DB_USER=facemash_app -e DB_NAME=facemash \
  --env-file /mnt/stateful_partition/gt/db.env \
  -e TENANT=hackgt13 -e TENANT_NAME='HackGT 13' \
  -v /mnt/stateful_partition/gt/geo.json:/app/geo.json:ro \
  -v /mnt/stateful_partition/gt/data:/data \
  --ulimit nofile=65536:65536 "$IMAGE" -samples /data/geo_samples.jsonl -session-key /data/session.key
docker run -d --restart=always --name caddy --network gt -p 80:80 -p 443:443 \
  -v caddy_data:/data caddy:2 caddy reverse-proxy --from "$HOST" --to game:8080
