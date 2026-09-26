// Sample data for the Muse web. You are at an event; everyone who passes within the radius
// gets an agent-to-agent chat between your muse agent and their agent. OpenClaw monitors every
// chat, and every reply must cite where it came from. After the chat, jev scores the match.

export type SourceId = 'github' | 'notes' | 'posts' | 'goals' | 'calendar' | 'resume' | 'reading' | 'chats'
export type MyData = { id: SourceId; label: string; summary: string }
export type Turn = { from: 'muse' | 'them'; text: string; src?: SourceId; cite: string; flag?: string }
export type Score = { overall: number; thoughts: number; career: number; building: number }
export type Person = {
  id: string
  name: string
  role: string
  agent: string
  distance: number
  spot: string
  start: number // seconds after page load that the agents start talking (negative = already happened)
  score: Score
  topics: string[]
  opener: string
  turns: Turn[]
}

export const EVENT = { name: 'HackGT 13', venue: 'Klaus Atrium', radius: 25 }

// your history: the only things muse is allowed to say about you
export const MY_DATA: MyData[] = [
  { id: 'github', label: 'GitHub', summary: 'facemash: 3D multiplayer GT campus, live location, Go WebSocket server' },
  { id: 'notes', label: 'Notes', summary: 'Muse design notes: radius trigger, OpenClaw, sourcing rules' },
  { id: 'posts', label: 'Posts', summary: '"AI agents should network for you, not spam for you"' },
  { id: 'goals', label: 'Goals', summary: 'Today: find 2 collaborators for Muse' },
  { id: 'calendar', label: 'Calendar', summary: 'HackGT 13 judging, Sat 11:00 at Klaus' },
  { id: 'resume', label: 'Resume', summary: 'React, three.js, Go, realtime systems' },
  { id: 'reading', label: 'Reading', summary: 'Designing Data-Intensive Applications, ch. 11' },
  { id: 'chats', label: 'Past chats', summary: 'Earlier Muse conversations and jev scoring notes' },
]

const me = (src: SourceId, cite: string, text: string): Turn => ({ from: 'muse', src, cite, text })
const them = (cite: string, text: string): Turn => ({ from: 'them', cite, text })
const unsourced = (flag: string, text: string): Turn => ({ from: 'them', cite: '', flag, text })

export const matchLabel = (s: number) => (s >= 80 ? 'strong' : s >= 55 ? 'worth' : 'low')
export const LABEL_TEXT = { strong: 'Strong match', worth: 'Worth meeting', low: 'Low overlap' }

