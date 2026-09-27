<p align="center">
  <img src="docs/images/banner.jpg" alt="togethr: two beans chatting at HackGT" width="100%">
</p>

<p align="center">
  <a href="https://www.fasemash.tech"><img alt="Live demo" src="https://img.shields.io/badge/live-fasemash.tech-3B63C4?style=for-the-badge"></a>
  <img alt="HackGT 13" src="https://img.shields.io/badge/HackGT-13-FFB84D?style=for-the-badge">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-5FD0A8?style=for-the-badge"></a>
  <a href="https://github.com/kbhatnagar1506/facemash/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kbhatnagar1506/facemash/ci.yml?branch=main&style=for-the-badge&label=ci"></a>
</p>

<p align="center">
  <img alt="Go" src="https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB">
  <img alt="three.js" src="https://img.shields.io/badge/three.js-000000?logo=threedotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white">
  <img alt="Gemini" src="https://img.shields.io/badge/Gemini-8E75B2?logo=googlegemini&logoColor=white">
  <img alt="ElevenLabs" src="https://img.shields.io/badge/ElevenLabs-000000?logo=elevenlabs&logoColor=white">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-server-5FD0A8">
  <img alt="Google Cloud" src="https://img.shields.io/badge/Google%20Cloud-4285F4?logo=googlecloud&logoColor=white">
</p>

<h3 align="center">Muse already knows you. togethr brings your agent to life, so it can meet everyone for you.</h3>

---

It's 2am in Klaus. You walk right past the one person in the building who fixed your exact bug last spring. Neither of you says a word.

**togethr** turns HackGT into a live, walkable world where every attendee is a jellybean, and every bean carries an AI agent that knows its human. When two beans cross paths, their agents quietly talk. When there's a real reason for the two of you to meet, you're both asked, and names appear only if you both say yes. Then you walk twenty steps and say hi.

<p align="center">
  <img src="docs/images/phones.jpg" alt="The Pokémon-style campus, Bean Studio, a match chat and the memory editor on a phone" width="100%">
</p>

## ✨ What it does

| | |
|---|---|
| 📱 **Connect in under 5 seconds** | Scan your QR and your Meta Muse agent joins through our MCP server. Or answer five questions out loud, hands-free. |
| 🫘 **Your agent becomes your bean** | jev picks your outfit from your memory, and your phone's own steps and compass move you through the real Klaus atrium. |
| 💬 **Agents talk when you pass** | 3 m for 3 s starts a private agent conversation: 20+ questions, about projects *and* people. |
| 🎯 **A model decides if you should meet** | 8 signals, then 5 scores. 55% and up asks you both. Most talks end with a friendly goodbye. |
| 🤝 **Mutual yes, then real life** | Names show only after two yeses, with an icebreaker that names the exact thing you share. |
| 🔥 **The chat stays warm** | Your agents post updates when one of you has news, and nudge you when you're both nearby. |
| 🌱 **Never an empty room** | 55 AI attendees with their own memories hack at the tables, jog around campus and bike down the paths. |
| 🔒 **Private by design** | No public profile. Your agent discloses to one person at a time, and every sentence it says is checked against your own memory. |

## 🎮 See it

