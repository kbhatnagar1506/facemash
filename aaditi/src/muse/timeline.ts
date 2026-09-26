import { PEOPLE, type Person } from './data'

// Everything is a function of t (seconds since page load): when each reply lands,
// when jev classifies, and where each node sits in the web.

export const T0 = Date.now()
export const UNSCORED_R = 430 // outer orbit: in range, not classified yet
export const DATA_R = 84 // your data sits in a ring around you

export type Phase = 'hidden' | 'handshake' | 'talking' | 'classifying' | 'matched'
type Timeline = { at: number[]; end: number; classify: number; appear: number }

export const TL: Record<string, Timeline> = {}
for (const p of PEOPLE) {
  let t = p.start
  const at = p.turns.map((turn, i) => {
    if (i > 0) t += 2.4 + turn.text.length / 36 // time to "write" the reply
    return t
  })
  const end = at[at.length - 1]
  TL[p.id] = { at, end, classify: end + 3.2, appear: p.start - 3 }
}

export function phase(p: Person, t: number): Phase {
  const tl = TL[p.id]
  if (t < tl.appear) return 'hidden'
  if (t < p.start) return 'handshake'
  if (t < tl.end + 0.6) return 'talking'
  if (t < tl.classify) return 'classifying'
  return 'matched'
}

export const shownTurns = (p: Person, t: number) => p.turns.filter((_, i) => TL[p.id].at[i] <= t)
export const turnTime = (p: Person, i: number) => T0 + TL[p.id].at[i] * 1000

// closer = more similar, like nearest neighbours in a vector space
const scoreR = (s: number) => 118 + (100 - s) * 3.3
const ease = (k: number) => 1 - (1 - k) ** 3

export function personPos(p: Person, i: number, t: number) {
  const tl = TL[p.id]
  const k = Math.min(1, Math.max(0, (t - tl.classify) / 1.8))
  const r = UNSCORED_R + (scoreR(p.score.overall) - UNSCORED_R) * ease(k)
  const a = (i / PEOPLE.length) * Math.PI * 2 - Math.PI / 2 + 0.28
  const drift = 4
  return {
    x: Math.cos(a) * r + Math.sin(t * 0.45 + i * 1.7) * drift,
    y: Math.sin(a) * r + Math.cos(t * 0.38 + i * 2.3) * drift,
    a,
    k,
  }
}

export function dataPos(j: number, n: number, t: number) {
  const a = (j / n) * Math.PI * 2 - Math.PI / 2
  return { x: Math.cos(a) * DATA_R + Math.sin(t * 0.6 + j) * 1.5, y: Math.sin(a) * DATA_R + Math.cos(t * 0.5 + j) * 1.5, a }
}
