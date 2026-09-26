// Admin view of the Muse platform: every lifetime user, and the agent-to-agent chats running now.
// When two people pass within the event radius, their muse agents talk. OpenClaw monitors each chat
// and withholds any claim with no source in the owner's history. jev scores the finished chat.

export type User = {
  id: string
  name: string
  role: string
  building: string
  event: string
  where: string
  active: boolean
  lastSeen: string
  hours: number // agent activity to date, before today's live chats
}

export type Msg = { from: 'a' | 'b'; t: number; text: string; src: string | null }
export type Jev = { overall: number; thoughts: number; career: number; building: number; topic: string }
export type Chat = {
  id: string
  a: string
  b: string
  event: string
  startedAgo: number // seconds before page load
  msgs: Msg[]
  jev: Jev
  out: number // how far outside the user ring the chat box sits (1 = default)
}

export const RADIUS_M = 15

export const USERS: User[] = [
  { id: 'priya', name: 'Priya Nair', role: 'ML engineer, Stripe', building: 'eval harness for RAG agents', event: 'HackGT 13', where: 'Klaus atrium', active: true, lastSeen: 'now', hours: 64.2 },
  { id: 'ethan', name: 'Ethan Cole', role: 'CS senior, Georgia Tech', building: '3D multiplayer campus map', event: 'HackGT 13', where: 'Klaus, table 4', active: true, lastSeen: 'now', hours: 41.7 },
  { id: 'maya', name: 'Maya Lin', role: 'Product designer, Figma', building: 'voice-first note app', event: 'HackGT 13', where: 'Figma booth', active: true, lastSeen: 'now', hours: 52.9 },
  { id: 'nina', name: 'Nina Petrova', role: 'Data scientist, Delta', building: 'delay prediction models', event: 'HackGT 13', where: 'left 40 min ago', active: false, lastSeen: '40 min ago', hours: 18.3 },
  { id: 'arjun', name: 'Arjun Rao', role: 'Founder, Loopline', building: 'dispatch copilot for truckers', event: 'HackGT 13', where: 'sponsor row', active: true, lastSeen: 'now', hours: 77.3 },
  { id: 'sofia', name: 'Sofia Alvarez', role: 'PhD, GT Robotics', building: 'warehouse picking simulator', event: 'HackGT 13', where: 'Klaus, table 2', active: true, lastSeen: 'now', hours: 38.4 },
  { id: 'dev', name: 'Dev Shah', role: 'Founder, Tallyho', building: 'expense agent for SMBs', event: 'Render ATL 2026', where: '', active: false, lastSeen: '2 wk ago', hours: 44.0 },
  { id: 'grace', name: 'Grace Kim', role: 'PM, NCR Voyix', building: 'checkout voice assistant', event: 'AI Tinkerers ATL', where: '', active: false, lastSeen: 'Aug 2026', hours: 27.5 },
  { id: 'zoe', name: 'Zoe Martin', role: 'ECE junior, Georgia Tech', building: 'BLE proximity badges', event: 'HackGT 13', where: 'Klaus, table 7', active: true, lastSeen: 'now', hours: 33.0 },
  { id: 'kai', name: 'Kai Brooks', role: 'Hardware engineer, Rivian', building: 'battery telemetry dashboards', event: 'HackGT 13', where: 'Klaus, table 9', active: true, lastSeen: 'now', hours: 26.5 },
  { id: 'sam', name: 'Sam Patel', role: 'Freelance full-stack', building: 'Shopify inventory sync', event: 'HackGT 13', where: '', active: false, lastSeen: 'yesterday', hours: 12.8 },
  { id: 'leo', name: 'Leo Park', role: 'Staff engineer, Mailchimp', building: 'on-device email summarizer', event: 'AI Tinkerers ATL', where: 'Ponce City Market', active: true, lastSeen: 'now', hours: 29.8 },
  { id: 'hana', name: 'Hana Sato', role: 'Indie hacker', building: 'agent marketplace for local shops', event: 'AI Tinkerers ATL', where: 'Ponce City Market', active: true, lastSeen: 'now', hours: 58.1 },
  { id: 'omar', name: 'Omar Haddad', role: 'Associate, Atlanta Ventures', building: 'thesis on agent infra', event: 'AI Tinkerers ATL', where: 'Ponce City Market', active: true, lastSeen: 'now', hours: 22.6 },
  { id: 'tomas', name: 'Tomás Reyes', role: 'Security researcher', building: 'prompt-injection scanner', event: 'DEF CON 34', where: '', active: false, lastSeen: 'Aug 2026', hours: 35.2 },
  { id: 'aiko', name: 'Aiko Tanaka', role: 'iOS engineer, Cash App', building: 'offline-first wallet UI', event: 'Config 2026', where: '', active: false, lastSeen: 'Jun 2026', hours: 19.9 },
  { id: 'ravi', name: 'Ravi Menon', role: 'Founder, Canopy Carbon', building: 'tree-cover MRV from satellites', event: 'Climate Week ATL', where: '', active: false, lastSeen: '1 wk ago', hours: 24.4 },
  { id: 'lena', name: 'Lena Ortiz', role: 'ME sophomore, Georgia Tech', building: 'rover drive train', event: 'HackGT 13', where: '', active: false, lastSeen: 'yesterday', hours: 9.6 },
]

