# aaditi · Agent Console

A black, terminal-style console for watching many AI agents run many chats at once, across isolated tenants.

- **Multi-tenant:** three tenants (`acme`, `globex`, `initech`), each with its own agents, users, sessions and source namespace (`src[acme]`). The console is scoped to one tenant at a time, and `/open`-ing another tenant's chat is denied. The `* all` scope is the cross-tenant ops view.
- **Multi-agent, multi-chat:** up to 6 chat panes live side by side. Agents stream their replies, and the sidebar shows every agent and session with its state (typing / replying / waiting / paused).
- **Timestamps:** every message has `[HH:MM:SS]`. Hover it for the full date with milliseconds and UTC offset. Agent replies also show their response latency (`+3.2s`).
- **Source line under every message:** `└─ src[tenant]` lists the records pulled about the user (SSO session, CRM, billing, orders, KYC, …). Each one goes from `pulling` to `verifying` and ends as ✓ verified, ✗ mismatch (the claim contradicts the record) or ? unverified (no record). Each shows what it found and how long the check took. The **verify log** on the right is the audit trail of every lookup in scope.

The data is simulated in `src/store.ts` and `src/data.ts`. No backend is needed yet.

## Run

```bash
cd aaditi
npm install
npm run dev        # http://localhost:5174
```

## Console

| input | does |
| --- | --- |
| plain text | operator note into the focused chat (checked against `auth:operator` and tenant scope) |
| `/tenant acme\|globex\|initech\|all` | switch scope (or Alt+1..3, Alt+0) |
| `/open c-05` · `/close` | open or close a pane |
| `/pause` · `/resume` | stop or restart the focused chat |
| `/list` | sessions in scope |
| Tab / Shift+Tab | cycle focused pane |
| ↑ / ↓ | command history |

## Layout

- `src/data.ts`: tenants, agents, users, and scripted exchanges with the sources each one checks
- `src/store.ts`: simulated live backend. A source's status is a function of time (`srcStatus(src, now)`)
- `src/ui/`: `ChatPane`, `Message` (message + source line), `Sidebar`, `VerifyLog`
- `src/terminal.css`: the black theme. Panes use container queries to stack on narrow widths.
