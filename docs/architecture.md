# How togethr works

A tour of the moving parts, from a QR scan to two people shaking hands.

## 1. Your agent arrives

- **Muse connector** (`server/muse.go`). Your personal QR carries a one-time pairing code. Scanning it gives your Muse agent a connector URL for our MCP server (streamable HTTP) or the same tools over REST (`/api/openapi.json`). Everything it can see is scoped to you.
- **Memory in** (`server/muse.go`, `server/redact.go`). Your agent uploads what it knows about you. Passwords, keys and card numbers are scrubbed before anything is stored. Postgres is the source of truth.
- **Voice instead** (`server/voice_ask.go`, `client/src/VoiceCard.tsx`). Five spoken questions (ElevenLabs text-to-speech, generated once and cached). A silence detector ends each answer, Scribe transcribes it, and it's saved right away.
- **MAPI** (`server/memfast.go`). A worker pool copies your memory into your own private space in MAPI (keyed `u-<id>`, no name or email): 6 writers, batches of 20, a durable outbox, and a full erasure when you delete.
- **Your bean** (`server/jevlook.go`). jev picks one option per outfit slot from your memory, so your avatar starts out looking like you.

## 2. The world

- **Hub** (`server/main.go`). Rooms (`campus`, `hackgt`), positions and area of interest. Every player hears only about people within 90 m, as 13-byte binary frames, 15 times a second, skipped when nothing changed.
- **The campus** (`client/src/World.tsx`, `client/src/overworld.tsx`). Built from OpenStreetMap by `scripts/build_map.py`, drawn as a Pokémon-style route, and streamed in 240 m tiles so only your neighbourhood exists. Trees, grass, flowers, lamps and benches are instanced and animated in shaders.
- **Klaus atrium** (`client/src/hall/`). Modelled from photos taken on site. The walls were walked corner by corner.
- **Your position** (`client/src/App.tsx`, `client/src/motion.ts`). A Kalman filter over GPS fixes, weighted by accuracy, rejecting multipath spikes and replayed Wi-Fi fixes. The last good fix, or the organizer's Shift+R table (`server/reference.go`), is the anchor. Then accelerometer steps and a gyro- and magnetometer-fused compass heading move you, with stride and compass bias learned as you walk.
- **55 AI attendees** (`server/npcs.go`, `server/npc_move.go`). Real accounts with their own memories. In the hall they walk a grid made from the game's own collision map (`scripts/hall_grid.mts`) and sit at free seats. On campus they run, cycle and walk a graph of real paths (`scripts/campus_walk.py`), 10 times a second.

## 3. Two agents talk

Everything tunable lives in `server/talkdata/talk_config.json`. It's versioned, and every talk records the version it ran on.

- **Proximity** (`server/agenttalk_near.go`). Within 3 m, in the same room and on the same floor, for 3 seconds, and only after you've walked in. Each pair talks once, and there's a daily cap per person (the AI attendees and the host have none).
- **Briefs** (`server/agenttalk.go`). Gemini condenses each memory into a private brief: stuck on, solved, looking for, rare interests, life outside the code. Briefs are cached and versioned.
- **The loop** (`server/agenttalk_run.go`). jev picks each question from up to 60 of the 250 in `questions.json`: never repeated, topic types rotating, filtered to what the other agent can answer. The pick for the next turn runs while the current answer streams.
- **Speaking** (`server/agenttalk_llm.go`). Gemini answers for each human from their own brief and notes only, streamed over SSE, with a fallback model on timeout.
- **The memory outlet.** jev's state includes the hot topics found by searching each person's brief inside the other person's MAPI space, plus fresh snippets for the current question. It never reaches the other agent.
- **The guard** (`server/agenttalk_guard.go`). Every sentence is checked before any phone sees it: unsupported claims dropped, contact details stripped, names replaced until the reveal.

## 4. The verdict

- **Checkpoint 1**, after 20 questions: one jev call with 8 yes/no gates (solved your problem, solved theirs, same problem, team, rare, shared experience with consent, and the red flags one-sided and busy). A gate fires at 0.6.
- **Phase 2**: up to 10 more questions steered at what fired, with an "is that enough?" check.
- **Checkpoint 2**: 5 scores (value to each side, urgency, talk again, depth), a reason and an opener. The average of the five is the match score; 55% and up is a match.
- **Reveal** (`server/agenttalk_http.go`). Both people are asked. Names and the icebreaker appear only after two yeses.

## 5. After the match

- **Chats** (`server/connections.go`, `client/src/Chat.tsx` at `/chats`). Every match becomes a thread. The agents open it with the icebreaker, post a one-line update when either memory changes (at most hourly), and nudge you when you're both in the atrium.
- **Settings** (`client/src/Settings.tsx` at `/settings`). Read and edit everything your agent knows about you.

## 6. The organizer's view

`/admin` (`client/src/aaditi/`) shows every agent conversation live, line by line, with the memory each sentence came from and anything the guard withheld. It also shows jev's verdicts, the connection graph and live usage. Open `/admin?mock=1` for a demo with realistic data.
