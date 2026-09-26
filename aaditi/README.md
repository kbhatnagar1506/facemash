# aaditi · Muse web

When you pass people within a set radius at an event, your **muse** agent starts talking to their agents at the same time. **OpenClaw** monitors every conversation, and **jev** classifies it afterwards. If you have things in common, Muse suggests you meet. It gives a similarity score across thoughts, current career and what you're building, plus a first conversation topic.

This folder is the UI for that: a black, vector-space style web.

```bash
cd aaditi
npm install
npm run dev        # http://localhost:5174
```

## The web (`/`)

- **Center node: you and your data.** A ring of your sources (GitHub, Notes, Posts, Goals, Calendar, Resume, Reading, Past chats) around you. These are the only things muse is allowed to say about you.
- **Every other node is a person whose agent muse talked to.** Distance from you is similarity, like nearest neighbors in a vector space: the closer, the better the match. Color shows jev's call: teal = strong match, indigo = worth meeting, gray = low overlap, amber = agents talking right now, purple = jev classifying.
- **Live:** new people enter the radius (they appear on the outer "not scored yet" orbit), their agent chats with muse (animated amber link), jev scores the chat, and the node glides inward to its similarity distance.
- **Tap a person** and the node expands:
  - the topics you share branch off it, and dashed links show which of *your* sources muse cited to them
  - the panel shows the jev score (overall %, thoughts, current career, what you're building), a **suggested first topic**, and a "Suggest meeting" action
  - the **agent-to-agent chat** (muse ⇄ their agent), where every reply has a **timestamp** and a **one-line source** under it: `↳ from your GitHub · commit 4f68987 …` or `↳ from Ethan's history · …`. If an agent says something with no source, OpenClaw strikes it out and leaves it out of scoring.
- **Tap one of your sources** to see every time muse used it and with whom. Those people light up in the web.
- **Tap "you"** for your sources and a ranked list of matches.
- Drag to pan, scroll or use +/− to zoom, Esc to close. On phones the panel is a bottom sheet.

The people, chats and scores are sample data (`src/muse/data.ts`). Your sources are drawn from this repo's own history (facemash / GT Campus Quest).

Code: `src/muse/`. `data.ts` has the people, scripts and scores, `timeline.ts` sets when replies land and where nodes sit, `Muse.tsx` draws the web and camera, `Panel.tsx` is the expanded node, and `muse.css` the theme.

## `/console`

An earlier multi-tenant terminal console (many agents, many chats, source-verification lines), kept for reference.
