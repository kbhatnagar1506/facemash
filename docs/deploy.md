# Deploying togethr

togethr is two pieces:

- **The site** (`client/`) is a static Vite build. Vercel deploys `main` automatically.
- **The game server** (`server/`) is one Go binary in a container on a Google Compute Engine VM (`gt-campus-quest`). It serves the WebSocket game, every `/api/*` endpoint, and, if you want one port, the built client too.

## Build and ship the server

```bash
# 1. build the image
gcloud builds submit server/ \
  --tag us-central1-docker.pkg.dev/patchguard-reakon/cloud-run-source-deploy/gt-campus-quest

# 2. pin the digest it prints in server/vm-startup.sh (the IMAGE= line), commit it

# 3. hand the VM the new startup script
gcloud compute instances add-metadata gt-campus-quest \
  --metadata-from-file startup-script=server/vm-startup.sh

# 4. restart the container with it
gcloud compute ssh gt-campus-quest -- sudo google_metadata_script_runner startup
```

## What the VM needs

Everything lives under `/mnt/stateful_partition/gt/`, owned by root, mode `0600`. `server/vm-startup.sh` wires it into the container.

| File | What | How the container gets it |
|---|---|---|
| `db.env` | Cloud SQL connection (accounts, talks, briefs, chats) | `--env-file` |
| `gemini-game.key` | Gemini API key locked to the VM's IP (just the key) | mounted read-only at `/secrets/gemini-game.key`, `GEMINI_API_KEY_FILE` points there |
| `jev.env` | `JEV_API_KEY=...` | `--env-file` |
| `talk.env` (optional) | `ADMIN_EMAILS=a@x,b@y`, `TALK_HOST_EMAIL`, `TALK_CONFIG_FILE` | `--env-file` when present |
| `mapi-client.env` (optional) | `MAPI_READ_URL`, `MAPI_WRITE_URL`, the tenant key | `--env-file` when present |
| `elevenlabs-backup.key` + `voice.env` | voice onboarding (key, and `ELEVENLABS_AGENT_ID_BACKUP`) | key mounted read-only at `/secrets/elevenlabs-backup.key`; `voice.env` via `--env-file` |

Without the Gemini or jev key, agent talk switches off and the rest of the game runs unchanged. Tables are created on start.

## Useful switches

| Env / flag | Effect |
|---|---|
| `NPCS=off` | no AI attendees |
| `ADMIN_EMAILS` | who can open `/admin` and set the Shift+R reference point |
| `TALK_HOST_EMAIL` | whose agent greets every new player (defaults to the first admin) |
| `ALLOWED_ORIGINS` | when the page and the server are on different origins |
| `-dev-login` | `/api/dev/login?email=...` sign-in, localhost only |
| `-dev-talk` | start a talk on demand from localhost |
| `-talk-sim` | run a whole talk between fictional people against the live models and print the timeline with timings |

## Never commit

API keys, service-account keys and `.env` files. `scripts/local.sh` reads local keys from `~/.facemash/*.key`, outside the repo.
