// Typed client for the facemash admin API (contract v1): /api/admin/me, overview, talks, talks/{id}
// and the SSE stream. `connectLive` wraps the stream with an automatic fallback to polling the
// live talks every 3 s, so the admin keeps updating behind proxies that break SSE.

export type Side = 'a' | 'b'
export type TalkStatus = 'live' | 'done' | 'abandoned'
export type StopPoint = 'checkpoint1' | 'checkpoint2' | 'cap' | 'error'
export type LineKind = 'greeting' | 'question' | 'answer' | 'close'

export interface Person {
  id: number
  first_name: string
  /** Bean Studio look string: "b=#..;a=#..;p=..;e=..;h=..;i=.." */
  bean: string
  source: 'muse' | 'voice' | null
}

/** jev's five scores, each 1-5. */
export interface Scores {
  value_a: number
  value_b: number
  soon: number
  talk_again: number
  depth: number
}

export interface Pair<T> {
  a: T
  b: T
}

export interface TalkSummary {
  id: string
  status: TalkStatus
  started_at: string
  ended_at: string | null
  a: Person
  b: Person
  turns: number
  stopped_at: StopPoint | null
  match: boolean | null
  reason: string | null
  /** 0-100 */
  overall: number | null
  scores: Scores | null
  approvals: Pair<boolean | null>
  revealed: boolean
  worth_it: Pair<boolean | null>
  withheld: number
  config_version: string
}

/**
 * One thing an agent said. `withheld` means the guard dropped some or all of it (the dropped words
 * are never sent, only `withheld_reason`); `text` is what was actually said aloud, possibly empty.
 */
export interface Line {
  at: string
  from: Side
  kind: LineKind
  text: string
  question_id: string | null
  cites: string[]
  withheld: boolean
  withheld_reason: string | null
}

export interface Choice {
  choice: string
  confidence: number
}

export interface Checkpoint {
  name: 'checkpoint1' | 'checkpoint2'
  /** null when the engine did not time it */
  at: string | null
  /** gate name -> probability 0-1 */
  gates: Record<string, number>
  scores: Scores | null
  /** usually "reason" and "opener"; either may be missing */
  choices: Record<string, Choice> | null
  passed: boolean
}

export interface TalkDetail extends TalkSummary {
  lines: Line[]
  checkpoints: Checkpoint[]
  hot_topics: string[]
  icebreaker: { line: string; question: string } | null
  timings_ms: { first_bubble: number | null; checkpoint1: number | null; verdict: number | null; reveal: number | null }
}

export interface Overview {
  users_total: number
  users_signed_in_today: number
  active_now: number
  in_klaus_now: number
  activity_hours_total: number | null
  memories_total: number
  muse_connected: number
  voice_onboarded: number | null
  talks_total: number
  talks_live: number
  talks_today: number
  matches_total: number
  approvals_both: number
  reveals_total: number
  worth_it_yes: number
  worth_it_no: number
  withheld_lines_total: number
  as_of: string
}

export interface UsagePlay {
  people: number
  people_today: number
  sessions: number
  sessions_today: number
  hours: number
  hours_today: number
  active_hours: number
  hall_hours: number
  avg_session_min: number
  median_session_min: number
  avg_per_person_min: number
  returning: number
  peak_online: number
  peak_at: string | null
  online_now: number
}

export interface UsageService {
  kind: 'gemini' | 'jev' | 'voice' | string
  model: string
  calls: number
  failed: number
  calls_today: number
  tokens_in: number
  tokens_out: number
  minutes: number
  cost_usd: number | null
  cost_today_usd: number | null
}

/** /api/admin/usage: time in the game and what the paid services were used for */
export interface UsageSpeed {
  talks: number
  questions_per_talk: number
  picks: number
  pick_p50_ms: number
  pick_p90_ms: number
  pick_failed: number
  avg_options: number
  answers: number
  first_words_p50_ms: number
  first_words_p90_ms: number
  answer_p50_ms: number
  hours_back: number
}

export interface Usage {
  speed?: UsageSpeed
  play: UsagePlay
  hourly: { hour: string; people: number; minutes: number }[]
  top: (Person & { minutes: number; sessions: number })[]
  voice: { calls: number; minutes: number; avg_call_sec: number; people: number }
  services: UsageService[]
  cost_usd: number | null
  cost_today_usd: number | null
  as_of: string
}

