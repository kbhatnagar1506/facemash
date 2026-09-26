// Agent talk on this phone: the frames the server pushes over the game socket, folded into
// one small store the overlay renders from. Lives in the main bundle (it has to hear the
// first frames); the overlay itself is a lazy chunk.
//
// Frames (server/agenttalk.go):
//   encounter {id, other:{bean}}                          someone's agent is here; no names
//   agents    {id, line:{n, from, text, typing?, partial?}} bubbles, streamed
//   verdict   {id, match:false} | {id, match:true, why, ask}
//   reveal    {id, other:{name, where}, icebreaker:{line, question}}   only after both said yes
//   closed    {id}                                         someone skipped, or time ran out

import type { Net, TalkFrame } from '../net'

export type From = 'your_agent' | 'their_agent'

export interface TalkLine {
  n: number
  from: From
  text: string
  typing: boolean
}

export type Phase = 'talking' | 'match' | 'waiting' | 'nomatch' | 'reveal' | 'closed'

export interface Talk {
  id: string
  bean?: string
  lines: TalkLine[]
  phase: Phase
  why?: string
  reveal?: { name: string; where: string; line: string; question: string }
  sending?: boolean
}

type Frame = TalkFrame & Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export class TalkStore {
  /** Talks not yet dismissed, oldest first; the first one is on screen. */
  talks: Talk[] = []
  private listeners = new Set<() => void>()
  private off: () => void

  constructor(net: Net) {
    this.off = net.onTalk((f) => this.frame(f as Frame))
  }

  close() {
    this.off()
  }

  get active(): Talk | null {
    return this.talks[0] ?? null
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  snapshot = () => this.talks

  private emit() {
    for (const fn of this.listeners) fn()
  }

  private update(id: string, fn: (t: Talk) => Talk | null) {
    let found = false
    const next: Talk[] = []
    for (const t of this.talks) {
      if (t.id !== id) {
        next.push(t)
        continue
      }
      found = true
      const u = fn(t)
      if (u) next.push(u)
    }
    if (!found) {
      const u = fn({ id, lines: [], phase: 'talking' })
      if (u) next.push(u)
    }
    this.talks = next
    this.emit()
  }

  frame(f: Frame) {
    if (f.t === 'reconnected') {
      for (const t of this.talks) if (t.phase === 'talking' || t.phase === 'match' || t.phase === 'waiting') this.refresh(t.id)
      return
    }
    const id = typeof f.id === 'string' ? f.id : ''
    if (!id.startsWith('tk_')) return
    switch (f.t) {
      case 'encounter':
        this.update(id, (t) => ({ ...t, bean: f.other?.bean ?? t.bean }))
        break
      case 'agents': {
        const l = f.line ?? {}
        if (typeof l.n !== 'number') return
        const line: TalkLine = { n: l.n, from: l.from === 'your_agent' ? 'your_agent' : 'their_agent', text: String(l.text ?? ''), typing: !!l.typing }
        this.update(id, (t) => {
          const lines = t.lines.filter((x) => x.n !== line.n)
          lines.push(line)
          lines.sort((a, b) => a.n - b.n)
          return { ...t, lines }
        })
        break
      }
      case 'verdict':
        this.update(id, (t) => ({
          ...t,
          lines: t.lines.filter((l) => !l.typing || l.text),
          phase: t.phase === 'reveal' ? t.phase : f.match ? (t.phase === 'waiting' ? 'waiting' : 'match') : 'nomatch',
          why: typeof f.why === 'string' ? f.why : t.why,
        }))
        break
      case 'reveal':
        this.update(id, (t) => ({
          ...t,
          phase: 'reveal',
          reveal: {
            name: String(f.other?.name ?? ''),
            where: String(f.other?.where ?? ''),
            line: String(f.icebreaker?.line ?? ''),
            question: String(f.icebreaker?.question ?? ''),
          },
        }))
        break
      case 'closed':
        this.update(id, (t) => (t.phase === 'reveal' ? t : { ...t, phase: 'closed' }))
        break
    }
  }

  /** After a dropped socket: fetch where the talk is now. */
  async refresh(id: string) {
    try {
      const r = await fetch(`/api/talk/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      if (!r.ok) return
      const v = await r.json()
      this.update(id, (t) => {
        const lines: TalkLine[] = (v.lines ?? []).map((l: { n: number; from: string; text: string }) => ({
          n: l.n, from: l.from === 'your_agent' ? 'your_agent' : 'their_agent', text: l.text, typing: false,
        }))
        let phase: Phase = t.phase
        if (v.state === 'no_match') phase = 'nomatch'
        else if (v.state === 'awaiting') phase = v.approved === 'approve' ? 'waiting' : 'match'
        else if (v.state === 'skipped' || v.state === 'expired' || v.state === 'error') phase = 'closed'
        const out: Talk = { ...t, lines: lines.length >= t.lines.length ? lines : t.lines, phase, why: v.why ?? t.why }
        if (v.state === 'revealed' && v.other?.name) {
          out.phase = 'reveal'
          out.reveal = { name: v.other.name, where: v.other.where ?? '', line: v.icebreaker?.line ?? '', question: v.icebreaker?.question ?? '' }
        }
        return out
      })
    } catch {
      /* offline: the next frame will do */
    }
  }

  /** Approve ("Meet them") or skip, after a match. */
  async decide(id: string, approve: boolean) {
    this.update(id, (t) => ({ ...t, sending: true }))
    let state = ''
    try {
      const r = await fetch(`/api/talk/${encodeURIComponent(id)}/${approve ? 'approve' : 'skip'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      state = (await r.json().catch(() => ({})))?.state ?? ''
      if (!r.ok && state !== 'revealed') state = state || 'closed'
    } catch {
      state = 'retry'
    }
    this.update(id, (t) => {
      if (!approve) return null // skipped: gone
      if (t.phase === 'reveal') return { ...t, sending: false }
      if (state === 'retry') return { ...t, sending: false }
      if (state === 'awaiting') return { ...t, sending: false, phase: 'waiting' }
      if (state === 'revealed') return { ...t, sending: false } // the reveal frame is on its way
      return { ...t, sending: false, phase: 'closed' }
    })
    if (state === 'revealed') setTimeout(() => this.active?.id === id && this.active.phase !== 'reveal' && this.refresh(id), 1500)
  }

  dismiss(id: string) {
    this.update(id, () => null)
  }
}

// ---------- opt-in ----------

export interface OptIn {
  on: boolean
  live: boolean
  left?: number
  limit?: number
}

export async function getOptIn(): Promise<OptIn | null> {
  try {
    const r = await fetch('/api/talk/optin', { credentials: 'same-origin' })
    return r.ok ? ((await r.json()) as OptIn) : null
  } catch {
    return null
  }
}

export async function setOptIn(on: boolean): Promise<OptIn | null> {
  try {
    const r = await fetch('/api/talk/optin', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    })
    return r.ok ? ((await r.json()) as OptIn) : null
  } catch {
    return null
  }
}
