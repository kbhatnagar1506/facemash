#!/bin/bash
# GT Campus Quest game server: the Go WebSocket server behind Caddy (automatic HTTPS).
IMAGE="us-central1-docker.pkg.dev/patchguard-reakon/cloud-run-source-deploy/gt-campus-quest@sha256:1ffdc5f4a4709cf318e0429bb7b935f1fe5b51cadb77939af0ee35c727dc4691"
HOST="35-188-1-8.sslip.io"
export HOME=/home/chronos
docker-credential-gcr configure-docker --registries us-central1-docker.pkg.dev
mkdir -p /mnt/stateful_partition/gt/data
[ -f /mnt/stateful_partition/gt/geo.json ] || docker cp $(docker create "$IMAGE"):/app/geo.json /mnt/stateful_partition/gt/geo.json
docker network create gt 2>/dev/null || true
docker rm -f game caddy 2>/dev/null || true
# Sign in with Google: the OAuth web client ID lives in instance metadata (google-client-id),
# so it can change without editing this script. Accounts and progress: Cloud SQL facemash-db,
# reached through the Cloud SQL connector as the VM's own service account (IAM database
# auth: no password, no allow-listed IPs).
# Until the VM's account can log in to Cloud SQL itself, db.env (root-only) can hold a direct
# connection instead (DB_HOST/DB_USER/DB_PASSWORD, TLS); the server prefers it when present.
DBENV=""
[ -f /mnt/stateful_partition/gt/db.env ] && DBENV="--env-file /mnt/stateful_partition/gt/db.env"
GOOGLE_CLIENT_ID=$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/google-client-id || true)
docker run -d --restart=always --name game --network gt \
  -e ALLOWED_ORIGINS='https://gt-campus-quest*.vercel.app' \
  -e GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  -e DB_INSTANCE='patchguard-reakon:us-central1:facemash-db' -e DB_NAME=facemash \
  -e DB_IAM_USER='751583582765-compute@developer' $DBENV \
  -e TENANT=hackgt13 -e TENANT_NAME='HackGT 13' \
  -v /mnt/stateful_partition/gt/geo.json:/app/geo.json:ro \
  -v /mnt/stateful_partition/gt/data:/data \
  --ulimit nofile=65536:65536 "$IMAGE" -samples /data/geo_samples.jsonl -session-key /data/session.key
docker run -d --restart=always --name caddy --network gt -p 80:80 -p 443:443 \
  -v caddy_data:/data caddy:2 caddy reverse-proxy --from "$HOST" --to game:8080
