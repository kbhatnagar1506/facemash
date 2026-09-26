#!/bin/bash
# GT Campus Quest game server: the Go WebSocket server behind Caddy (automatic HTTPS).
IMAGE="us-central1-docker.pkg.dev/patchguard-reakon/cloud-run-source-deploy/gt-campus-quest@sha256:4b7060ad126f2c83211410a52011db96e3a36d2536536339d09d7e1c7266091f"
HOST="35-188-1-8.sslip.io"
export HOME=/home/chronos
docker-credential-gcr configure-docker --registries us-central1-docker.pkg.dev
mkdir -p /mnt/stateful_partition/gt/data
[ -f /mnt/stateful_partition/gt/geo.json ] || docker cp $(docker create "$IMAGE"):/app/geo.json /mnt/stateful_partition/gt/geo.json
docker network create gt 2>/dev/null || true
docker rm -f game caddy 2>/dev/null || true
# Sign in with Google: the OAuth web client ID lives in instance metadata (google-client-id),
# so it can change without editing this script. Accounts and progress: Cloud SQL facemash-db,
# which only accepts this VM's IP and only over TLS, as facemash_app; the connection
# (DB_HOST/DB_USER/DB_PASSWORD) is in db.env, root-only (password also in Secret Manager:
# facemash-db-app). Without db.env the server tries IAM auth as the VM's service account.
DBENV=""
[ -f /mnt/stateful_partition/gt/db.env ] && DBENV="--env-file /mnt/stateful_partition/gt/db.env"
# Attendees' memory index (MAPI on facemash-mapi): MAPI_READ_URL, MAPI_WRITE_URL and the tenant's key
# (MAPI_KEY_hackgt13, or MAPI_KEY_FILE_hackgt13 naming a file under /data) in mapi-client.env,
# root-only. Without it the feature is off and the server behaves as before.
MAPIENV=""
[ -f /mnt/stateful_partition/gt/mapi-client.env ] && MAPIENV="--env-file /mnt/stateful_partition/gt/mapi-client.env"
GOOGLE_CLIENT_ID=$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/google-client-id || true)
docker run -d --restart=always --name game --network gt \
  -e DIRECT_URL="https://$HOST" -e ALLOWED_ORIGINS='https://gt-campus-quest*.vercel.app,https://fasemash.tech,https://www.fasemash.tech' \
  -e GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  -e DB_INSTANCE='patchguard-reakon:us-central1:facemash-db' -e DB_NAME=facemash \
  -e DB_IAM_USER='751583582765-compute@developer' $DBENV $MAPIENV \
  -e TENANT=hackgt13 -e TENANT_NAME='HackGT 13' \
  -v /mnt/stateful_partition/gt/geo.json:/app/geo.json:ro \
  -v /mnt/stateful_partition/gt/data:/data \
  --ulimit nofile=65536:65536 "$IMAGE" -samples /data/geo_samples.jsonl -session-key /data/session.key
docker run -d --restart=always --name caddy --network gt -p 80:80 -p 443:443 \
  -v caddy_data:/data caddy:2 caddy reverse-proxy --from "$HOST" --to game:8080
