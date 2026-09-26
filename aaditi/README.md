# aaditi

Two views of AI agents at work. Run both from here:

```bash
cd aaditi
npm install
npm run dev        # http://localhost:5174
```

## `/`: Agent activity wireframe (one user account)

A lo-fi, black wireframe of every agent conversation running on behalf of **one user account** (Priya Nair). Her agents talk to airlines, banks, landlords, recruiters and support bots for her.

- **Account bar:** the one identity all agents act as, with a pause-all kill switch.
- **Summary:** chats in flight, how many need you, how many times your info was shared, and how many claims were flagged.
- **Chat grid:** one card per conversation: agent ⇄ counterparty, bot or human, channel, goal and status (Needs you / Active / Waiting on them / Done). Filter by status.
- **Timestamps** on every message (hover for full date), and time since last activity on each card.
- **Source line under every message:** for the user's agent, *which of your info it shared* and the record it was verified against. For the other side, *their claims checked against your records*. ✓ verified · ✗ contradicts your records (FLAG) · ? no record · … pending.
- **Needs you:** approvals for anything outside an agent's permissions (spend over the limit, sensitive info). Approve or decline, and the agent carries on.
- **Your info agents can use:** a ledger of the user's data, its source of truth, when it was last verified, and which chats used it. Click one to filter the grid.
- **Thread view:** the full transcript in a drawer, with a composer for taking the chat over yourself.
- Blue numbered pins match the **design notes** at the bottom. Toggle them with "Notes".

Code: `src/wireframe/` (`data.ts` holds the mock account, info ledger and threads, `Wireframe.tsx` the page, `wireframe.css` the styles).

## `/console`: Multi-tenant agent console

A black terminal console for watching many agents across isolated tenants (`acme`, `globex`, `initech`). Up to 6 live chat panes, per-message timestamps, a source-verification line under each message, and a verify log. Commands: `/tenant`, `/open`, `/close`, `/pause`, `/resume`, `/list`; plain text sends an operator note.

Code: `src/App.tsx`, `src/store.ts` (simulated live backend), `src/data.ts`, `src/ui/`, `src/terminal.css`.