export const PEOPLE: Person[] = [
  {
    id: 'ethan',
    name: 'Ethan Park',
    role: 'CS @ Georgia Tech · building Quadmap',
    agent: 'ethan.agent',
    distance: 9,
    spot: 'by the glass stair',
    start: -300,
    score: { overall: 92, thoughts: 86, career: 88, building: 97 },
    topics: ['realtime multiplayer', 'OpenStreetMap', 'indoor GPS drift', 'three.js'],
    opener:
      'Ask how Quadmap handles indoor GPS drift in Klaus. You solved it with step + compass dead reckoning fused with GPS, and it is his open blocker.',
    turns: [
      me('github', 'facemash README · "3D, multiplayer walk around the whole Georgia Tech campus"', "Hi, I'm muse. My human is building a 3D multiplayer map of the GT campus from OpenStreetMap footprints. What is Ethan working on?"),
      them('GitHub · ethanpark/quadmap · issue #14 "indoor drift"', 'Big overlap. Ethan is building Quadmap, live friend locations on a campus map. His blocker is GPS drift inside Klaus.'),
      me('github', 'commit 4f68987 · "step + compass dead reckoning fused with GPS" · Sep 25', 'My human hit the same thing. The fix: step + compass dead reckoning fused with GPS, learning compass bias and stride from the GPS path.'),
      them('Notes · "Firebase write limits at 10 Hz" · Sep 20', "Ethan would want that. He's on Firebase and hitting write limits at 10 Hz. How does your server handle it?"),
      me('github', 'server/README · "Relays positions at 15 Hz, rejects teleports"', "A Go WebSocket server relays positions at 15 Hz and rejects teleports. They'd happily walk him through it."),
      them('Goals · "meet realtime builders at HackGT"', 'He is also trying to meet people shipping realtime systems this weekend.'),
    ],
  },
  {
    id: 'dev',
    name: 'Dev Shah',
    role: 'Founder · Tracewell, agent observability',
    agent: 'dev.agent',
    distance: 21,
    spot: 'at the sponsor booths',
    start: -200,
    score: { overall: 83, thoughts: 91, career: 80, building: 76 },
    topics: ['agent monitoring', 'grounded claims', 'evals'],
    opener: 'Compare how you each stop agents from making things up: OpenClaw on every muse chat vs. his span-linked claims in Tracewell.',
    turns: [
      me('posts', 'post · "AI agents should network for you, not spam for you" · Sep 12', 'Hi, muse here. My human builds agents that network for people at events, with every conversation monitored. What does Dev work on?'),
      them('LinkedIn · Founder, Tracewell', 'Dev runs Tracewell, observability for multi-agent systems. He is looking for design partners.'),
      me('notes', 'note · "OpenClaw monitors every chat; no claim without a source" · Sep 22', 'Relevant. Every muse chat is monitored by OpenClaw, and nothing about a person is said unless it comes from their history.'),
      them('Tracewell docs · "grounded claims"', 'Dev built the same rule into Tracewell: every agent claim has to link to a trace span.'),
      unsourced('no source in Dev’s shared history, excluded from scoring', 'He also raised a $4M seed round last month.'),
      me('chats', 'past chat · jev scoring notes · Sep 19', 'Noted. After each chat, jev scores thoughts, career and what you are building, then suggests an opener.'),
    ],
  },
  {
    id: 'riya',
    name: 'Riya Kapoor',
    role: 'ML engineer · on-device speech',
    agent: 'riya.agent',
    distance: 14,
    spot: 'near the photo-booth boat',
    start: -6,
    score: { overall: 77, thoughts: 84, career: 70, building: 76 },
    topics: ['on-device ML', 'consent', 'privacy'],
    opener: 'Ask whether muse matching could run on-device. She keeps speech models on the phone for consent reasons, and muse has the same rule about sourcing.',
    turns: [
      me('goals', 'goal · "find 2 collaborators for Muse at HackGT"', "Hi, I'm muse. My human is building agents that only share what's in someone's own history. What is Riya focused on?"),
      them('blog · "Why speech should stay on device" · Aug 30', 'Riya ships on-device speech models so nothing leaves the phone. She cares a lot about consent.'),
      me('notes', 'note · "agents can only say what is sourced from your history"', "That matches. My human's rule is that an agent can't say anything about you that isn't sourced from your history."),
      them('Notes · "edge inference for agents"', 'Could muse run its matching on-device? She would be curious.'),
      me('github', 'facemash/server · Go service', 'Not yet, the classifier runs server-side. That would be a good first conversation.'),
    ],
  },
  {
    id: 'hannah',
    name: 'Hannah Cole',
    role: 'Designer · generative three.js art',
    agent: 'hannah.agent',
    distance: 18,
    spot: 'by the checkerboard wall',
    start: -150,
    score: { overall: 74, thoughts: 80, career: 60, building: 82 },
    topics: ['three.js', 'toon shading', 'scroll stories'],
    opener: 'Show her the cutaway that reveals players behind buildings. She has been collecting tricks for keeping 3D scenes readable.',
    turns: [
      them('portfolio · hannahcole.art', "Hi, Hannah's agent here. She makes generative art in three.js and is looking for playful 3D projects."),
      me('github', 'client/src/cutaway.ts', "My human's campus map uses toon-shaded buildings from OSM, plus a cutaway so you can see players behind buildings."),
      them('Bookmarks · "scroll-driven 3D" folder', 'She would love that cutaway. Is there a landing page too?'),
      me('github', 'commit 886e358 · "scroll-driven story, bean walks a winding path"', 'Yes: a scroll-driven story where a bean walks past the people you would have missed.'),
    ],
  },
  {
    id: 'kenji',
    name: 'Kenji Mori',
    role: 'Hardware hacker · wearables',
    agent: 'kenji.agent',
    distance: 11,
    spot: 'just walked in, east doors',
    start: 22,
    score: { overall: 72, thoughts: 68, career: 64, building: 81 },
    topics: ['BLE proximity', 'wearables', 'radius triggers'],
    opener: 'Ask how his badge decides who is "nearby" over BLE. That is exactly the radius trigger muse depends on.',
    turns: [
      me('notes', 'note · "start agent chats when people pass within radius"', 'Hi, muse here. My agent starts talking when people pass within a set radius at an event.'),
      them('Hackaday · "proximity badge"', 'Kenji built a BLE badge that does exactly that radius detection.'),
      me('notes', 'note · "radius = 25 m"', 'Then you two should compare how you decide who counts as nearby. Muse uses 25 m.'),
      them('GitHub · badge/firmware/rssi.c', 'His badge uses RSSI, which works out to about 10 m indoors.'),
    ],
  },
  {
    id: 'grace',
    name: 'Grace Liu',
    role: 'Data engineer · vector search',
    agent: 'grace.agent',
    distance: 30,
    spot: 'at the hacking tables',
    start: -90,
    score: { overall: 69, thoughts: 64, career: 72, building: 70 },
    topics: ['embeddings', 'pgvector', 'streams'],
    opener: 'Ask how she would embed agent chats so match scores stay explainable. You are both reading DDIA chapter 11.',
    turns: [
      me('goals', 'goal · "score similarity between people from agent chats"', 'Hi, muse here. My human wants to embed agent conversations to score how similar people are. What is Grace working on?'),
      them('talk · "pgvector in production" · PyData', 'Grace runs pgvector at work. She would embed per topic, not per conversation, so scores stay explainable.'),
      me('chats', 'jev spec · "split score into thoughts, career, building"', 'That fits. Scores are already split into thoughts, career and what you are building.'),
      them('Goodreads · currently reading DDIA', 'She is reading about streaming ingestion right now.'),
      me('reading', 'Designing Data-Intensive Applications · ch. 11 bookmarked', 'Same book is on my human’s reading list, chapter 11.'),
    ],
  },
  {
    id: 'sofia',
    name: 'Sofia Alvarez',
    role: 'PM · creator payments',
    agent: 'sofia.agent',
    distance: 27,
    spot: 'near the lighthouse booth',
    start: -60,
    score: { overall: 66, thoughts: 78, career: 62, building: 58 },
    topics: ['AI intros', 'trust', 'product'],
    opener: 'Ask what would make her trust an agent to introduce her. She wrote that AI intros feel spammy unless they explain why.',
    turns: [
      me('posts', 'post · "AI agents should network for you, not spam for you"', 'Hi, muse here. My human believes agents should network for you, not spam for you.'),
      them('newsletter · "The why-intro" · Sep 3', 'Sofia wrote nearly the same thing: AI intros feel spammy unless they explain why.'),
      me('notes', 'note · "every match comes with a first topic and sources"', 'Every muse match comes with a suggested first topic, and every claim is sourced.'),
      them('newsletter · "The why-intro"', 'She would want to see the reasoning, not just a score.'),
    ],
  },
  {
    id: 'marcus',
    name: 'Marcus Hill',
    role: 'Junior · Rust robotics',
    agent: 'marcus.agent',
    distance: 24,
    spot: 'hardware track tables',
    start: -2,
    score: { overall: 58, thoughts: 55, career: 60, building: 59 },
    topics: ['sensor fusion', 'Rust', 'IMU'],
    opener: 'Talk sensor fusion: his arm uses an IMU complementary filter, close to your compass + step fusion.',
    turns: [
      them('Devpost · "armstrong"', "Hi, Marcus's agent. He is building a Rust robot arm and wants a teammate for the hardware track."),
      me('github', 'commit 4f68987 · "step + compass dead reckoning fused with GPS"', "My human is on the software side, but they have done sensor fusion: compass and step counting fused with GPS."),
      them('GitHub · armstrong/src/imu.rs', 'His arm uses an IMU complementary filter. Similar math.'),
      me('calendar', 'HackGT 13 · judging Sat 11:00 at Klaus', 'Worth a chat, though they are not joining a hardware team today.'),
    ],
  },
  {
    id: 'omar',
    name: 'Omar Farouk',
    role: 'Security · CTF player',
    agent: 'omar.agent',
    distance: 33,
    spot: 'left 20 min ago',
    start: -180,
    score: { overall: 49, thoughts: 60, career: 40, building: 44 },
    topics: ['prompt injection', 'red teaming'],
    opener: 'Ask how he would attack an agent-to-agent chat. OpenClaw could use a red-teamer.',
    turns: [
      them('CTFtime profile', "Hi, Omar's agent. He breaks things: CTFs and prompt injection."),
      me('notes', 'note · "OpenClaw watches every agent chat"', 'Useful. My human’s agents talk to strangers’ agents, and OpenClaw watches for unsourced claims.'),
      them('blog · "agent-to-agent injection"', 'He would try to make an agent leak data from outside its history.'),
      me('notes', 'note · "answer only from your human’s history"', 'Muse only answers from its human’s history. Happy to be tested.'),
    ],
  },
  {
    id: 'leila',
    name: 'Leila Haddad',
    role: 'PhD · CRISPR design tools',
    agent: 'leila.agent',
    distance: 35,
    spot: 'second-floor balcony',
    start: -240,
    score: { overall: 36, thoughts: 48, career: 30, building: 28 },
    topics: ['lab tooling', 'UX'],
    opener: 'Low overlap. If you do meet, ask what makes lab software painful to use.',
    turns: [
      me('resume', 'Resume · React, three.js, Go', 'Hi, muse here. My human builds realtime multiplayer maps and agent networking.'),
      them('lab page · Haddad Lab', 'Leila builds CRISPR design tools. Not much overlap, but she likes good UX.'),
      me('goals', 'goal · "find 2 collaborators for Muse"', 'Understood, I will keep this one short.'),
    ],
  },
  {
    id: 'jonah',
    name: 'Jonah Weiss',
    role: 'Recruiter · sponsor booth',
    agent: 'jonah.agent',
    distance: 16,
    spot: 'sponsor booth row',
    start: -120,
    score: { overall: 29, thoughts: 20, career: 52, building: 16 },
    topics: ['internships'],
    opener: 'Only if you want an internship. He is hiring developer interns for summer 2027.',
    turns: [
      them('HackGT sponsor list', "Hi, Jonah's agent. He is hiring developer interns for summer 2027."),
      me('goals', 'goal · "focus on Muse this weekend"', 'My human is focused on building Muse this weekend, not internships.'),
      them('calendar · booth shift until 16:00', 'Understood. He will be at the booth until 16:00.'),
    ],
  },
]
