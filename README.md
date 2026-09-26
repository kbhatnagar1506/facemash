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

## Organizer admin API

`/api/admin/*` (see `server/admin.go`) is for organizers only: a signed-in account whose email is listed in
`ADMIN_EMAILS` (comma-separated, case-insensitive), e.g. `ADMIN_EMAILS=krishna@profitwise.app`. Unset or empty: every
admin request is refused (403). The same list lets an organizer start a test agent talk (`/api/talk/encounter`).
Accounts with `@facemash.test` emails are hidden from the admin views unless `?include_test=true`.

Clearing test accounts (dry run by default; only emails ending in `@facemash.test` are ever touched):

```bash
docker exec game /app/server -purge-test-accounts -session-key /data/session.key                 # counts only
docker exec game /app/server -purge-test-accounts -dry-run=false -session-key /data/session.key   # deletes
```

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
