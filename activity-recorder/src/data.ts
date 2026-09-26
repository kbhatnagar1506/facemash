// Every Muse account, with the fields an admin needs. Counters (sessions, chats, matches, hours)
// are totals from before the recording window; the recorder adds what it sees on top.

export type Provider = 'Google' | 'GitHub' | 'Apple' | 'Email'

export type Account = {
  id: string
  accountId: string
  name: string
  username: string
  email: string
  provider: Provider
  plan: 'Free' | 'Pro'
  created: string // YYYY-MM-DD, or 'today' for sign-ups the recorder sees
  device: string
  city: string
  role: string
  building: string
  event: string
  where: string
  online: boolean
  lastSeenMin: number // minutes ago, for accounts offline when recording starts
  hours: number
  sessions: number
  chats: number
  matches: number
}

// stable account id from the user id (FNV-1a), e.g. acc_1K9Z3QF
function accountId(id: string) {
  let h = 2166136261
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return `acc_${(h >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(0, 7)}`
}

const acct = (a: Omit<Account, 'accountId'>): Account => ({ accountId: accountId(a.id), ...a })

export const ACCOUNTS: Account[] = [
  acct({ id: 'priya', name: 'Priya Nair', username: 'priya.nair', email: 'priya.nair@brightcart.io', provider: 'Google', plan: 'Pro', created: '2026-03-14', device: 'iPhone 16 Pro', city: 'Atlanta, GA', role: 'ML engineer, Stripe', building: 'eval harness for RAG agents', event: 'HackGT 13', where: 'Klaus atrium', online: true, lastSeenMin: 0, hours: 64.2, sessions: 41, chats: 118, matches: 23 }),
  acct({ id: 'ethan', name: 'Ethan Cole', username: 'ethanc', email: 'ethan.cole@gatech.edu', provider: 'GitHub', plan: 'Free', created: '2026-08-02', device: 'Pixel 10', city: 'Atlanta, GA', role: 'CS senior, Georgia Tech', building: '3D multiplayer campus map', event: 'HackGT 13', where: 'Klaus, table 4', online: true, lastSeenMin: 0, hours: 41.7, sessions: 29, chats: 76, matches: 14 }),
  acct({ id: 'maya', name: 'Maya Lin', username: 'mayasketches', email: 'maya@lin.studio', provider: 'Apple', plan: 'Pro', created: '2026-05-21', device: 'iPhone 16', city: 'Atlanta, GA', role: 'Product designer, Figma', building: 'voice-first note app', event: 'HackGT 13', where: 'Figma booth', online: true, lastSeenMin: 0, hours: 52.9, sessions: 37, chats: 94, matches: 19 }),
  acct({ id: 'nina', name: 'Nina Petrova', username: 'ninap', email: 'nina.petrova@skymail.dev', provider: 'Google', plan: 'Free', created: '2026-06-09', device: 'Galaxy S26', city: 'Atlanta, GA', role: 'Data scientist, Delta', building: 'delay prediction models', event: 'HackGT 13', where: '', online: false, lastSeenMin: 40, hours: 18.3, sessions: 12, chats: 31, matches: 5 }),
  acct({ id: 'arjun', name: 'Arjun Rao', username: 'arjun.loopline', email: 'arjun@loopline.ai', provider: 'Google', plan: 'Pro', created: '2026-01-30', device: 'iPhone 15 Pro', city: 'Atlanta, GA', role: 'Founder, Loopline', building: 'dispatch copilot for truckers', event: 'HackGT 13', where: 'sponsor row', online: true, lastSeenMin: 0, hours: 77.3, sessions: 58, chats: 141, matches: 27 }),
  acct({ id: 'sofia', name: 'Sofia Alvarez', username: 'sofia.robots', email: 'salvarez@robotics.gatech.edu', provider: 'Email', plan: 'Free', created: '2026-04-11', device: 'Pixel 9', city: 'Atlanta, GA', role: 'PhD, GT Robotics', building: 'warehouse picking simulator', event: 'HackGT 13', where: 'Klaus, table 2', online: true, lastSeenMin: 0, hours: 38.4, sessions: 26, chats: 63, matches: 11 }),
  acct({ id: 'dev', name: 'Dev Shah', username: 'devshah', email: 'dev@tallyho.app', provider: 'GitHub', plan: 'Pro', created: '2026-02-18', device: 'iPhone 16 Pro Max', city: 'Atlanta, GA', role: 'Founder, Tallyho', building: 'expense agent for SMBs', event: 'Render ATL 2026', where: '', online: false, lastSeenMin: 14 * 1440, hours: 44.0, sessions: 33, chats: 88, matches: 16 }),
  acct({ id: 'grace', name: 'Grace Kim', username: 'gracek', email: 'grace.kim@northpoint.io', provider: 'Google', plan: 'Free', created: '2026-07-04', device: 'Galaxy Z Fold 7', city: 'Duluth, GA', role: 'PM, NCR Voyix', building: 'checkout voice assistant', event: 'AI Tinkerers ATL', where: '', online: false, lastSeenMin: 40 * 1440, hours: 27.5, sessions: 19, chats: 52, matches: 9 }),
  acct({ id: 'zoe', name: 'Zoe Martin', username: 'zoe.ble', email: 'zmartin@gatech.edu', provider: 'GitHub', plan: 'Free', created: '2026-09-01', device: 'iPhone 15', city: 'Atlanta, GA', role: 'ECE junior, Georgia Tech', building: 'BLE proximity badges', event: 'HackGT 13', where: 'Klaus, table 7', online: true, lastSeenMin: 0, hours: 33.0, sessions: 22, chats: 58, matches: 10 }),
  acct({ id: 'kai', name: 'Kai Brooks', username: 'kaibrooks', email: 'kai.brooks@voltmail.net', provider: 'Apple', plan: 'Free', created: '2026-08-27', device: 'iPhone 16', city: 'Atlanta, GA', role: 'Hardware engineer, Rivian', building: 'battery telemetry dashboards', event: 'HackGT 13', where: 'Klaus, table 9', online: true, lastSeenMin: 0, hours: 26.5, sessions: 17, chats: 44, matches: 8 }),
  acct({ id: 'sam', name: 'Sam Patel', username: 'sampatel', email: 'sam@patel.works', provider: 'Email', plan: 'Free', created: '2026-09-12', device: 'Pixel 8a', city: 'Marietta, GA', role: 'Freelance full-stack', building: 'Shopify inventory sync', event: 'HackGT 13', where: '', online: false, lastSeenMin: 1300, hours: 12.8, sessions: 9, chats: 21, matches: 3 }),
  acct({ id: 'leo', name: 'Leo Park', username: 'leopark', email: 'leo.park@inboxly.com', provider: 'Google', plan: 'Pro', created: '2026-05-02', device: 'iPhone 16 Pro', city: 'Atlanta, GA', role: 'Staff engineer, Mailchimp', building: 'on-device email summarizer', event: 'AI Tinkerers ATL', where: 'Ponce City Market', online: true, lastSeenMin: 0, hours: 29.8, sessions: 21, chats: 57, matches: 12 }),
  acct({ id: 'hana', name: 'Hana Sato', username: 'hanamakes', email: 'hana@shopagents.co', provider: 'Apple', plan: 'Pro', created: '2026-02-26', device: 'iPhone 16 Pro', city: 'Decatur, GA', role: 'Indie hacker', building: 'agent marketplace for local shops', event: 'AI Tinkerers ATL', where: 'Ponce City Market', online: true, lastSeenMin: 0, hours: 58.1, sessions: 44, chats: 109, matches: 21 }),
  acct({ id: 'omar', name: 'Omar Haddad', username: 'omar.vc', email: 'omar@atlventures.vc', provider: 'Google', plan: 'Pro', created: '2026-06-17', device: 'Pixel 10 Pro', city: 'Atlanta, GA', role: 'Associate, Atlanta Ventures', building: 'thesis on agent infra', event: 'AI Tinkerers ATL', where: 'Ponce City Market', online: true, lastSeenMin: 0, hours: 22.6, sessions: 18, chats: 39, matches: 6 }),
  acct({ id: 'tomas', name: 'Tomás Reyes', username: 'treyes', email: 'tomas.reyes@mailbox.org', provider: 'Email', plan: 'Free', created: '2026-07-29', device: 'Pixel 9 Pro', city: 'Las Vegas, NV', role: 'Security researcher', building: 'prompt-injection scanner', event: 'DEF CON 34', where: '', online: false, lastSeenMin: 50_000, hours: 35.2, sessions: 24, chats: 67, matches: 7 }),
  acct({ id: 'aiko', name: 'Aiko Tanaka', username: 'aiko.t', email: 'aiko.t@fastmail.jp', provider: 'Apple', plan: 'Free', created: '2026-06-05', device: 'iPhone 15 Pro', city: 'San Francisco, CA', role: 'iOS engineer, Cash App', building: 'offline-first wallet UI', event: 'Config 2026', where: '', online: false, lastSeenMin: 140_000, hours: 19.9, sessions: 14, chats: 36, matches: 4 }),
  acct({ id: 'ravi', name: 'Ravi Menon', username: 'ravi.canopy', email: 'ravi@canopycarbon.earth', provider: 'Google', plan: 'Pro', created: '2026-03-03', device: 'Galaxy S25', city: 'Atlanta, GA', role: 'Founder, Canopy Carbon', building: 'tree-cover MRV from satellites', event: 'Climate Week ATL', where: '', online: false, lastSeenMin: 7 * 1440, hours: 24.4, sessions: 16, chats: 41, matches: 8 }),
  acct({ id: 'lena', name: 'Lena Ortiz', username: 'lena.builds', email: 'lortiz@gatech.edu', provider: 'GitHub', plan: 'Free', created: '2026-09-18', device: 'iPhone 14', city: 'Atlanta, GA', role: 'ME sophomore, Georgia Tech', building: 'rover drive train', event: 'HackGT 13', where: '', online: false, lastSeenMin: 1500, hours: 9.6, sessions: 7, chats: 15, matches: 2 }),
]

