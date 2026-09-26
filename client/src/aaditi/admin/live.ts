import { useSyncExternalStore } from 'react'
import { ApiError, connectLive, ms, type AdminApi, type Line, type LiveMode, type Me, type Overview, type TalkDetail, type TalkQuery, type TalkSummary } from '../api'

// Everything the admin page knows, merged from paged lists, the live stream and opened talks.
// One store per page; views read it through useAdmin() and re-render at most once per frame.

export type Filter = 'all' | 'live' | 'done' | 'matches'
export type Auth = 'loading' | 'ok' | 'signin' | 'forbidden' | 'error'

type PageState = { next: string | null; started: boolean; loading: boolean; error: string | null }

const QUERY: Record<Filter, TalkQuery> = {
  all: { status: 'all' },
  live: { status: 'live' },
  done: { status: 'done' },
  matches: { status: 'all', match: true },
}

const PAGE = 50
const DETAIL_CONCURRENCY = 3

export const matchesFilter = (t: TalkSummary, f: Filter) =>
  f === 'all' || (f === 'live' ? t.status === 'live' : f === 'done' ? t.status !== 'live' : t.match === true)

export class AdminStore {
  api: AdminApi
  auth: Auth = 'loading'
  authError = ''
  me: Me | null = null
  overview: Overview | null = null
  mode: LiveMode = 'connecting'
  mock: boolean
  talks = new Map<string, TalkSummary>()
  /** full transcripts; for talks without one yet, lines seen on the stream */
  details = new Map<string, TalkDetail>()
  streamed = new Map<string, Line[]>()
  pages: Record<Filter, PageState> = {
    all: { next: null, started: false, loading: false, error: null },
    live: { next: null, started: false, loading: false, error: null },
    done: { next: null, started: false, loading: false, error: null },
    matches: { next: null, started: false, loading: false, error: null },
  }
  version = 0
  private listeners = new Set<() => void>()
  private frame = 0
  private stopLive: (() => void) | null = null
  private inflight = new Map<string, Promise<void>>()
  private queue: string[] = []
  private active = 0
  private stale = new Set<string>()
  /** transcripts that failed to load, and when: queued fetches wait 30 s before trying again */
  private failedAt = new Map<string, number>()

