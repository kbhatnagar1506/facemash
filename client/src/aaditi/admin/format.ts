import { ms, type Line, type Scores, type TalkSummary } from '../api'

// Small shared formatting for the admin views.

export const SCORE_LABEL: Record<keyof Scores, string> = {
  value_a: 'value A',
  value_b: 'value B',
  soon: 'meet soon',
  talk_again: 'talk again',
  depth: 'depth',
}

export const scoreLabel = (k: keyof Scores, t: Pick<TalkSummary, 'a' | 'b'>) =>
  k === 'value_a' ? `for ${t.a.first_name}` : k === 'value_b' ? `for ${t.b.first_name}` : SCORE_LABEL[k]

export const STOP_LABEL: Record<string, string> = {
  checkpoint1: 'stopped at checkpoint 1',
  checkpoint2: 'judged at checkpoint 2',
  cap: 'hit the turn cap',
  error: 'ended with an error',
}

export type Phase = 'live' | 'judging' | 'match' | 'nomatch' | 'done' | 'abandoned'

/** What the talk is doing now. A live talk whose last line is a goodbye is being judged. */
export function phaseOf(t: TalkSummary, lines?: Line[] | null): Phase {
  if (t.status === 'live') return lines?.length && lines[lines.length - 1].kind === 'close' ? 'judging' : 'live'
  if (t.status === 'abandoned') return 'abandoned'
  if (t.match === true) return 'match'
  if (t.match === false) return 'nomatch'
  return 'done'
}

export function pillText(p: Phase, t: TalkSummary, spin: string) {
  switch (p) {
    case 'live':
      return '● LIVE'
    case 'judging':
      return `${spin} JEV`
    case 'match':
      return `MATCH${t.overall != null ? ` ${Math.round(t.overall)}%` : ''}`
    case 'nomatch':
      return `NO MATCH${t.overall != null ? ` · ${Math.round(t.overall)}%` : ''}`
    case 'abandoned':
      return 'ABANDONED'
    default:
      return 'DONE'
  }
}

export const mmss = (s: number) => {
  s = Math.max(0, Math.floor(s))
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Seconds the talk has run (or ran). */
export const duration = (t: TalkSummary, now: number) => ((Number.isFinite(ms(t.ended_at)) ? ms(t.ended_at) : now) - ms(t.started_at)) / 1000

export const secs = (msv: number | null | undefined) => (msv == null ? '—' : msv < 1000 ? `${msv} ms` : `${(msv / 1000).toFixed(1)} s`)

export const yn = (v: boolean | null | undefined) => (v === true ? '✓' : v === false ? '✗' : '…')
export const ynWord = (v: boolean | null | undefined, yes: string, no: string, wait = 'waiting') => (v === true ? yes : v === false ? no : wait)

export const fmtInt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())
export const pct = (p: number) => `${Math.round(p * 100)}%`