// people who sign up while the recorder is running
export const SIGNUPS: Account[] = [
  acct({ id: 'rohan', name: 'Rohan Iyer', username: 'rohan.builds', email: 'riyer7@gatech.edu', provider: 'Google', plan: 'Free', created: 'today', device: 'iPhone 15', city: 'Atlanta, GA', role: 'CS freshman, Georgia Tech', building: 'campus lost-and-found bot', event: 'HackGT 13', where: 'Klaus atrium', online: true, lastSeenMin: 0, hours: 0, sessions: 0, chats: 0, matches: 0 }),
  acct({ id: 'chloe', name: 'Chloe Nguyen', username: 'chloe.n', email: 'chloe@nguyen.design', provider: 'Apple', plan: 'Free', created: 'today', device: 'iPhone 16', city: 'Atlanta, GA', role: 'UX researcher', building: 'accessibility audit agent', event: 'AI Tinkerers ATL', where: 'Ponce City Market', online: true, lastSeenMin: 0, hours: 0, sessions: 0, chats: 0, matches: 0 }),
  acct({ id: 'marcus', name: 'Marcus Webb', username: 'mwebb', email: 'm.webb@tallpine.co', provider: 'Email', plan: 'Free', created: 'today', device: 'Pixel 10', city: 'Atlanta, GA', role: 'Founder, Tallpine Freight', building: 'freight quoting API', event: 'HackGT 13', where: 'sponsor row', online: true, lastSeenMin: 0, hours: 0, sessions: 0, chats: 0, matches: 0 }),
  acct({ id: 'isabel', name: 'Isabel Ortega', username: 'isa.codes', email: 'isabel.ortega@streamline.dev', provider: 'GitHub', plan: 'Free', created: 'today', device: 'Galaxy S26', city: 'Atlanta, GA', role: 'Data engineer', building: 'streaming ETL for retail', event: 'HackGT 13', where: 'Klaus, table 11', online: true, lastSeenMin: 0, hours: 0, sessions: 0, chats: 0, matches: 0 }),
]

// avatar order is stable across both lists so a person keeps their bean
export const ORDER = [...ACCOUNTS, ...SIGNUPS].map((a) => a.id)

export const SOURCES = ['GitHub', 'Google Calendar', 'LinkedIn', 'Notes', 'Resume', 'Posts']