  constructor(api: AdminApi, mock = false) {
    this.api = api
    this.mock = mock
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getVersion = () => this.version

  private changed() {
    if (this.frame) return
    const flush = () => {
      this.frame = 0
      this.version++
      this.listeners.forEach((l) => l())
    }
    this.frame = typeof requestAnimationFrame === 'function' && !document.hidden ? requestAnimationFrame(flush) : window.setTimeout(flush, 50)
  }

  private fail(e: unknown) {
    if (!(e instanceof ApiError)) return false
    if (e.status === 401) this.auth = 'signin'
    else if (e.status === 403) this.auth = 'forbidden'
    else return false
    // never keep admin data around once the session stops being an organizer's
    this.stop()
    this.talks.clear()
    this.details.clear()
    this.streamed.clear()
    this.overview = null
    this.changed()
    return true
  }

  async start() {
    try {
      this.me = await this.api.me()
      if (!this.me.admin) {
        this.auth = 'forbidden'
        this.changed()
        return
      }
    } catch (e) {
      if (!this.fail(e)) {
        this.auth = 'error'
        this.authError = e instanceof Error ? e.message : String(e)
        this.changed()
      }
      return
    }
    this.auth = 'ok'
    this.changed()
    this.refreshOverview()
    void this.loadMore('all')
    this.stopLive = connectLive(this.api, {
      mode: (m) => {
        this.mode = m
        this.changed()
      },
      talk: (t) => this.upsert(t),
      line: (id, l) => this.addLine(id, l),
      overview: (o) => {
        this.overview = o
        this.changed()
      },
      failure: (e) => this.fail(e),
      resync: () => {
        this.refreshOverview()
        for (const t of this.talks.values()) if (t.status === 'live') this.stale.add(t.id)
        this.pages.live.started = false
        void this.loadMore('live')
      },
    })
  }

  stop() {
    this.stopLive?.()
    this.stopLive = null
  }

  refreshOverview() {
    this.api.overview().then(
      (o) => {
        this.overview = o
        this.changed()
      },
      (e) => this.fail(e),
    )
  }

  async loadMore(f: Filter) {
    const p = this.pages[f]
    if (p.loading || (p.started && !p.next)) return
    p.loading = true
    p.error = null
    this.changed()
    try {
      const page = await this.api.talks({ ...QUERY[f], limit: PAGE, cursor: p.started ? p.next : null })
      for (const t of page.items) this.upsert(t, false)
      p.next = page.next
      p.started = true
    } catch (e) {
      if (!this.fail(e)) p.error = e instanceof Error ? e.message : 'failed'
    } finally {
      p.loading = false
      this.changed()
    }
  }

  hasMore(f: Filter) {
    const p = this.pages[f]
    return !p.started || !!p.next
  }

  upsert(t: TalkSummary, notify = true) {
    const prev = this.talks.get(t.id)
    this.talks.set(t.id, prev ? { ...prev, ...t } : t)
    if ('lines' in t && Array.isArray((t as TalkDetail).lines)) this.setDetail(t as TalkDetail)
    else {
      const d = this.details.get(t.id)
      // a talk changed state (ended, scored, approved): its transcript/checkpoints need a refetch
      // (while polling there are no line events, so a new turn also means a refetch)
      const moved = d && (d.status !== t.status || d.match !== t.match || d.revealed !== t.revealed || JSON.stringify(d.approvals) !== JSON.stringify(t.approvals) || JSON.stringify(d.worth_it) !== JSON.stringify(t.worth_it))
      if (d && (moved || (this.mode === 'poll' && d.turns !== t.turns))) {
        this.details.set(t.id, { ...d, ...t })
        this.stale.add(t.id)
      }
    }
    if (notify) this.changed()
  }

  private setDetail(d: TalkDetail) {
    this.details.set(d.id, d)
    this.streamed.delete(d.id)
    this.stale.delete(d.id)
  }

  addLine(id: string, l: Line) {
    const d = this.details.get(id)
    const same = (x: Line) => x.at === l.at && x.from === l.from && x.text === l.text
    if (d) {
      if (!d.lines.some(same)) this.details.set(id, { ...d, lines: [...d.lines, l].sort((x, y) => ms(x.at) - ms(y.at)), turns: Math.max(d.turns, d.lines.length + 1) })
    } else {
      const s = this.streamed.get(id) ?? []
      if (!s.some(same)) this.streamed.set(id, [...s, l])
    }
    this.changed()
  }

  /** Lines for a talk as best known: the full transcript, or what the stream has shown so far. */
  lines(id: string): Line[] | null {
    return this.details.get(id)?.lines ?? this.streamed.get(id) ?? null
  }

  needsDetail(id: string) {
    return !this.details.has(id) || this.stale.has(id)
  }

  /** Fetch a transcript now (an opened chat) or queue it (graph cards), a few at a time. */
  ensureDetail(id: string, now = false): Promise<void> {
    const running = this.inflight.get(id)
    if (running) return running
    if (!this.needsDetail(id)) return Promise.resolve()
    if (!now) {
      if (Date.now() - (this.failedAt.get(id) ?? 0) < 30_000) return Promise.resolve()
      if (!this.queue.includes(id)) this.queue.push(id)
      this.pump()
      return Promise.resolve()
    }
    return this.fetchDetail(id)
  }

  private fetchDetail(id: string) {
    this.stale.delete(id)
    const p = this.api
      .talk(id)
      .then(
        (d) => {
          this.talks.set(id, { ...(this.talks.get(id) ?? d), ...stripDetail(d) })
          // keep stream lines that landed while the request was in flight
          const extra = (this.details.get(id)?.lines ?? this.streamed.get(id) ?? []).filter((l) => !d.lines.some((x) => x.at === l.at && x.text === l.text))
          this.setDetail(extra.length ? { ...d, lines: [...d.lines, ...extra] } : d)
          this.failedAt.delete(id)
        },
        (e) => {
          this.failedAt.set(id, Date.now())
          this.fail(e)
        },
      )
      .finally(() => {
        this.inflight.delete(id)
        this.changed()
      })
    this.inflight.set(id, p)
    return p
  }

  private pump() {
    while (this.active < DETAIL_CONCURRENCY && this.queue.length) {
      const id = this.queue.shift()!
      if (!this.needsDetail(id) || this.inflight.has(id)) continue
      this.active++
      this.fetchDetail(id).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  /** Drop queued fetches that are no longer on screen. */
  keepQueued(ids: Set<string>) {
    this.queue = this.queue.filter((id) => ids.has(id))
  }
}

function stripDetail(d: TalkDetail): TalkSummary {
  const { lines: _l, checkpoints: _c, hot_topics: _h, icebreaker: _i, timings_ms: _t, ...s } = d
  void _l, void _c, void _h, void _i, void _t
  return s
}

export function useAdmin(store: AdminStore) {
  return useSyncExternalStore(store.subscribe, store.getVersion)
}
