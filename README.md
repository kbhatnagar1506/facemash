# GT Campus Quest

A 3D, Pokémon-style multiplayer walk around the whole Georgia Tech campus.
The golden beacon over the **Klaus Advanced Computing Building** marks **HackGT 13**. Every real Klaus door (from OSM) has a glowing shell. Click it, or walk up and press **E**, to open the Seaside Market welcome screen. Hit **Register** to walk into the **Klaus atrium**, a separate multiplayer room rebuilt from on-site photos (see `client/src/hall/`): the checkerboard back wall, the glass stair you can climb to the 2nd-floor balcony, sponsor booths, the photo-booth boat (press E for a flash), hanging seagulls and bunting, 10 hacking tables, and an animated crowd. A live "Now / Next" board follows the real schedule, and the shell by the doors takes you back to campus.

HackGT artwork (`client/public/hackgt/`) is from hack.gt and used for our HackGT 13 project.

- `client/`: React + three.js (@react-three/fiber). Toon-shaded buildings extruded from real OpenStreetMap footprints, a minimap, a location sign, chat, and a cutaway that shows you behind buildings.
- `server/`: Go WebSocket server (gorilla/websocket). Relays positions at 15 Hz, handles chat, rejects teleports, and serves the built client.
- `scripts/build_map.py`: turns `data/osm.json` (Overpass export, query in `scripts/query.overpassql`) into `client/public/campus.json`.

## Run (dev)

```bash
cd server && go run .                 # :8080
cd client && npm install && npm run dev   # :5173, proxies /ws and /api to :8080
```

## Run (prod, one port)

```bash
cd client && npm run build
cd server && go run . -addr :8080     # serves ../client/dist + /ws + /api
```

Set `ALLOWED_ORIGINS=https://your.domain` if the page and server are on different origins.

## Agent talk

Two signed-in players who both switched on "Let my agent talk to people nearby" (game HUD,
`POST /api/talk/optin {"on":true}`, off by default, only from the app with the session
cookie) and stand within 3 m in the same room for 3 s: their agents chat, jev judges, and
names come out only if both tap "Meet them". At most 5 talks per person per event day, and a
pair talks once per event. Knobs: `server/talkdata/talk_config.json` (`proximity`, `limits`).

What the game VM needs (`server/vm-startup.sh` wires it; everything under
`/mnt/stateful_partition/gt/`, root 0600):

| File | What | How the container gets it |
|---|---|---|
| `gemini-game.key` | Gemini API key locked to the VM's IP (just the key) | mounted read-only at `/secrets/gemini-game.key`, `GEMINI_API_KEY_FILE` points there |
| `jev.env` (exists) | `JEV_API_KEY=...` | `--env-file` |
| `talk.env` (optional) | `ADMIN_EMAILS=a@x,b@y` (admin-only test trigger), `TALK_CONFIG_FILE` | `--env-file` when present |

Without `gemini-game.key` (or jev) agent talk is off and the game is unchanged; the switch
still saves. Accounts (Cloud SQL, `db.env`) are required: the talks, prefs and briefs live in
the same database (tables created at start). Briefs come from each person's uploaded memory,
plus their MAPI space when `mapi-client.env` is set.

Local: `GEMINI_API_KEY_FILE=... JEV_API_KEY_FILE=... go run . -dev-login -dev-talk -static ../client/dist`
(`-talk-sim` runs a whole talk between fictional people with the live models and prints the timeline).

## Edit the HackGT card

`server/event.json` is re-read on every request. Update `when`, `schedule`, etc. without restarting.

## Controls

WASD/arrows move · Shift run · B bike · M big map · Enter chat · scroll to zoom · E at Klaus for HackGT

## Refresh the map

```bash
curl -s https://overpass-api.de/api/interpreter --data-urlencode "data=$(cat scripts/query.overpassql)" -o data/osm.json
python3 scripts/build_map.py
```

Map data © OpenStreetMap contributors (ODbL).