| The campus is a Pokémon route | Klaus atrium, rebuilt from photos |
|---|---|
| ![Pokémon-style Georgia Tech campus](docs/images/campus.jpg) | ![The HackGT hall with AI attendees at the tables](docs/images/hall.jpg) |
| **Watch two agents talk, line by line** | **Every talk at the event, live** |
| ![An agent talk in the organizer console; the guard withholds a phone number](docs/images/agent-talk.jpg) | ![The organizer console's connection graph](docs/images/admin-graph.jpg) |

<sub>The console shots use the built-in demo data (`/admin?mock=1`), not real attendees.</sub>

## 🧠 How a connection happens

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant A as Your agent (Muse)
    participant T as togethr
    participant J as jev (decides)
    participant G as Gemini (talks)
    actor Them

    You->>A: scan your QR (under 5 s)
    A->>T: memory in over MCP, secrets scrubbed
    T->>J: pick an outfit from memory
    Note over You,Them: your beans stand within 3 m for 3 s
    loop 20+ questions, about 20 seconds
        T->>J: both briefs + transcript + where your memories overlap
        J-->>T: next question (under 1.5 s, while the last answer streams)
        T->>G: answer only from this person's memory
        G-->>T: streamed line
        T->>T: guard: cut anything not traced to memory
    end
    T->>J: 8 signals, then 5 scores
    J-->>T: 55%+ is a match
    T->>You: want to meet them?
    T->>Them: want to meet them?
    You-->>T: yes
    Them-->>T: yes
    T->>You: name + an icebreaker about what you share
    You->>Them: walk over and say hi 👋
```

## 🤖 Gemini talks. jev decides.

Nothing you see is chosen by a human. **jev** (TypeSafe's System One) returns only *typed* answers: a choice with probabilities, a yes/no probability, or a score on a rubric. **Gemini** speaks for each human, only from that human's memory.

| Moment | What the AI decides |
|---|---|
| You arrive | your bean's outfit, from your memory |
| Every turn | the next question, from the 60 best of 250 for these two people |
| After 20 questions | is there a reason to meet: you solved their problem, they solved yours, same problem, good team, a rare shared interest, a shared experience, or red flags (one-sided, busy) |
| The verdict | value to each of you, urgency, would you keep talking, depth |
| After the match | the icebreaker and the updates that keep your chat alive |

A signal fires when jev is confident enough, and two people match when the average of jev's five scores (each out of 5) clears 55%:

$$P(\text{signal}) \ge 0.6 \qquad\qquad \text{match} \iff \frac{v_{\text{you}} + v_{\text{them}} + \text{urgency} + \text{again} + \text{depth}}{25} \ge 0.55$$

Your bean moves when you move. A Kalman filter weighs each GPS fix by its accuracy, and between fixes your steps carry you along the compass heading, with stride $\ell$ and heading $\theta$ learned as you walk:

$$K = \frac{P}{P + \sigma_{\text{gps}}^{2}}, \qquad \hat{\mathbf{x}} \leftarrow \hat{\mathbf{x}} + K\,(\mathbf{z} - \hat{\mathbf{x}}), \qquad \mathbf{x}_{t+1} = \mathbf{x}_t + \ell\,(\sin\theta_t,\ \cos\theta_t)$$

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph Edge
        P(["Players' phones"]):::edge
        M([Meta Muse agents]):::edge
        V([Vercel: React + three.js]):::edge
    end
    subgraph Go["Go server · Google Cloud"]
        H[Game hub<br/>15 Hz · 13-byte frames]:::srv
        N[55 NPC brains<br/>10 Hz]:::srv
        X[Proximity<br/>3 m · 3 s]:::srv
        E[Talk engine<br/>pipelined]:::srv
        GU[Guard]:::srv
        C[Chats]:::srv
        MCP[MCP + REST<br/>connector]:::srv
    end
    subgraph Models
        J{{jev}}:::model
        G{{Gemini}}:::model
        EL{{ElevenLabs}}:::model
    end
    subgraph Data
        PG[(Postgres)]:::data
        MA[(MAPI<br/>private memory)]:::data
    end
    V --> P
    P <--> H
    N --> H
    H --> X --> E
    E <--> J
    E <--> G
    G --> GU --> E
    E --> C
    M --> MCP --> PG
    P <--> EL
    PG --> MA
    MA -. overlap topics .-> J
    classDef edge fill:#1a2036,stroke:#6F84C9,color:#eef1f8
    classDef srv fill:#1c2336,stroke:#8FAEFF,color:#eef1f8
    classDef model fill:#2a2110,stroke:#FFB84D,color:#eef1f8
    classDef data fill:#10231d,stroke:#5FD0A8,color:#eef1f8
```

The full tour is in [**docs/architecture.md**](docs/architecture.md).

## 📊 By the numbers

| | |
|---|---|
| Connect your Muse | **< 5 s**, one QR scan |
| Your bean finds you | **3.5 s** on average |
| One agent conversation | **60+ lines in ~20 s** |
| Next question picked | **< 1.5 s**, while the last answer streams |
| Question bank | **250**, rewritten to sound like a person texting |
| Position updates | **13 bytes** per player, 15× a second, within 90 m |
| AI attendees | **55**, always on |
| Campus ground drawn per frame | **−59%** after streaming it by distance |
| Real people tested | **20+** |

## 🚀 Run it yourself

One command, everything in memory, nothing in the cloud:

```bash
scripts/local.sh                 # builds the site and serves it all on http://localhost:8080
```

Sign in at `http://localhost:8080/api/dev/login?email=you@local.test&next=/play`. A private window with another email is player 2, and `admin@local.test` opens `/admin`. Agent talks and voice switch on when `~/.facemash/gemini.key`, `jev.key` and `elevenlabs.key` exist. Keys live outside the repo, always.

<details>
<summary><b>Develop with hot reload</b></summary>

```bash
cd server && go run . -dev-login               # :8080
cd client && npm install && npm run dev        # :5173, proxies /ws and /api to :8080
```

Production is one port: `cd client && npm run build`, then `cd server && go run . -addr :8080` serves `client/dist`, `/ws` and `/api`.
</details>

<details>
<summary><b>Tests</b></summary>

```bash
cd server && go test ./...                     # set FASTPG_DSN to also run the Postgres tests
cd client && npx tsc -b --noEmit && npm run build
```

`go run . -talk-sim` runs a whole agent talk between fictional people against the live models and prints the timeline with p50/p95 timings.
</details>

<details>
<summary><b>Deploy</b></summary>

See [**docs/deploy.md**](docs/deploy.md) for the container build, the VM and which keys go where.
</details>

## 🗂️ Repo map

```
client/                React + three.js game and site
  src/World.tsx          streamed Pokémon-style campus
  src/overworld.tsx      trees, tall grass, flowers, wind (shaders)
  src/hall/              the Klaus atrium, rebuilt from photos
  src/talk/              the agent-talk overlay on your phone
  src/aaditi/            the organizer console (/admin)
  src/Chat.tsx           /chats: your matches
  src/Settings.tsx       /settings: everything your agent knows
server/                Go game server and APIs
  agenttalk*.go          proximity, the talk loop, the guard, the verdict
  talkdata/              questions, config, NPC personas, walk maps
  muse.go                MCP + REST connector for Muse agents
  memfast.go             MAPI memory sync and search
  npcs.go, npc_move.go   the 55 AI attendees
  connections.go         match chats and agent updates
scripts/               map builders and the one-command local run
docs/                  architecture, deploy, images
```

## 🙏 Credits

Built at **HackGT 13** at Georgia Tech. Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). HackGT artwork in `client/public/hackgt/` is from [hack.gt](https://hack.gt) and used for our HackGT 13 project. Powered by [Gemini](https://ai.google.dev), [jev](https://typesafe.ai) by TypeSafe, [ElevenLabs](https://elevenlabs.io) and Meta's Muse.

## 📄 License

The code is [MIT](LICENSE). The HackGT artwork and OpenStreetMap data keep their own terms (see Credits).

<p align="center"><b>Look left. Table 14.</b></p>
