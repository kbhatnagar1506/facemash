import { JEV_DELAY, type Chat } from './data'

// Chats are replayed against the time the page loaded, so they run live while you watch.
export const LOAD = Date.now()

export const chatStart = (c: Chat) => LOAD - c.startedAgo * 1000

export function chatPhase(c: Chat, now: number) {
  const elapsed = (now - chatStart(c)) / 1000
  const last = c.msgs.at(-1)!.t
  const phase = elapsed < last ? 'live' : elapsed < last + JEV_DELAY ? 'classifying' : 'matched'
  return { elapsed, phase, visible: c.msgs.filter((m) => m.t <= elapsed) } as const
}

export type Phase = ReturnType<typeof chatPhase>
