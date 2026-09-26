# Activity recorder

An admin view that records everything happening on the Muse platform: how many accounts there are, who they are, their account details, their sessions, and a live log of what they do. Black theme.

```bash
cd activity-recorder
npm install
npm run dev        # http://localhost:5175
```

## What it shows

- **Recording bar:** ● REC with how long it has been recording. Pause or resume, and export the log, the accounts or the sessions as CSV.
- **Totals:** accounts (with sign-ups today), online now, sessions in the last 24 h (open vs ended), **total session time** and average session length, agent chats, jev matches (and chats below the match line or with OpenClaw-withheld claims), events recorded.
- **Events per hour:** the last 24 h as a bar chart. Hover an hour for its count, or switch to a table.
- **Accounts:** every account with name, @username, email, account ID, sign-in provider, plan, device, online/offline and the event they're at, joined date, sessions, agent chats, matches, hours and last activity. Search, filter (All / Online / Offline / New today) and sort by any number column.
- **Sessions:** every sign-in → sign-out with its start time, end time and duration. Open sessions tick live. The header totals sessions, total time, average, longest and how many are open.
- **Account drawer:** click any row for that person's account details, totals, their sessions, and everything the recorder saw them do (exportable).
- **Live log:** every event as it's recorded, newest first, filterable by type.

## Data

The accounts are the Muse sample users (`src/data.ts`). The recorder rebuilds the last 24 h of history at start, then records live: sign-ins and sign-outs (which open and close sessions), people coming within 15 m of each other, muse agent chats, OpenClaw withholding unsourced claims, jev matches, profile updates, and four new sign-ups arriving over the first few minutes. It all runs in the browser. There's no database connection yet; the CSV exports and `sessionsCSV` / `sessionTotals` in `src/recorder.ts` are the numbers to store once one is added.

## Files

- `src/data.ts`: accounts and upcoming sign-ups
- `src/recorder.ts`: the recorder (history, live events, sessions, pause, totals, CSV)
- `src/App.tsx`: the page; `src/HourChart.tsx`: events per hour; `src/UserDrawer.tsx`: one account
- `src/recorder.css`: the theme
