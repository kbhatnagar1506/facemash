#!/bin/bash
# GT Campus Quest game server: the Go WebSocket server behind Caddy (automatic HTTPS).
IMAGE="us-central1-docker.pkg.dev/patchguard-reakon/cloud-run-source-deploy/gt-campus-quest@sha256:1ac92bb59bd308db4baa32486e9553580f5bda4f41ee2fd9d6ec003c56d9be0e"
HOST="35-188-1-8.sslip.io"
export HOME=/home/chronos
docker-credential-gcr configure-docker --registries us-central1-docker.pkg.dev
mkdir -p /mnt/stateful_partition/gt/data
[ -f /mnt/stateful_partition/gt/geo.json ] || docker cp $(docker create "$IMAGE"):/app/geo.json /mnt/stateful_partition/gt/geo.json
docker network create gt 2>/dev/null || true
docker rm -f game caddy 2>/dev/null || true
docker run -d --restart=always --name game --network gt \
  -e ALLOWED_ORIGINS='https://gt-campus-quest*.vercel.app' \
  -v /mnt/stateful_partition/gt/geo.json:/app/geo.json:ro \
  -v /mnt/stateful_partition/gt/data:/data \
  --ulimit nofile=65536:65536 "$IMAGE" -samples /data/geo_samples.jsonl
docker run -d --restart=always --name caddy --network gt -p 80:80 -p 443:443 \
  -v caddy_data:/data caddy:2 caddy reverse-proxy --from "$HOST" --to game:8080