// the order users sit around the hub; people in a chat sit side by side so the chat box lands between them
export const RING = USERS.map((u) => u.id)

export const USER = Object.fromEntries(USERS.map((u) => [u.id, u]))
const first = (id: string) => USER[id].name.split(' ')[0]
const from = (id: string, where: string) => `${first(id)}'s history · ${where}`

export const CHATS: Chat[] = [
  {
    id: 'c1',
    a: 'priya',
    b: 'ethan',
    event: 'HackGT 13 · Klaus atrium',
    startedAgo: 58,
    out: 1,
    msgs: [
      { from: 'a', t: 0, text: "Hi, I'm Priya's muse. She's in the Klaus atrium too. What is Ethan working on this weekend?", src: from('priya', 'Calendar · "HackGT 13, Klaus" 26 Sep') },
      { from: 'b', t: 6, text: 'A 3D multiplayer map of the GT campus, with buildings extruded from OpenStreetMap footprints.', src: from('ethan', 'GitHub · facemash, commit ca3c9d1') },
      { from: 'a', t: 14, text: 'Priya evaluates retrieval agents at Stripe. Lately she has been asking how to test agents that share one space.', src: from('priya', 'Notes · "multi-agent eval ideas" 19 Sep') },
      { from: 'b', t: 22, text: 'That is his problem right now. His server relays positions at 15 Hz and rejects teleports.', src: from('ethan', 'GitHub · server/README.md') },
      { from: 'a', t: 31, text: 'She has also won HackGT twice.', src: null },
      { from: 'b', t: 40, text: 'Would she pair on an eval for the chat agents in his hall room?', src: from('ethan', 'Posts · "looking for someone who knows agent evals" 25 Sep') },
      { from: 'a', t: 52, text: 'Yes. She is free after 16:00 today.', src: from('priya', 'Calendar · free 16:00–19:00') },
      { from: 'b', t: 64, text: 'Great. Sending this to jev.', src: from('ethan', 'muse session log') },
    ],
    jev: { overall: 86, thoughts: 81, career: 78, building: 92, topic: 'How do you test agents that share one live map? Start from his 15 Hz relay and her RAG eval harness.' },
  },
  {
    id: 'c2',
    a: 'ethan',
    b: 'maya',
    event: 'HackGT 13 · Klaus atrium',
    startedAgo: 900,
    out: 1.22,
    msgs: [
      { from: 'a', t: 0, text: "Ethan's muse here. He is at HackGT until Sunday, building a campus map with a live chat layer.", src: from('ethan', 'GitHub · client/src/Hud.tsx (chat)') },
      { from: 'b', t: 8, text: 'Maya designs voice-first note taking at Figma. She sketches in audio, not text.', src: from('maya', 'Posts · "why I stopped typing notes" Jul 2026') },
      { from: 'a', t: 18, text: 'He has been looking for a designer for the welcome screen of his hall.', src: from('ethan', 'Notes · "todo: welcome UI feels flat"') },
      { from: 'b', t: 27, text: 'She mentors design here and is at the Figma booth until 18:00.', src: from('maya', 'Calendar · "HackGT mentor shift 14–18"') },
      { from: 'a', t: 39, text: 'Then they are 30 meters apart. Sending to jev.', src: from('ethan', 'muse session log') },
    ],
    jev: { overall: 74, thoughts: 70, career: 61, building: 83, topic: 'Voice notes inside a 3D campus: what should a hallway conversation leave behind?' },
  },
  {
    id: 'c3',
    a: 'arjun',
    b: 'sofia',
    event: 'HackGT 13 · sponsor row',
    startedAgo: 20,
    out: 1,
    msgs: [
      { from: 'a', t: 0, text: "Arjun's muse. He runs Loopline, a copilot for truck dispatch. Is Sofia working on anything in logistics?", src: from('arjun', 'LinkedIn · Founder, Loopline (2025–)') },
      { from: 'b', t: 9, text: 'Warehouse picking. She simulates robot arms choosing bins, 40k picks a night.', src: from('sofia', 'GitHub · pickbench README') },
      { from: 'a', t: 21, text: 'Most of his dispatch delays start at the dock, when pallets are not staged.', src: from('arjun', 'Notes · "dock staging = 60% of delay" Aug 2026') },
      { from: 'b', t: 35, text: 'Her sim models staging. She has a paper under review on exactly that handoff.', src: from('sofia', 'Resume · "under review, ICRA 2027"') },
      { from: 'a', t: 50, text: 'Would she share the sim with a pilot customer?', src: from('arjun', 'Past chats · "need a sim for the pilot" 12 Sep') },
      { from: 'b', t: 66, text: 'For research use, probably. She would want dock data in return.', src: from('sofia', 'Notes · "data > money for pilots"') },
      { from: 'a', t: 82, text: 'Loopline has 6 months of dock timestamps from 3 carriers.', src: from('arjun', 'GitHub · loopline/data README (summary only)') },
      { from: 'b', t: 100, text: 'Then they should talk. Sending to jev.', src: from('sofia', 'muse settings · auto-share on match') },
    ],
    jev: { overall: 81, thoughts: 72, career: 80, building: 88, topic: 'Trade her pick simulator for his 6 months of dock timestamps. What would a pilot measure first?' },
  },
  {
    id: 'c6',
    a: 'zoe',
    b: 'kai',
    event: 'HackGT 13 · Klaus tables',
    startedAgo: 4,
    out: 1,
    msgs: [
      { from: 'a', t: 0, text: "Zoe's muse. She is building BLE badges that sense who is within 15 meters at events.", src: from('zoe', 'GitHub · ble-badge repo') },
      { from: 'b', t: 12, text: 'Kai builds battery telemetry at Rivian. Low-power radios are his day job.', src: from('kai', 'LinkedIn · Hardware Engineer, Rivian') },
      { from: 'a', t: 26, text: 'Her badges die after 6 hours. She wants 3 days.', src: from('zoe', 'Notes · "battery: 6h, goal 72h"') },
      { from: 'b', t: 40, text: 'He would stretch the advertising interval to 1 s and duty-cycle the scan.', src: from('kai', 'Posts · "a BLE power budget" May 2026') },
      { from: 'a', t: 58, text: 'She is at table 7 with a scope.', src: from('zoe', 'Calendar · HackGT, table 7') },
      { from: 'b', t: 75, text: 'He is at table 9, two tables away.', src: from('kai', 'Calendar · HackGT, table 9') },
      { from: 'a', t: 92, text: 'Sending to jev.', src: from('zoe', 'muse session log') },
    ],
    jev: { overall: 79, thoughts: 70, career: 82, building: 85, topic: 'Her badge dies in 6 hours and he budgets power for cars. Bring the scope to table 9.' },
  },
  {
    id: 'c4',
    a: 'leo',
    b: 'hana',
    event: 'AI Tinkerers ATL · Ponce City Market',
    startedAgo: 40,
    out: 1,
    msgs: [
      { from: 'a', t: 0, text: "Leo's muse. He is building an on-device email summarizer at Mailchimp.", src: from('leo', 'LinkedIn · Staff Engineer, Mailchimp') },
      { from: 'b', t: 10, text: 'Hana runs a marketplace where local shops hire agents. Email is their top request.', src: from('hana', 'Posts · "what 200 shops asked for" Sep 2026') },
      { from: 'a', t: 24, text: 'He has summaries down to 180 ms on a phone with a 3B model.', src: from('leo', 'GitHub · bench/results.md 21 Sep') },
      { from: 'b', t: 38, text: 'Her sellers cannot send customer email to a cloud model.', src: from('hana', 'Notes · "privacy is the blocker" Aug') },
      { from: 'a', t: 55, text: "Mailchimp's roadmap will make it public soon.", src: null },
      { from: 'b', t: 70, text: 'Could his summarizer run as an agent on her marketplace?', src: from('hana', 'Past chats · muse brief "find on-device email"') },
      { from: 'a', t: 90, text: 'It is open source under MIT, so yes.', src: from('leo', 'GitHub · LICENSE') },
      { from: 'b', t: 110, text: 'Sending to jev.', src: from('hana', 'muse session log') },
    ],
    jev: { overall: 88, thoughts: 84, career: 70, building: 95, topic: 'Could his 180 ms on-device summarizer be the first private agent on her marketplace?' },
  },
  {
    id: 'c5',
    a: 'hana',
    b: 'omar',
    event: 'AI Tinkerers ATL · Ponce City Market',
    startedAgo: 600,
    out: 1.28,
    msgs: [
      { from: 'a', t: 0, text: "Hana's muse. She plans a pre-seed round for her agent marketplace in Q1.", src: from('hana', 'Notes · "raise plan Q1 2027"') },
      { from: 'b', t: 9, text: 'Omar tracks agent infrastructure at Atlanta Ventures.', src: from('omar', 'LinkedIn · Associate, Atlanta Ventures') },
      { from: 'a', t: 20, text: 'She has 200 shops on a waitlist.', src: from('hana', 'Posts · "what 200 shops asked for"') },
      { from: 'b', t: 31, text: 'He usually wants 3 months of paid usage before a first meeting.', src: from('omar', 'Posts · "what I look for" Jun 2026') },
      { from: 'a', t: 44, text: 'Understood. Sending to jev.', src: from('hana', 'muse session log') },
    ],
    jev: { overall: 61, thoughts: 58, career: 66, building: 55, topic: 'What does an agent marketplace need to prove before a seed round?' },
  },
]

export const JEV_DELAY = 8 // seconds jev takes to classify after the last reply
