import { useSyncExternalStore } from 'react'
import { ACCOUNTS, SIGNUPS, SOURCES, type Account } from './data'

// The recorder: a log of everything that happens on the platform, per account.
// History for the last 24 h is reconstructed at start; after that events are recorded live.

export type Kind = 'signup' | 'signin' | 'signout' | 'radius' | 'chat' | 'withheld' | 'match' | 'scored' | 'profile'
export type Rec = { id: number; at: number; user: string; kind: Kind; text: string; with?: string; score?: number }
// one sign-in to sign-out; `end` is null while the account is still signed in
export type Session = { id: string; user: string; start: number; end: number | null }

export const KIND_LABEL: Record<Kind, string> = {
  signup: 'sign-up',
  signin: 'sign-in',
  signout: 'sign-out',
  radius: 'in radius',
  chat: 'agent chat',
  withheld: 'withheld',
  match: 'match',
  scored: 'no match',
  profile: 'profile',
}

type State = {
  accounts: Account[]
  online: Record<string, boolean>
  sessionStart: Record<string, number>
  lastSeen: Record<string, number>
  events: Rec[]
  sessions: Session[]
  recording: boolean
  recordedMs: number // recording time before the current run
  runStart: number
  startedAt: number
}

const M = 60_000
const H = 60 * M
const DAY = 24 * H
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
const first = (a: Account) => a.name.split(' ')[0]

let seq = 0
const rec = (at: number, user: string, kind: Kind, text: string, extra: Partial<Rec> = {}): Rec => ({ id: ++seq, at, user, kind, text, ...extra })

const byId = (s: State, id: string) => s.accounts.find((a) => a.id === id)!
const sessionId = (user: string, start: number) => `${user}-${Math.round(start)}`
const openSession = (user: string, start: number): Session => ({ id: sessionId(user, start), user, start, end: null })
const closeSession = (list: Session[], user: string, end: number) => list.map((x) => (x.user === user && x.end === null ? { ...x, end } : x))

// ---------- rebuild the last 24 h ----------

function encounter(a: Account, b: Account, t: number, out: Rec[]) {
  out.push(rec(t, a.id, 'radius', `came within 15 m of ${b.name} at ${a.event}`, { with: b.id }))
  out.push(rec(t + rand(4, 30) * 1000, a.id, 'chat', `muse started talking to ${first(b)}'s agent`, { with: b.id }))
  const end = t + rand(1.5, 5) * M
  if (Math.random() < 0.15) out.push(rec(t + rand(40, 80) * 1000, a.id, 'withheld', `OpenClaw withheld an unsourced claim in the chat with ${first(b)}`, { with: b.id }))
  const score = Math.round(rand(38, 93))
  out.push(
    score >= 60
      ? rec(end, a.id, 'match', `jev matched ${first(a)} and ${first(b)} · ${score}% · first topic sent to both`, { with: b.id, score })
      : rec(end, a.id, 'scored', `jev scored the chat with ${first(b)} at ${score}%, below the match line`, { with: b.id, score }),
  )
}

function seed(now: number): State {
  const out: Rec[] = []
  const sessionsOut: Session[] = []
  const online: Record<string, boolean> = {}
  const sessionStart: Record<string, number> = {}
  const lastSeen: Record<string, number> = {}
  const from = now - DAY

  for (const a of ACCOUNTS) {
    online[a.id] = a.online
    lastSeen[a.id] = now - a.lastSeenMin * M
    const sessions: [number, number][] = []
    if (a.online) {
      const s = now - rand(25, 190) * M
      sessionStart[a.id] = s
      sessions.push([s, now])
      if (a.hours > 20) {
        const s2 = now - rand(15, 22) * H
        sessions.push([s2, s2 + rand(40, 140) * M])
      }
    } else if (a.lastSeenMin < 24 * 60) {
      const e = lastSeen[a.id]
      sessions.push([Math.max(from, e - rand(30, 140) * M), e])
    }
    for (const [s, e] of sessions) {
      if (s >= from) sessionsOut.push({ id: sessionId(a.id, s), user: a.id, start: s, end: e < now - 1000 ? e : null })
      out.push(rec(s, a.id, 'signin', `signed in on ${a.device}`))
      const peers = ACCOUNTS.filter((b) => b.id !== a.id && b.event === a.event)
      const n = Math.min(3, Math.floor((e - s) / (35 * M)))
      for (let i = 0; i < n && peers.length; i++) encounter(a, pick(peers), s + rand(0.1, 0.8) * (e - s), out)
      if (Math.random() < 0.3) out.push(rec(s + rand(2, 10) * M, a.id, 'profile', `connected ${pick(SOURCES)} to muse history`))
      if (e < now - 1000) out.push(rec(e, a.id, 'signout', 'signed out'))
    }
  }
  out.sort((x, y) => x.at - y.at)
  return {
    accounts: [...ACCOUNTS],
    online,
    sessionStart,
    lastSeen,
    events: out.filter((r) => r.at >= from && r.at <= now),
    sessions: sessionsOut.sort((x, y) => x.start - y.start),
    recording: true,
    recordedMs: 0,
    runStart: now,
    startedAt: now,
  }
}

