#!/bin/bash
# GT Campus Quest game server: the Go WebSocket server behind Caddy (automatic HTTPS).
IMAGE="us-central1-docker.pkg.dev/patchguard-reakon/cloud-run-source-deploy/gt-campus-quest@sha256:2aecadb7d0262c5e2a2249fa9e58246ed398b4e11f81e4c825887a4ac143a1ce"
HOST="35-188-1-8.sslip.io"
export HOME=/home/chronos
docker-credential-gcr configure-docker --registries us-central1-docker.pkg.dev
mkdir -p /mnt/stateful_partition/gt/data
[ -f /mnt/stateful_partition/gt/geo.json ] || docker cp $(docker create "$IMAGE"):/app/geo.json /mnt/stateful_partition/gt/geo.json
docker network create gt 2>/dev/null || true
# Nothing on network gt (the game, Caddy) needs the metadata server: the game reaches Postgres
# with DB_HOST/DB_PASSWORD from db.env, and MAPI and jev with keys. So an attacker inside either
# container can't mint a token for the VM's service account. DOCKER-USER sends gt's subnet to
# GT-NO-METADATA, which rejects 169.254.0.0/16 except DNS (Docker's embedded DNS forwards to
# 169.254.169.254:53 from the container's namespace). Rules don't survive a reboot, while
# dockerd restarts --restart=always containers before this script runs, so both containers
# bind-mount GUARD, a directory on tmpfs /run made only once the rules are in: after a reboot
# they can't start until this script has put the block back and recreated them.
GUARD=/run/gt-metadata-guard
GT_SUBNET=$(docker network inspect gt -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
nometa() { iptables -w -C GT-NO-METADATA "$@" 2>/dev/null || iptables -w -A GT-NO-METADATA "$@"; }
block_metadata() {
  [ -n "$GT_SUBNET" ] || return 1
  iptables -w -N GT-NO-METADATA 2>/dev/null || true
  nometa -d 169.254.169.254/32 -p udp --dport 53 -j RETURN || return 1
  nometa -d 169.254.169.254/32 -p tcp --dport 53 -j RETURN || return 1
  nometa -d 169.254.0.0/16 -j REJECT --reject-with icmp-port-unreachable || return 1
  iptables -w -C DOCKER-USER -s "$GT_SUBNET" -j GT-NO-METADATA 2>/dev/null ||
    iptables -w -I DOCKER-USER 1 -s "$GT_SUBNET" -j GT-NO-METADATA || return 1
  mkdir -p "$GUARD"
}
if ! block_metadata; then
  # Keep the game up: a failed block is logged, and the containers run without the guard.
  echo "vm-startup: could not block the metadata server for network gt ($GT_SUBNET)"
  GUARDMOUNT=""
else
  GUARDMOUNT="--mount type=bind,source=$GUARD,target=/run/metadata-guard,readonly"
fi
docker rm -f game caddy 2>/dev/null || true
# Sign in with Google: the OAuth web client ID lives in instance metadata (google-client-id),
# so it can change without editing this script. Accounts and progress: Cloud SQL facemash-db,
# which only accepts this VM's IP and only over TLS, as facemash_app; the connection
# (DB_HOST/DB_USER/DB_PASSWORD) is in db.env, root-only (password also in Secret Manager:
# facemash-db-app). Without db.env the server tries IAM auth as the VM's service account.
DBENV=""
[ -f /mnt/stateful_partition/gt/db.env ] && DBENV="--env-file /mnt/stateful_partition/gt/db.env"
# Attendees' memory index (MAPI on facemash-mapi): MAPI_READ_URL and MAPI_WRITE_URL in mapi-client.env,
# and the tenant's key in its own root-only file, mounted read-only at /secrets and named by
# MAPI_KEY_FILE_hackgt13 (so it's in no container's environment, docker inspect or /proc).
# A key still in the env file is moved into that file here, never printed. Without
# mapi-client.env the feature is off and the server behaves as before.
MAPIENV=""
MAPIKEY=/mnt/stateful_partition/gt/mapi-key-hackgt13
if [ -f /mnt/stateful_partition/gt/mapi-client.env ]; then
  ENVF=/mnt/stateful_partition/gt/mapi-client.env
  if grep -q '^MAPI_KEY_hackgt13=' "$ENVF"; then
    (umask 077 && sed -n 's/^MAPI_KEY_hackgt13=//p' "$ENVF" | tr -d '\n' > "$MAPIKEY.new" && mv "$MAPIKEY.new" "$MAPIKEY") &&
      sed -i '/^MAPI_KEY_hackgt13=/d' "$ENVF"
  fi
  grep -q '^MAPI_KEY_FILE_hackgt13=' "$ENVF" || echo 'MAPI_KEY_FILE_hackgt13=/secrets/mapi-key-hackgt13' >> "$ENVF"
  chown root:root "$ENVF" "$MAPIKEY" 2>/dev/null; chmod 600 "$ENVF" "$MAPIKEY" 2>/dev/null
  MAPIENV="--env-file $ENVF"
  [ -f "$MAPIKEY" ] && MAPIENV="$MAPIENV --mount type=bind,source=$MAPIKEY,target=/secrets/mapi-key-hackgt13,readonly"
fi
# jev (TypeSafe) picks outfits from agent memory: JEV_API_KEY in jev.env (root 0600)
JEVENV=""
[ -f /mnt/stateful_partition/gt/jev.env ] && JEVENV="--env-file /mnt/stateful_partition/gt/jev.env"
# Agent talk (two opted-in attendees within 3 m for 3 s: their agents chat, jev judges, names
# only after both say yes). Needs jev (jev.env above) and Gemini: the key locked to this VM's
# IP in gemini-game.key (root 0600), mounted read-only and named by GEMINI_API_KEY_FILE, so it
# is in no container's environment. Optional talk.env for extra knobs (ADMIN_EMAILS for the
# admin test trigger, TALK_CONFIG_FILE). Without the key file, agent talk is off and the
# server behaves as before (the opt-in switch still saves).
TALKENV=""
TALKKEY=/mnt/stateful_partition/gt/gemini-game.key
if [ -f "$TALKKEY" ]; then
  chown root:root "$TALKKEY" 2>/dev/null; chmod 600 "$TALKKEY" 2>/dev/null
  TALKENV="-e GEMINI_API_KEY_FILE=/secrets/gemini-game.key --mount type=bind,source=$TALKKEY,target=/secrets/gemini-game.key,readonly"
fi
[ -f /mnt/stateful_partition/gt/talk.env ] && TALKENV="$TALKENV --env-file /mnt/stateful_partition/gt/talk.env"
GOOGLE_CLIENT_ID=$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/google-client-id || true)
# --memory: one big upload can't take the VM (Caddy and dockerd keep theirs); GOMEMLIMIT makes
# the Go GC work harder well before that limit.
docker run -d --restart=always --name game --network gt $GUARDMOUNT \
  --memory=1200m -e GOMEMLIMIT=900MiB \
  -e DIRECT_URL="https://$HOST" -e ALLOWED_ORIGINS='https://gt-campus-quest*.vercel.app,https://fasemash.tech,https://www.fasemash.tech' \
  -e GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  -e DB_INSTANCE='patchguard-reakon:us-central1:facemash-db' -e DB_NAME=facemash \
  -e DB_IAM_USER='751583582765-compute@developer' $DBENV $MAPIENV $JEVENV $TALKENV \
  -e TENANT=hackgt13 -e TENANT_NAME='HackGT 13' \
  -v /mnt/stateful_partition/gt/geo.json:/app/geo.json:ro \
  -v /mnt/stateful_partition/gt/data:/data \
  --ulimit nofile=65536:65536 "$IMAGE" -samples /data/geo_samples.jsonl -session-key /data/session.key
docker run -d --restart=always --name caddy --network gt $GUARDMOUNT -p 80:80 -p 443:443 \
  -v caddy_data:/data caddy:2 caddy reverse-proxy --from "$HOST" --to game:8080