export interface Me {
  admin: boolean
  email: string
  tenant: string
}

export interface TalkQuery {
  status?: 'live' | 'done' | 'all'
  match?: boolean
  limit?: number
  cursor?: string | null
}

export interface Page<T> {
  items: T[]
  next: string | null
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Raw stream callbacks. `error` means the stream is down (the caller decides what to do). */
export interface StreamHandlers {
  open(): void
  error(): void
  talk(t: TalkSummary): void
  line(talkId: string, line: Line): void
  overview(o: Overview): void
}

export interface AdminApi {
  me(): Promise<Me>
  overview(): Promise<Overview>
  usage(): Promise<Usage>
  talks(q?: TalkQuery): Promise<Page<TalkSummary>>
  talk(id: string): Promise<TalkDetail>
  /** Opens the event stream; returns a function that closes it. */
  stream(h: StreamHandlers): () => void
}

// ---------------------------------------------------------------- HTTP implementation

// ?include_test on the page passes include_test=true through (the server hides @facemash.test accounts)
const EXTRA = typeof location !== 'undefined' && new URLSearchParams(location.search).has('include_test') ? 'include_test=true' : ''
const withExtra = (path: string) => (EXTRA ? `${path}${path.includes('?') ? '&' : '?'}${EXTRA}` : path)

// Go encodes empty slices/maps as null in places; the views expect arrays and objects
export function normLine(l: Line): Line {
  return { ...l, cites: l.cites ?? [], text: l.text ?? '', question_id: l.question_id ?? null, withheld_reason: l.withheld_reason ?? null }
}
export function normSummary<T extends TalkSummary>(t: T): T {
  return { ...t, approvals: t.approvals ?? { a: null, b: null }, worth_it: t.worth_it ?? { a: null, b: null }, withheld: t.withheld ?? 0, turns: t.turns ?? 0 }
}
export function normDetail(d: TalkDetail): TalkDetail {
  return {
    ...normSummary(d),
    lines: (d.lines ?? []).map(normLine),
    checkpoints: (d.checkpoints ?? []).map((c) => ({ ...c, at: c.at ?? null, gates: c.gates ?? {}, scores: c.scores ?? null, choices: c.choices ?? null })),
    hot_topics: d.hot_topics ?? [],
    icebreaker: d.icebreaker ?? null,
    timings_ms: { first_bubble: null, checkpoint1: null, verdict: null, reveal: null, ...((d.timings_ms ?? {}) as Partial<TalkDetail['timings_ms']>) },
  }
}

async function get<T>(path: string): Promise<T> {
  path = withExtra(path)
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' })
  } catch {
    throw new ApiError(0, 'network error')
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export function talksUrl(q: TalkQuery = {}) {
  const p = new URLSearchParams()
  if (q.status) p.set('status', q.status)
  if (q.match !== undefined) p.set('match', String(q.match))
  if (q.limit) p.set('limit', String(q.limit))
  if (q.cursor) p.set('cursor', q.cursor)
  const s = p.toString()
  return `/api/admin/talks${s ? `?${s}` : ''}`
}

export const httpApi: AdminApi = {
  me: () => get<Me>('/api/admin/me'),
  overview: () => get<Overview>('/api/admin/overview'),
  usage: async () => {
    const u = await get<Usage>('/api/admin/usage')
    return { ...u, hourly: u.hourly ?? [], top: u.top ?? [], services: u.services ?? [] }
  },
  talks: async (q) => {
    const page = await get<Page<TalkSummary>>(talksUrl(q))
    return { items: (page.items ?? []).map(normSummary), next: page.next ?? null }
  },
  talk: async (id) => normDetail(await get<TalkDetail>(`/api/admin/talks/${encodeURIComponent(id)}`)),
  stream(h) {
    if (typeof EventSource === 'undefined') {
      queueMicrotask(() => h.error())
      return () => {}
    }
    // same-origin EventSource sends the session cookie
    const es = new EventSource(withExtra('/api/admin/stream'))
    const parse = <T,>(e: Event): T | null => {
      try {
        return JSON.parse((e as MessageEvent).data) as T
      } catch {
        return null
      }
    }
    es.onopen = () => h.open()
    es.onerror = () => h.error()
    es.addEventListener('talk', (e) => {
      const t = parse<TalkSummary>(e)
      if (t?.id) h.talk(normSummary(t))
    })
    es.addEventListener('line', (e) => {
      // {"talk_id", "line": {...}}; also tolerate the line's fields inlined next to talk_id
      const d = parse<{ talk_id: string; line?: Line } & Partial<Line>>(e)
      if (!d?.talk_id) return
      const line = d.line ?? (d as unknown as Line)
      if (line && typeof line.from === 'string') h.line(d.talk_id, normLine(line))
    })
    es.addEventListener('overview', (e) => {
      const o = parse<Overview>(e)
      if (o) h.overview(o)
    })
    return () => es.close()
  },
}

// ---------------------------------------------------------------- live updates with fallback

export type LiveMode = 'connecting' | 'stream' | 'poll'

export interface LiveHandlers {
  mode(m: LiveMode): void
  talk(t: TalkSummary): void
  line(talkId: string, line: Line): void
  overview(o: Overview): void
  /** An API call failed (401/403 mean the session changed). */
  failure(e: ApiError): void
  /** Called after a gap (stream dropped / reconnected) so the caller can refetch open views. */
  resync(): void
}

export const POLL_MS = 3000
const OVERVIEW_POLL_MS = 10_000
const STREAM_RETRY_MS = 30_000
const STREAM_OPEN_TIMEOUT_MS = 6000

/**
 * Live updates: the SSE stream when it works; otherwise polls /talks?status=live every 3 s
 * (and the overview every 10 s), fetching a talk once more when it drops off the live list so
 * its final verdict lands. Retries the stream every 30 s while polling.
 */
export function connectLive(api: AdminApi, h: LiveHandlers): () => void {
  let closed = false
  let closeStream: (() => void) | null = null
  let pollTimer = 0
  let retryTimer = 0
  let openTimer = 0
  let streamUp = false
  let hadGap = false
  let lastOverview = 0
  let live = new Set<string>()

  const fail = (e: unknown) => {
    if (e instanceof ApiError) h.failure(e)
  }

  const pollOnce = async () => {
    if (closed || streamUp) return
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const page = await api.talks({ status: 'live', limit: 100 })
      if (closed || streamUp) return
      const now = new Set<string>()
      for (const t of page.items) {
        now.add(t.id)
        h.talk(t)
      }
      // talks that just finished: one fetch for their final state
      for (const id of live) if (!now.has(id)) api.talk(id).then((t) => !closed && h.talk(t), fail)
      live = now
      if (Date.now() - lastOverview >= OVERVIEW_POLL_MS) {
        lastOverview = Date.now()
        api.overview().then((o) => !closed && h.overview(o), fail)
      }
    } catch (e) {
      fail(e)
    }
  }

  const startPolling = () => {
    if (pollTimer || closed) return
    h.mode('poll')
    hadGap = true
    void pollOnce()
    pollTimer = window.setInterval(pollOnce, POLL_MS)
  }
  const stopPolling = () => {
    clearInterval(pollTimer)
    pollTimer = 0
  }

  const openStream = () => {
    if (closed) return
    closeStream?.()
    streamUp = false
    clearTimeout(openTimer)
    // a stream that never opens (buffering proxy) counts as down
    openTimer = window.setTimeout(() => !streamUp && dropStream(), STREAM_OPEN_TIMEOUT_MS)
    closeStream = api.stream({
      open() {
        clearTimeout(openTimer)
        streamUp = true
        stopPolling()
        h.mode('stream')
        if (hadGap) {
          hadGap = false
          h.resync()
        }
      },
      error() {
        dropStream()
      },
      talk: (t) => h.talk(t),
      line: (id, l) => h.line(id, l),
      overview: (o) => h.overview(o),
    })
  }

  const dropStream = () => {
    if (closed) return
    clearTimeout(openTimer)
    streamUp = false
    closeStream?.()
    closeStream = null
    startPolling()
    clearTimeout(retryTimer)
    retryTimer = window.setTimeout(openStream, STREAM_RETRY_MS)
  }

  h.mode('connecting')
  openStream()

  return () => {
    closed = true
    stopPolling()
    clearTimeout(retryTimer)
    clearTimeout(openTimer)
    closeStream?.()
  }
}

// ---------------------------------------------------------------- helpers shared by the views

export const ms = (t: string | null | undefined) => (t ? Date.parse(t) : NaN)

export const SCORE_KEYS: (keyof Scores)[] = ['value_a', 'value_b', 'soon', 'talk_again', 'depth']