// ---------- the store ----------

let state = seed(Date.now())
const listeners = new Set<() => void>()
const set = (next: State) => {
  state = next
  listeners.forEach((l) => l())
}
const push = (...rs: Rec[]) => set({ ...state, events: [...state.events, ...rs] })

// follow-ups (the chat and jev's call after two people meet), kept while paused
type Job = { at: number; run: () => void }
let jobs: Job[] = []
const later = (ms: number, run: () => void) => jobs.push({ at: Date.now() + ms, run })

// sign-ups arrive on a schedule so the account count visibly moves
SIGNUPS.forEach((a, i) =>
  later(35_000 + i * 70_000 + rand(0, 15_000), () => {
    const now = Date.now()
    set({
      ...state,
      accounts: [...state.accounts, a],
      online: { ...state.online, [a.id]: true },
      sessionStart: { ...state.sessionStart, [a.id]: now },
      sessions: [...state.sessions, openSession(a.id, now)],
      events: [
        ...state.events,
        rec(now, a.id, 'signup', `created an account with ${a.provider} · ${a.email}`),
        rec(now + 1, a.id, 'signin', `signed in on ${a.device}`),
      ],
    })
  }),
)

function meet() {
  const on = state.accounts.filter((a) => state.online[a.id])
  const a = pick(on)
  const peers = on.filter((b) => b.id !== a.id && b.event === a.event)
  if (!a || !peers.length) return
  const b = pick(peers)
  const now = Date.now()
  push(rec(now, a.id, 'radius', `came within 15 m of ${b.name} at ${a.event}`, { with: b.id }))
  later(rand(2000, 5000), () => push(rec(Date.now(), a.id, 'chat', `muse started talking to ${first(b)}'s agent`, { with: b.id })))
  if (Math.random() < 0.18) later(rand(9000, 16000), () => push(rec(Date.now(), a.id, 'withheld', `OpenClaw withheld an unsourced claim in the chat with ${first(b)}`, { with: b.id })))
  later(rand(20_000, 40_000), () => {
    const score = Math.round(rand(38, 93))
    push(
      score >= 60
        ? rec(Date.now(), a.id, 'match', `jev matched ${first(a)} and ${first(b)} · ${score}% · first topic sent to both`, { with: b.id, score })
        : rec(Date.now(), a.id, 'scored', `jev scored the chat with ${first(b)} at ${score}%, below the match line`, { with: b.id, score }),
    )
  })
}

function signOut() {
  const on = state.accounts.filter((a) => state.online[a.id])
  if (on.length <= 7) return meet()
  const a = pick(on)
  const now = Date.now()
  set({
    ...state,
    online: { ...state.online, [a.id]: false },
    lastSeen: { ...state.lastSeen, [a.id]: now },
    sessions: closeSession(state.sessions, a.id, now),
    events: [...state.events, rec(now, a.id, 'signout', 'signed out')],
  })
}

function signIn() {
  const now = Date.now()
  const off = state.accounts.filter((a) => !state.online[a.id] && now - state.lastSeen[a.id] < 3 * DAY)
  if (!off.length) return meet()
  const a = pick(off)
  set({
    ...state,
    online: { ...state.online, [a.id]: true },
    sessionStart: { ...state.sessionStart, [a.id]: now },
    sessions: [...state.sessions, openSession(a.id, now)],
    events: [...state.events, rec(now, a.id, 'signin', `signed in on ${a.device}`)],
  })
}

