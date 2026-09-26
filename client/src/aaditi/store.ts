import { useSyncExternalStore } from 'react'
import { CHATS, SCRIPTS, USER, fill, ok, type ChatDef, type Outcome, type SourceSpec } from './data'

// A tiny simulated backend. Chats advance on a timer; each message carries the sources
// the agent pulled about the user, with the times each one started, was fetched and settled.
// Status is a pure function of time, so the UI just renders `srcStatus(src, now)`.

export type Role = 'user' | 'agent' | 'operator' | 'system'
export type Src = { id: string; ref: string; outcome: Outcome; note?: string; at: number; verifyAt: number; doneAt: number }
export type Msg = {
  id: number
  role: Role
  text: string
  at: number
  streamMs: number
  settledAt: number
  latencyMs?: number
  sources: Src[]
}
export type Chat = ChatDef & {
  messages: Msg[]
  paused: boolean
  cursor: number
  round: number
  n: string
  phase: 'user' | 'agent'
  nextAt: number
  ackAt: number | null
}
export type SrcStatus = 'pulling' | 'verifying' | Outcome

export const srcStatus = (s: Src, t: number): SrcStatus | null =>
  t < s.at ? null : t < s.verifyAt ? 'pulling' : t < s.doneAt ? 'verifying' : s.outcome

const MAX_MESSAGES = 80
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const ticket = () => String(Math.floor(rand(1000, 9999)))
const vars = (c: Chat) => ({ ...USER[c.userId].vars, n: c.n })

let seq = 0
function makeMsg(role: Role, text: string, at: number, specs: SourceSpec[], v: Record<string, string>, latencyMs?: number): Msg {
  const id = ++seq
  const streamMs = role === 'agent' ? Math.min(3200, text.length * 16) : 0
  // user info is checked as soon as the message lands; an agent's citations resolve while it types
  let start = at + (role === 'agent' ? streamMs * 0.35 : 120)
  const sources = specs.map((s, i) => {
    const srcAt = start
    start += rand(90, 280)
    const verifyAt = srcAt + rand(160, 700)
    return {
      id: `${id}.${i}`,
      ref: fill(s.ref, v),
      outcome: s.outcome,
      note: s.note && fill(s.note, v),
      at: srcAt,
      verifyAt,
      doneAt: verifyAt + rand(350, 1500),
    }
  })
  const settledAt = Math.max(at + streamMs, ...sources.map((s) => s.doneAt))
  return { id, role, text, at, streamMs, settledAt, latencyMs, sources }
}

const push = (c: Chat, ...ms: Msg[]): Chat => ({ ...c, messages: [...c.messages, ...ms].slice(-MAX_MESSAGES) })

function userTurn(c: Chat, at: number): Chat {
  const script = SCRIPTS[c.agentId]
  const i = c.cursor % script.length
  const out: Msg[] = []
  if (i === 0 && c.cursor > 0) {
    c = { ...c, round: c.round + 1, n: ticket() }
    out.push(makeMsg('system', `new ticket · session ${c.round}`, at - 1, [], {}))
  }
  const v = vars(c)
  out.push(makeMsg('user', fill(script[i].u, v), at, script[i].us, v))
  return { ...push(c, ...out), phase: 'agent', nextAt: at + rand(1800, 4200) }
}

function agentTurn(c: Chat, at: number): Chat {
  const ex = SCRIPTS[c.agentId][c.cursor % SCRIPTS[c.agentId].length]
  const lastUser = c.messages.findLast((m) => m.role === 'user')
  const v = vars(c)
  const m = makeMsg('agent', fill(ex.a, v), at, ex.as, v, lastUser && at - lastUser.at)
  return { ...push(c, m), cursor: c.cursor + 1, phase: 'user', nextAt: at + m.streamMs + rand(6000, 14000) }
}

function step(c: Chat, now: number): Chat {
  if (c.paused) return c
  if (c.ackAt !== null && now >= c.ackAt) {
    const m = makeMsg('agent', "Operator note received. I'll follow it for the rest of this session.", now, [ok(`audit:operator-note/${c.n}`, 'logged to tenant audit trail')], vars(c))
    return { ...push(c, m), ackAt: null, nextAt: Math.max(c.nextAt, now + m.streamMs + 3000) }
  }
  if (now < c.nextAt) return c
  return c.phase === 'user' ? userTurn(c, now) : agentTurn(c, now)
}

// Start every chat with a bit of history so the panes aren't empty, then stagger the live start.
function seed(def: ChatDef, now: number): Chat {
  let c: Chat = { ...def, messages: [], paused: false, cursor: 0, round: 1, n: ticket(), phase: 'user', nextAt: 0, ackAt: null }
  const rounds = Math.random() < 0.5 ? 1 : 2
  let t = now - rounds * 32_000 - rand(5_000, 40_000)
  for (let k = 0; k < rounds; k++) {
    c = userTurn(c, t)
    t += rand(1800, 4200)
    c = agentTurn(c, t)
    t += rand(12_000, 22_000)
  }
  return { ...c, nextAt: now + rand(600, 9000) }
}

let state: Chat[] = CHATS.map((d) => seed(d, Date.now()))
const listeners = new Set<() => void>()
const set = (next: Chat[]) => {
  state = next
  listeners.forEach((l) => l())
}
const update = (chatId: string, fn: (c: Chat) => Chat) => set(state.map((c) => (c.id === chatId ? fn(c) : c)))

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  tick(now = Date.now()) {
    let changed = false
    const next = state.map((c) => {
      const s = step(c, now)
      if (s !== c) changed = true
      return s
    })
    if (changed) set(next)
  },
  // An operator note is checked like any other message: who sent it, and whether they may act on this tenant.
  send(chatId: string, text: string) {
    const now = Date.now()
    update(chatId, (c) => {
      const specs = [ok('auth:operator/console', 'console session, mfa ok'), ok(`policy:scope/${c.tenantId}`, `operator granted on ${c.tenantId}`)]
      return { ...push(c, makeMsg('operator', text, now, specs, {})), ackAt: now + 1400 }
    })
  },
  setPaused(chatId: string, paused: boolean) {
    update(chatId, (c) => ({ ...c, paused, nextAt: paused ? c.nextAt : Math.max(c.nextAt, Date.now() + 1000) }))
  },
}

setInterval(() => store.tick(), 200)

export const useChats = () => useSyncExternalStore(store.subscribe, store.get)
