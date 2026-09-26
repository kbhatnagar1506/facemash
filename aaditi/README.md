# aaditi · Muse admin

**Muse:** when you pass people within a set radius at an event, your muse agent starts talking to their agents at the same time. **OpenClaw** monitors every conversation and **jev** classifies it. If you have things in common, the platform suggests you meet, with a similarity % (thoughts, current career, what you're building) and a first conversation topic.

```bash
cd aaditi
npm install
npm run dev        # http://localhost:5174
```

## `/`: admin architecture wireframe (black)

- **Center hub:** (1) lifetime users to date, (2) hours of activity to date (ticks live), (3) active users now. Plus live chats, claims OpenClaw withheld, and chats jev has scored.
- **Every lifetime user** connects to the hub. **White box = active now, grey = inactive.** Each box shows the name, role, what they're building, the event they're at (or were last at), hours to date and chats today.
- **Active user → chat box → other account:** each live agent-to-agent conversation sits between the two users it connects, with arrows in from one side and out to the other. Inside:
  - every reply has a **timestamp** and a **one-line source**: `↳ from Ethan's history · GitHub · server/README.md`
  - when the agents finish, jev classifies: **MATCH %**, thoughts / career / building bars, and a **first topic**
- A user can be in several chats at once (Ethan, Hana).
- Drag to pan, scroll or −/+ to zoom, ⤢ zooms to a chat, "fit" resets. Click a user or chat to highlight its connections, Esc to clear.

Sample data: `src/admin/data.ts`. Page: `src/admin/Admin.tsx`. Styles: `src/admin/admin.css`.

## `/console`

An earlier multi-tenant terminal console, kept for reference.