function profile() {
  const on = state.accounts.filter((a) => state.online[a.id])
  if (!on.length) return
  const a = pick(on)
  push(rec(Date.now(), a.id, 'profile', pick([`connected ${pick(SOURCES)} to muse history`, `updated what they're building: ${a.building}`, 'synced Google Calendar for event times'])))
}

let nextAt = Date.now() + 1500
let pausedAt = 0
setInterval(() => {
  if (!state.recording) return
  const now = Date.now()
  const due = jobs.filter((j) => j.at <= now)
  if (due.length) {
    jobs = jobs.filter((j) => j.at > now)
    due.forEach((j) => j.run())
  }
  if (now < nextAt) return
  nextAt = now + rand(1800, 4200)
  const r = Math.random()
  if (r < 0.55) meet()
  else if (r < 0.66) signOut()
  else if (r < 0.8) signIn()
  else profile()
}, 250)

export const recorder = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  toggle() {
    const now = Date.now()
    if (state.recording) {
      pausedAt = now
      set({ ...state, recording: false, recordedMs: state.recordedMs + (now - state.runStart) })
    } else {
      // shift pending follow-ups by the pause so a chat doesn't end the instant you resume
      const gap = now - pausedAt
      jobs = jobs.map((j) => ({ ...j, at: j.at + gap }))
      nextAt += gap
      set({ ...state, recording: true, runStart: now })
    }
  },
}

export const useRecorder = () => useSyncExternalStore(recorder.subscribe, recorder.get)

// ---------- derived numbers ----------

export const recordingMs = (s: State, now: number) => s.recordedMs + (s.recording ? now - s.runStart : 0)

export const involves = (r: Rec, id: string) => r.user === id || r.with === id

export function stats(s: State, a: Account, now: number) {
  let sessions = a.sessions
  let chats = a.chats
  let matches = a.matches
  let last = s.lastSeen[a.id] // latest recorded activity; the UI shows "now" for online accounts
  for (const r of s.events) {
    if (!involves(r, a.id)) continue
    if (r.kind === 'signin' && r.user === a.id) sessions++
    if (r.kind === 'chat') chats++
    if (r.kind === 'match') matches++
    last = Math.max(last, r.at)
  }
  const liveHours = s.online[a.id] && s.sessionStart[a.id] ? (now - s.sessionStart[a.id]) / H : 0
  return { sessions, chats, matches, hours: a.hours + liveHours, last }
}

export type Stats = ReturnType<typeof stats>

export const sessionMs = (x: Session, now: number) => (x.end ?? now) - x.start

// the numbers the recorder stores: how many sessions, how long in total, how many still open
export function sessionTotals(list: Session[], now: number) {
  const closed = list.filter((x) => x.end !== null)
  const totalMs = list.reduce((t, x) => t + sessionMs(x, now), 0)
  const closedMs = closed.reduce((t, x) => t + sessionMs(x, now), 0)
  return {
    count: list.length,
    open: list.length - closed.length,
    totalMs,
    avgMs: closed.length ? closedMs / closed.length : 0,
    longestMs: list.reduce((m, x) => Math.max(m, sessionMs(x, now)), 0),
  }
}

// ---------- export ----------

const csvCell = (v: string | number | undefined) => {
  const s = v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCSV(s: State, events = s.events) {
  const head = ['time', 'account_id', 'username', 'name', 'event', 'detail', 'with_username', 'score']
  const rows = events.map((r) => {
    const a = byId(s, r.user)
    const w = r.with ? byId(s, r.with) : undefined
    return [new Date(r.at).toISOString(), a.accountId, a.username, a.name, r.kind, r.text, w?.username, r.score].map(csvCell).join(',')
  })
  return [head.join(','), ...rows].join('\n')
}

export function sessionsCSV(s: State, now: number, list = s.sessions) {
  const head = ['session_id', 'account_id', 'username', 'name', 'started_at', 'ended_at', 'duration_seconds', 'open']
  const rows = list.map((x) => {
    const a = byId(s, x.user)
    return [x.id, a.accountId, a.username, a.name, new Date(x.start).toISOString(), x.end ? new Date(x.end).toISOString() : '', Math.round(sessionMs(x, now) / 1000), x.end ? 'no' : 'yes']
      .map(csvCell)
      .join(',')
  })
  return [head.join(','), ...rows].join('\n')
}

export function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
