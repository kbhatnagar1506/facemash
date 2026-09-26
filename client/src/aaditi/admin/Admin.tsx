import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { SCORE_KEYS, httpApi, ms, type Line, type Overview, type Person, type TalkSummary } from '../api'
import { ago, hms, spinner, stamp, useNow } from '../ui/time'
import { Avatar } from './Avatar'
import { ChatFocus } from './ChatFocus'
import { SCORE_LABEL, duration, fmtInt, mmss, phaseOf, pillText, yn } from './format'
import { AdminStore, matchesFilter, useAdmin, type Filter } from './live'
import './admin.css'

// Architecture view of the platform: hub in the middle (the event's numbers), the people from the
// most recent agent talks around it, and each talk as a chat panel between its two people. A list
// view covers everything else. Data comes from /api/admin/*; ?mock=1 runs on a local mock.

const GRAPH_CAP = 30

const params = new URLSearchParams(location.search)
const MOCK = params.has('mock') || params.has('demo')

export function Admin() {
  const [store, setStore] = useState<AdminStore | null>(null)
  useEffect(() => {
    let s: AdminStore | null = null
    let dead = false
    const boot = MOCK ? import('../mock').then((m) => new AdminStore(m.createMockApi(params), true)) : Promise.resolve(new AdminStore(httpApi))
    boot.then((st) => {
      if (dead) return
      s = st
      setStore(st)
      void st.start()
    })
    return () => {
      dead = true
      s?.stop()
    }
  }, [])
  if (!store) return <Gate kind="loading" />
  return <Shell store={store} />
}

function Shell({ store }: { store: AdminStore }) {
  useAdmin(store)
  if (store.auth !== 'ok') return <Gate kind={store.auth} detail={store.authError} />
  return <Console store={store} />
}

function Gate({ kind, detail }: { kind: 'loading' | 'signin' | 'forbidden' | 'error'; detail?: string }) {
  return (
    <div className="adm acc-wrap">
      <div className="acc">
        <div className="t">Muse · admin</div>
        {kind === 'loading' && <p className="dim">{spinner(Date.now())} checking your access…</p>}
        {kind === 'signin' && (
          <>
            <h1>Sign in to continue</h1>
            <p>The admin portal is for HackGT organizers. Sign in with your Google account first.</p>
            <a className="btn" href="/?signin">
              Sign in →
            </a>
          </>
        )}
        {kind === 'forbidden' && (
          <>
            <h1>Organizers only</h1>
            <p>You're signed in, but this account isn't on the organizer list. Ask an organizer to add your email.</p>
            <a className="btn ghost" href="/">
              ← back to facemash
            </a>
          </>
        )}
        {kind === 'error' && (
          <>
            <h1>Admin API unavailable</h1>
            <p className="dim">{detail || 'The server did not answer.'}</p>
            <button className="btn" onClick={() => location.reload()}>
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  )
}

type ViewMode = 'graph' | 'list'
const FILTERS: { f: Filter; label: string }[] = [
  { f: 'all', label: 'all' },
  { f: 'live', label: 'live' },
  { f: 'done', label: 'done' },
  { f: 'matches', label: 'matches' },
]
const readPref = (): ViewMode | null => {
  try {
    const v = localStorage.getItem('admin.view')
    return v === 'graph' || v === 'list' ? v : null
  } catch {
    return null
  }
}

function Console({ store }: { store: AdminStore }) {
  const version = useAdmin(store)
  const now = useNow(500)
  const [view, setView] = useState<ViewMode>(() => (params.get('view') as ViewMode) || readPref() || (innerWidth < 700 ? 'list' : 'graph'))
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<{ id: string; origin: { x: number; y: number } } | null>(null)

  const pickView = (v: ViewMode) => {
    setView(v)
    try {
      localStorage.setItem('admin.view', v)
    } catch {
      /* private mode */
    }
  }

  useEffect(() => {
    if (!store.pages[filter].started) void store.loadMore(filter)
  }, [filter, store])

  // every talk we know about that fits the filter and search, newest first
  const talks = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out: TalkSummary[] = []
    for (const t of store.talks.values()) {
      if (!matchesFilter(t, filter)) continue
      if (needle && !`${t.a.first_name} ${t.b.first_name} ${t.id} #${t.a.id} #${t.b.id} ${t.reason ?? ''}`.toLowerCase().includes(needle)) continue
      out.push(t)
    }
    return out.sort((x, y) => ms(y.started_at) - ms(x.started_at))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, filter, q, store])

  const openTalk = useCallback((id: string, x: number, y: number) => setOpen({ id, origin: { x, y } }), [])
  const ov = store.overview
  const noTalksAtAll = store.pages.all.started && store.talks.size === 0

  // demo deep-link for screenshots: ?open=first opens the newest talk
  const autoOpened = useRef(false)
  useEffect(() => {
    const want = params.get('open')
    if (!want || autoOpened.current || !talks.length) return
    const t = want === 'first' ? talks[0] : want === 'match' ? talks.find((x) => x.match) : talks.find((x) => x.id === want)
    if (t) {
      autoOpened.current = true
      setOpen({ id: t.id, origin: { x: innerWidth / 2, y: innerHeight / 2 } })
    }
  }, [talks])

  return (
    <div className="adm">
      {view === 'graph' ? (
        <Graph store={store} talks={talks} ov={ov} now={now} empty={noTalksAtAll} onOpen={openTalk} version={version} filter={filter} q={q} />
      ) : (
        <List store={store} talks={talks} ov={ov} now={now} filter={filter} q={q} empty={noTalksAtAll} onOpen={openTalk} />
      )}

      <div className="overlay toolbar" role="toolbar" aria-label="Admin view options">
        <span className="tb-title">Muse · admin</span>
        <div className="seg" role="group" aria-label="View">
          {(['graph', 'list'] as const).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => pickView(v)}>
              {v}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Filter talks">
          {FILTERS.map(({ f, label }) => (
            <button key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <input className="search" type="search" placeholder="search name, #id, talk id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search talks" />
        <span className={`conn ${store.mode}`} title={store.mode === 'poll' ? 'The event stream is unavailable; polling every 3 s' : undefined}>
          {store.mock ? '◆ mock · ' : ''}{store.mode === 'stream' ? '● live' : store.mode === 'poll' ? '↻ polling 3 s' : `${spinner(now)} connecting`}
        </span>
      </div>

      {open && store.talks.has(open.id) && <ChatFocus store={store} id={open.id} now={now} origin={open.origin} onClose={() => setOpen(null)} />}
      {MOCK && <div className="mock-banner">MOCK DATA · not real attendees · remove ?mock=1 for the live event</div>}
    </div>
  )
}

// ======================================================================== hub numbers

function HubStats({ ov }: { ov: Overview | null }) {
  const hours = ov?.activity_hours_total
  return (
    <div className="hub-stats">
      <Stat n={1} v={fmtInt(ov?.users_total)} k="lifetime users to date" />
      <Stat n={2} v={hours == null ? '—' : hours.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} unit={hours == null ? undefined : 'h'} k="hours of activity to date" />
      <Stat n={3} v={fmtInt(ov?.active_now)} k="active users now" />
    </div>
  )
}

function HubFoot({ ov }: { ov: Overview | null }) {
  if (!ov) return <div className="hub-foot">loading numbers…</div>
  return (
    <div className="hub-foot">
      <span>
        <i className={`dot ${ov.talks_live ? 'live' : ''}`} /> {ov.talks_live} agent talks live
      </span>
      <span>
        {fmtInt(ov.talks_total)} talks · {fmtInt(ov.talks_today)} today
      </span>
      <span>
        jev matched {fmtInt(ov.matches_total)} · both approved {fmtInt(ov.approvals_both)} · {fmtInt(ov.reveals_total)} reveals
      </span>
      <span>
        worth it ✓{fmtInt(ov.worth_it_yes)} ✗{fmtInt(ov.worth_it_no)} · {fmtInt(ov.withheld_lines_total)} lines withheld
      </span>
      <span>
        {fmtInt(ov.users_signed_in_today)} signed in today · {fmtInt(ov.in_klaus_now)} in Klaus · {fmtInt(ov.muse_connected)} Muse agents · {fmtInt(ov.voice_onboarded)} voice
      </span>
    </div>
  )
}

function Stat({ n, v, k, unit }: { n: number; v: string; k: string; unit?: string }) {
  return (
    <div className="stat">
      <span className="stat-n">{n}</span>
      <div className="stat-v">
        {v}
        {unit && <small> {unit}</small>}
      </div>
      <div className="stat-k">{k}</div>
    </div>
  )
}


// ======================================================================== graph

const HUB = { w: 460, h: 310 }
const UBOX = { w: 230, h: 138 }
const CBOX = { w: 390, h: 400 }

type Pt = { x: number; y: number }
type Box = Pt & { w: number; h: number }
type PNode = { key: string; p: Person; talks: number; matches: number; live: boolean; last: number; box: Box }
type Layout = { people: PNode[]; chats: { t: TalkSummary; box: Box; a: string; b: string }[]; hub: Box; empty: Box | null }

const pkey = (p: Person) => `p${p.id}`
const TAU = Math.PI * 2
const onEllipse = (a: number, rx: number, ry: number): Pt => ({ x: Math.sin(a) * rx, y: -Math.cos(a) * ry })

function layoutGraph(talks: TalkSummary[], empty: boolean): Layout {
  const hub: Box = { x: 0, y: 0, ...HUB }
  // ring order: walk talks newest first, a then b, so partners usually sit side by side
  const order: string[] = []
  const nodes = new Map<string, Omit<PNode, 'box'>>()
  for (const t of talks) {
    for (const p of [t.a, t.b]) {
      const k = pkey(p)
      let n = nodes.get(k)
      if (!n) {
        n = { key: k, p, talks: 0, matches: 0, live: false, last: 0 }
        nodes.set(k, n)
        order.push(k)
      }
      n.talks++
      if (t.match) n.matches++
      if (t.status === 'live') n.live = true
      n.last = Math.max(n.last, ms(t.started_at))
    }
  }
  const n = order.length
  // grow the ellipses with the number of boxes (Ramanujan-ish perimeter for a 1.41:1 ellipse)
  const perim = 2 * Math.PI * 1.222
  const ry = Math.max(660, (n * 262) / perim)
  const rx = ry * 1.41
  const angleOf = new Map<string, number>()
  const people: PNode[] = order.map((k, i) => {
    const a = (i / Math.max(n, 1)) * TAU
    angleOf.set(k, a)
    return { ...nodes.get(k)!, box: { ...onEllipse(a, rx, ry), ...UBOX } }
  })

  const m = talks.length
  const cry = Math.max(ry + 350, (m * 450) / perim)
  const crx = Math.max(rx + 470, cry * 1.39)
  // each talk sits between its two people, then neighbours are nudged apart so panels don't overlap
  const mids = talks.map((t, i) => {
    const a1 = angleOf.get(pkey(t.a))!
    const a2 = angleOf.get(pkey(t.b))!
    const x = Math.sin(a1) + Math.sin(a2)
    const y = Math.cos(a1) + Math.cos(a2)
    const a = Math.hypot(x, y) < 1e-6 ? a1 + Math.PI / 2 : Math.atan2(x, y)
    return { i, a: (a + TAU) % TAU }
  })
  mids.sort((p, q) => p.a - q.a)
  const gap = Math.min(TAU / Math.max(m, 1), (CBOX.w + 60) / crx)
  for (let pass = 0; pass < 40 && m > 1; pass++) {
    let moved = false
    for (let j = 0; j < m; j++) {
      const p = mids[j]
      const q = mids[(j + 1) % m]
      let d = q.a - p.a
      if (j === m - 1) d += TAU
      if (d < gap - 1e-4) {
        const push = (gap - d) / 2
        p.a -= push
        q.a += push
        moved = true
      }
    }
    if (!moved) break
  }
  const chats = mids.map(({ i, a }) => {
    const t = talks[i]
    return { t, a: pkey(t.a), b: pkey(t.b), box: { ...onEllipse(a, crx, cry), ...CBOX } }
  })
  return { people, chats, hub, empty: empty || !talks.length ? { x: 0, y: HUB.h / 2 + 110, w: 560, h: 120 } : null }
}

// where the line from a box's centre towards `to` leaves the box, so arrowheads sit on the border
function exit(b: Box, to: Pt, pad = 6): Pt {
  const dx = to.x - b.x
  const dy = to.y - b.y
  const t = Math.min((b.w / 2 + pad) / Math.abs(dx || 1e-9), (b.h / 2 + pad) / Math.abs(dy || 1e-9))
  return { x: b.x + dx * t, y: b.y + dy * t }
}

type Sel = { kind: 'user' | 'chat'; id: string } | null
type View = { x: number; y: number; k: number }
const clampK = (k: number) => Math.min(2.5, Math.max(0.04, k))

type GraphProps = { store: AdminStore; talks: TalkSummary[]; ov: Overview | null; now: number; empty: boolean; onOpen: (id: string, x: number, y: number) => void; version: number; filter: Filter; q: string }

function Graph({ store, talks: all, ov, now, empty, onOpen, version, filter, q }: GraphProps) {
  const [sel, setSel] = useState<Sel>(null)
  const port = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const touched = useRef(false)
  const dragged = useRef(false)

  // the graph shows the live talks and then the most recent ones, capped
  const shown = useMemo(() => {
    const live = all.filter((t) => t.status === 'live')
    const rest = all.filter((t) => t.status !== 'live')
    return [...live, ...rest].slice(0, GRAPH_CAP)
  }, [all])
  const shape = shown.map((t) => `${t.id}:${t.a.id}:${t.b.id}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const L = useMemo(() => layoutGraph(shown, empty), [shape, empty])
  const talkById = useMemo(() => new Map(shown.map((t) => [t.id, t])), [shown])
  const Lref = useRef(L)
  Lref.current = L

  // transcripts for the panels on screen, a few requests at a time
  useEffect(() => {
    const ids = new Set(shown.map((t) => t.id))
    store.keepQueued(ids)
    for (const t of shown) if (store.needsDetail(t.id)) void store.ensureDetail(t.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, version, store])

  // Camera: `cur` is what's on screen, `goal` is where it's heading. Every frame eases cur toward
  // goal; zoom eases in log space so each step feels the same, and while zooming at the cursor the
  // world point under it (`anchor`) stays pinned. Frames write the transform straight to the DOM so
  // panning never re-renders the panels.
  const cur = useRef<View>({ x: 0, y: 0, k: 0.3 })
  const goal = useRef<View>(cur.current)
  const anchor = useRef<{ px: number; py: number; wx: number; wy: number } | null>(null)
  const raf = useRef(0)
  const show = (v: View) => {
    cur.current = v
    if (world.current) world.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`
    if (port.current) {
      port.current.style.backgroundPosition = `${v.x}px ${v.y}px`
      // zoomed far out, the dot grid doubles its spacing instead of turning into grey noise
      let g = 28 * v.k
      while (g < 10) g *= 2
      port.current.style.backgroundSize = `${g}px ${g}px`
    }
  }
  const snap = (v: View) => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    anchor.current = null
    goal.current = v
    show(v)
  }
  const run = () => {
    if (raf.current) return
    let last = performance.now()
    const step = (t: number) => {
      const a = 1 - Math.exp(-Math.min(50, t - last) / 120)
      last = t
      const c = cur.current
      const g = goal.current
      const an = anchor.current
      const k = c.k * Math.pow(g.k / c.k, a)
      const v = an ? { k, x: an.px - an.wx * k, y: an.py - an.wy * k } : { k, x: c.x + (g.x - c.x) * a, y: c.y + (g.y - c.y) * a }
      const done = Math.abs(Math.log(g.k / k)) < 0.002 && Math.abs(g.x - v.x) < 0.5 && Math.abs(g.y - v.y) < 0.5
      show(done ? g : v)
      if (done) {
        raf.current = 0
        anchor.current = null
      } else raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }
  const glide = (v: View) => {
    anchor.current = null
    goal.current = v
    run()
  }

  const fit = (instant = false) => {
    const el = port.current
    if (!el) return
    const l = Lref.current
    const all = [l.hub, ...l.people.map((p) => p.box), ...l.chats.map((c) => c.box), ...(l.empty ? [l.empty] : [])]
    const minX = Math.min(...all.map((b) => b.x - b.w / 2)) - 40
    const maxX = Math.max(...all.map((b) => b.x + b.w / 2)) + 40
    const minY = Math.min(...all.map((b) => b.y - b.h / 2)) - 40
    const maxY = Math.max(...all.map((b) => b.y + b.h / 2)) + 40
    // leave room for the toolbar at the top
    const top = el.clientWidth < 700 ? 110 : 70
    const h = el.clientHeight - top
    const k = Math.min(1, el.clientWidth / (maxX - minX), h / (maxY - minY))
    const v = { k, x: el.clientWidth / 2 - ((minX + maxX) / 2) * k, y: top + h / 2 - ((minY + maxY) / 2) * k }
    if (instant) snap(v)
    else glide(v)
  }

  const zoomAt = (factor: number, px: number, py: number) => {
    const c = cur.current
    const an = anchor.current
    if (!an || Math.abs(an.px - px) > 2 || Math.abs(an.py - py) > 2) anchor.current = { px, py, wx: (px - c.x) / c.k, wy: (py - c.y) / c.k }
    const a = anchor.current!
    const k = clampK(goal.current.k * factor)
    goal.current = { k, x: a.px - a.wx * k, y: a.py - a.wy * k }
    run()
  }

  // focus a box: zoom so it fills most of the screen
  const focus = (b: Box) => {
    const el = port.current
    if (!el) return
    touched.current = true
    const k = Math.min(1.4, Math.min(el.clientWidth / (b.w * 2.2), el.clientHeight / (b.h * 1.6)))
    glide({ k, x: el.clientWidth / 2 - b.x * k, y: el.clientHeight / 2 - b.y * k })
  }

  useLayoutEffect(() => {
    fit(true)
    const el = port.current
    if (!el) return
    const ro = new ResizeObserver(() => !touched.current && fit(true))
    ro.observe(el)
    const onWheel = (e: WheelEvent) => {
      const log = (e.target as HTMLElement).closest('.chat-log')
      if (log && log.scrollHeight > log.clientHeight && !e.ctrlKey) return
      e.preventDefault()
      touched.current = true
      const r = el.getBoundingClientRect()
      // mouse wheels send a few big deltas, trackpads many small ones; both become eased steps
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      zoomAt(Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.0022), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.focus-scrim') && setSel(null)
    window.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      cancelAnimationFrame(raf.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // a new set of talks: refit unless the admin has moved the camera
  useLayoutEffect(() => {
    if (!touched.current) fit(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L])

  // pinch to zoom on touch screens
  const pointers = useRef(new Map<number, Pt>())
  const pinch = useRef<{ d: number } | null>(null)

  const down = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('.chat-log, button, .overlay, input')) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()]
      pinch.current = { d: Math.hypot(p.x - q.x, p.y - q.y) }
      drag.current = null
      return
    }
    drag.current = { x: e.clientX, y: e.clientY, vx: cur.current.x, vy: cur.current.y, moved: false }
  }
  const move = (e: RPointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()]
      const d = Math.hypot(p.x - q.x, p.y - q.y)
      const r = port.current!.getBoundingClientRect()
      touched.current = true
      zoomAt(d / pinch.current.d, (p.x + q.x) / 2 - r.left, (p.y + q.y) / 2 - r.top)
      pinch.current.d = d
      dragged.current = true
      return
    }
    const dr = drag.current
    if (!dr) return
    const dx = e.clientX - dr.x
    const dy = e.clientY - dr.y
    if (!dr.moved && Math.hypot(dx, dy) < 4) return
    if (!dr.moved) port.current?.setPointerCapture(e.pointerId)
    dr.moved = true
    touched.current = true
    snap({ k: cur.current.k, x: dr.vx + dx, y: dr.vy + dy })
  }
  const up = (e: RPointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const d = drag.current
    drag.current = null
    dragged.current = !!d?.moved
    if (d && !d.moved && e.target === e.currentTarget.firstChild) setSel(null)
  }
  const openChat = useCallback(
    (id: string, x: number, y: number) => {
      if (dragged.current) return
      setSel({ kind: 'chat', id })
      onOpen(id, x, y)
    },
    [onOpen],
  )
  const focusChat = useCallback((id: string) => {
    const c = Lref.current.chats.find((x) => x.t.id === id)
    if (c) focus(c.box)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pick = (s: Sel) => () => !dragged.current && setSel((cur) => (cur?.kind === s?.kind && cur?.id === s?.id ? null : s))

  // what to highlight for the current selection
  const related = new Set<string>()
  if (sel?.kind === 'user') {
    related.add(sel.id).add('hub')
    for (const c of L.chats) if (c.a === sel.id || c.b === sel.id) related.add(c.t.id).add(c.a).add(c.b)
  } else if (sel?.kind === 'chat') {
    const c = L.chats.find((x) => x.t.id === sel.id)
    if (c) related.add(c.t.id).add(c.a).add(c.b)
  }
  const dim = (id: string) => (sel && !related.has(id) ? ' faded' : '')
  const pbox = new Map(L.people.map((p) => [p.key, p.box]))
  // the real total when we know it (the list pages in the rest)
  const total = Math.max(all.length, !q && filter === 'all' && ov ? ov.talks_total : 0)
  const hidden = total - shown.length

  return (
    <>
      <div className="port" ref={port} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="grid-hit" />
        <div className="world" ref={world}>
          <svg className="edges" width="1" height="1" aria-hidden>
            <defs>
              {['w', 'g'].map((c) => (
                <marker key={c} id={`arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 L10 5 L0 10 z" className={`arrowhead ${c}`} />
                </marker>
              ))}
            </defs>

            {/* hub to every person on screen */}
            {L.people.map((u) => {
              const p1 = exit(L.hub, u.box, 2)
              const p2 = exit(u.box, L.hub, 2)
              return <line key={u.key} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className={`e-hub ${u.live ? 'on' : 'off'}${dim(u.key)}`} />
            })}

            {/* person -> talk -> the other person */}
            {L.chats.map(({ t: t0, box: cb, a, b }) => {
              const t = talkById.get(t0.id) ?? t0
              const live = t.status === 'live'
              const cls = `e-chat ${live ? 'live' : 'done'}${sel ? (related.has(t.id) ? '' : ' faded') : ''}`
              const marker = `url(#arrow-${live ? 'w' : 'g'})`
              const ab = pbox.get(a)!
              const bb = pbox.get(b)!
              const a1 = exit(ab, cb)
              const a2 = exit(cb, ab)
              const b1 = exit(cb, bb)
              const b2 = exit(bb, cb)
              return (
                <g key={t.id}>
                  <line x1={a1.x} y1={a1.y} x2={a2.x} y2={a2.y} className={cls} markerEnd={marker} />
                  <line x1={b1.x} y1={b1.y} x2={b2.x} y2={b2.y} className={cls} markerEnd={marker} />
                </g>
              )
            })}
          </svg>

          <Place b={L.hub} className={`hub${sel ? (related.has('hub') ? '' : ' faded') : ''}`}>
            <div className="hub-title">
              <span>MUSE · HACKGT 13</span>
              <span className="dim">admin · {ov ? `as of ${hms(ms(ov.as_of))}` : 'loading'}</span>
            </div>
            <HubStats ov={ov} />
            <HubFoot ov={ov} />
            {hidden > 0 && <div className="hub-more">showing the {shown.length} most recent of {total.toLocaleString()} talks · the list view has them all</div>}
          </Place>

          {L.empty && (
            <Place b={L.empty} className="empty-card">
              <b>{empty ? 'No agent talks yet' : 'No talks match'}</b>
              <span>{empty ? 'They start when two opted-in attendees meet.' : 'Try another filter or clear the search.'}</span>
            </Place>
          )}

          {L.people.map((u) => (
            <PersonNode key={u.key} u={u} cls={`${u.live ? 'on' : 'off'}${sel?.id === u.key ? ' selected' : ''}${dim(u.key)}`} now={u.live ? 0 : Math.floor(now / 60_000) * 60_000} onClick={pick({ kind: 'user', id: u.key })} />
          ))}

          {L.chats.map(({ t: t0, box }) => {
            const t = talkById.get(t0.id) ?? t0
            const lines = store.lines(t.id)
            const phase = phaseOf(t, lines)
            return (
              <ChatCard
                key={t.id}
                t={t}
                lines={lines}
                b={box}
                now={phase === 'live' || phase === 'judging' ? now : 0}
                cls={`${sel?.id === t.id ? ' selected' : ''}${sel ? (related.has(t.id) ? '' : ' faded') : ''}`}
                onPick={openChat}
                onFocus={focusChat}
              />
            )
          })}
        </div>
      </div>

      <div className="overlay title-card">
        <div className="t">Muse · admin architecture</div>
        <ol className="pipeline">
          <li>Two opted-in attendees meet at HackGT</li>
          <li>Their muse agents talk, several at once</li>
          <li>Lines with no source in memory are withheld</li>
          <li>jev checks two checkpoints and scores the talk</li>
          <li>Both approve → reveal and an icebreaker</li>
        </ol>
      </div>

      <div className="overlay legend">
        <div>
          <span className="sw on" /> in a live talk
        </div>
        <div>
          <span className="sw off" /> idle
        </div>
        <div>
          <span className="ln live" /> live agent talk
        </div>
        <div>
          <span className="ln done" /> talk judged by jev
        </div>
        <div>
          <span className="ln spoke" /> link to platform
        </div>
      </div>

      <div className="overlay zoom">
        <button onClick={() => { touched.current = true; zoomAt(1 / 1.25, (port.current?.clientWidth ?? 0) / 2, (port.current?.clientHeight ?? 0) / 2) }} aria-label="Zoom out">
          −
        </button>
        <button onClick={() => { touched.current = false; setSel(null); fit() }}>fit</button>
        <button onClick={() => { touched.current = true; zoomAt(1.25, (port.current?.clientWidth ?? 0) / 2, (port.current?.clientHeight ?? 0) / 2) }} aria-label="Zoom in">
          +
        </button>
      </div>
    </>
  )
}

type PlaceProps = { b: Box; className: string; children: ReactNode; onClick?: (e: MouseEvent) => void; title?: string }
function Place({ b, className, children, onClick, title }: PlaceProps) {
  return (
    <div className={`node ${className}`} style={{ left: b.x - b.w / 2, top: b.y - b.h / 2, width: b.w, height: b.h }} onClick={onClick} title={title}>
      {children}
    </div>
  )
}

const PersonNode = memo(function PersonNode({ u, cls, now, onClick }: { u: PNode; cls: string; now: number; onClick: () => void }) {
  return (
    <Place b={u.box} className={`user ${cls}`} onClick={onClick}>
      <div className="u-top">
        <span className={`u-state ${u.live ? 'on' : 'off'}`}>{u.live ? '● IN AGENT TALK' : `○ LAST TALK ${ago(u.last, now || Date.now())} AGO`}</span>
      </div>
      <div className="u-name">
        <Avatar seed={u.p.id} bean={u.p.bean} size={26} />
        {u.p.first_name}
      </div>
      <div className="u-role">{u.p.source === 'muse' ? 'Muse agent connected' : u.p.source === 'voice' ? 'voice onboarding' : 'attendee'}</div>
      <div className="u-row">▸ {u.talks} talk{u.talks === 1 ? '' : 's'} here · {u.matches} match{u.matches === 1 ? '' : 'es'}</div>
      <div className="u-row">⌖ attendee #{u.p.id}</div>
      <div className="u-foot">last talk {hms(u.last)}</div>
    </Place>
  )
}, (a, b) => a.u === b.u && a.cls === b.cls && a.now === b.now)

type ChatProps = { t: TalkSummary; lines: Line[] | null; b: Box; now: number; cls: string; onPick: (id: string, x: number, y: number) => void; onFocus: (id: string) => void }

const CARD_LINES = 14

const ChatCard = memo(function ChatCard({ t, lines, b, now, cls, onPick, onFocus }: ChatProps) {
  const log = useRef<HTMLDivElement>(null)
  const start = ms(t.started_at)
  const A = t.a.first_name
  const B = t.b.first_name
  const phase = phaseOf(t, lines)
  const shown = lines ? lines.slice(-CARD_LINES) : null
  const next = phase === 'live' ? (lines?.length ? (lines[lines.length - 1].from === 'a' ? t.b : t.a) : t.a) : null

  useLayoutEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [lines?.length, phase])

  return (
    <Place b={b} className={`chat ${phase}${cls}`} onClick={(e) => onPick(t.id, e.clientX, e.clientY)} title="Click to open full screen">
      <header className="c-head">
        <div className="c-who">
          muse·{A} <span className="dim">⇄</span> muse·{B}
        </div>
        <span className={`pill ${phase}`}>{pillText(phase, t, spinner(now))}</span>
      </header>
      <div className="c-sub">
        {t.id} · started <time title={stamp(start)}>{hms(start)}</time> · {mmss(duration(t, now || Date.now()))}
      </div>
      <div className="c-sub monitor">
        <i className={`dot ${phase === 'live' ? 'live' : ''}`} /> {t.turns} turns · {t.withheld} withheld
        {t.match && <span> · ok {yn(t.approvals.a)}{yn(t.approvals.b)}{t.revealed ? ' · revealed' : ''}</span>}
        <button className="c-zoom" onClick={(e) => (e.stopPropagation(), onFocus(t.id))} title="zoom to this talk">
          ⤢
        </button>
      </div>

      <div className="chat-log" ref={log}>
        {!shown && <div className="m typing">{spinner(Date.now())} loading transcript…</div>}
        {shown && lines!.length > shown.length && <div className="m-more">… {lines!.length - shown.length} earlier lines</div>}
        {shown?.map((m, i) => {
          const at = ms(m.at)
          const p = m.from === 'a' ? t.a : t.b
          return (
            <div key={`${m.at}-${i}`} className={`m ${m.from}${m.withheld ? (m.text.trim() ? ' partial' : ' struck') : ''}`}>
              <Avatar seed={p.id} bean={p.bean} size={26} />
              <div className="m-body">
                <div className="m-meta">
                  <time title={stamp(at)}>[{hms(at)}]</time> muse·{p.first_name}
                </div>
                <div className="m-text">{m.text.trim() || 'withheld line'}</div>
                {m.withheld ? (
                  <div className="m-src">
                    ⊘ {m.text.trim() ? <s>part withheld</s> : 'withheld'} · {m.withheld_reason || 'no reason given'}
                  </div>
                ) : m.cites.length ? <div className="m-src">↳ from {m.cites.join(' · ')}</div> : null}
              </div>
            </div>
          )
        })}
        {next && (
          <div className="m typing">
            <Avatar seed={next.id} bean={next.bean} size={26} />
            <div className="m-body">
              {spinner(now)} muse·{next.first_name} is replying…
            </div>
          </div>
        )}
      </div>

      <footer className="c-jev">
        {phase === 'live' && <span className="dim">jev judges this talk at its checkpoints</span>}
        {phase === 'judging' && <span>{spinner(now)} jev scoring the talk…</span>}
        {phase === 'abandoned' && <span className="dim">abandoned before a verdict</span>}
        {(phase === 'match' || phase === 'nomatch' || phase === 'done') && (
          <>
            {t.scores && (
              <div className="bars">
                {SCORE_KEYS.map((k) => (
                  <div className="bar" key={k}>
                    <span>{SCORE_LABEL[k]}</span>
                    <span className="track">
                      <span style={{ width: `${(t.scores![k] / 5) * 100}%` }} />
                    </span>
                    <span>{t.scores![k].toFixed(1)}</span>
                  </div>
                ))}
              </div>
            )}
            {t.reason && (
              <div className="topic">
                <b>{t.stopped_at === 'checkpoint1' ? 'stopped' : 'why'}</b> {t.reason}
              </div>
            )}
          </>
        )}
      </footer>
    </Place>
  )
})

// ======================================================================== list

type ListProps = { store: AdminStore; talks: TalkSummary[]; ov: Overview | null; now: number; filter: Filter; q: string; empty: boolean; onOpen: (id: string, x: number, y: number) => void }

function List({ store, talks, ov, now, filter, q, empty, onOpen }: ListProps) {
  const box = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, h: 800, w: 1200 })
  const frame = useRef(0)
  const narrow = scroll.w < 760
  const ROW = narrow ? 96 : 60
  const OVERSCAN = 6

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setScroll({ top: el.scrollTop, h: el.clientHeight, w: el.clientWidth })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = box.current
      if (el) setScroll({ top: el.scrollTop, h: el.clientHeight, w: el.clientWidth })
    })
  }

  const page = store.pages[filter]
  const more = store.hasMore(filter)
  const first = Math.max(0, Math.floor(scroll.top / ROW) - OVERSCAN)
  const last = Math.min(talks.length, Math.ceil((scroll.top + scroll.h) / ROW) + OVERSCAN)

  // near the end: fetch the next page
  useEffect(() => {
    if (more && !page.loading && !page.error && last >= talks.length - 10) void store.loadMore(filter)
  }, [last, talks.length, more, page.loading, page.error, filter, store])

  const rows = []
  for (let i = first; i < last; i++) rows.push(<Row key={talks[i].id} t={talks[i]} top={i * ROW} h={ROW} now={talks[i].status === 'live' ? now : 0} onOpen={onOpen} narrow={narrow} />)

  return (
    <div className="adm-list">
      <div className="l-inner">
        <section className="l-hub">
          <div className="hub-title">
            <span>MUSE · HACKGT 13</span>
            <span className="dim">{ov ? `as of ${hms(ms(ov.as_of))}` : 'loading'}</span>
          </div>
          <HubStats ov={ov} />
          <HubFoot ov={ov} />
        </section>
        <div className="l-head">
          <span>
            {talks.length.toLocaleString()} talk{talks.length === 1 ? '' : 's'}
            {q ? ` matching “${q}”` : ''}
            {more ? ' loaded' : ''}
          </span>
          {q && more && (
            <button className="linkish" onClick={() => store.loadMore(filter)}>
              search covers loaded talks · load more
            </button>
          )}
        </div>
      </div>
      <div className="vlist" ref={box} onScroll={onScroll} role="list" aria-label="Agent talks">
        {!talks.length && !page.loading && (
          <div className="l-empty">
            {empty ? (
              <>
                <b>No agent talks yet</b>
                They start when two opted-in attendees meet.
              </>
            ) : more ? (
              'Loading…'
            ) : (
              'No talks match. Try another filter or clear the search.'
            )}
          </div>
        )}
        <div className="vspace" style={{ height: talks.length * ROW + 56 }}>
          {rows}
          <div className="l-foot" style={{ top: talks.length * ROW }}>
            {page.loading ? `${spinner(now)} loading more…` : page.error ? (
              <button className="linkish" onClick={() => store.loadMore(filter)}>
                couldn't load ({page.error}) · retry
              </button>
            ) : more ? (
              <button className="linkish" onClick={() => store.loadMore(filter)}>
                load more
              </button>
            ) : talks.length ? (
              `end · ${talks.length.toLocaleString()} talks`
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

const Row = memo(function Row({ t, top, h, now, onOpen, narrow }: { t: TalkSummary; top: number; h: number; now: number; onOpen: (id: string, x: number, y: number) => void; narrow: boolean }) {
  const phase = phaseOf(t)
  const start = ms(t.started_at)
  return (
    <button className={`row ${phase}${narrow ? ' narrow' : ''}`} style={{ top, height: h }} onClick={(e) => onOpen(t.id, e.clientX, e.clientY)} role="listitem">
      <span className={`pill ${phase}`}>{pillText(phase, t, spinner(now || 0))}</span>
      <span className="r-who">
        <Avatar seed={t.a.id} bean={t.a.bean} size={24} />
        <b>{t.a.first_name}</b>
        <span className="dim">⇄</span>
        <Avatar seed={t.b.id} bean={t.b.bean} size={24} />
        <b>{t.b.first_name}</b>
      </span>
      <span className="r-time" title={stamp(start)}>
        {hms(start)} · {mmss(duration(t, now || Date.now()))}
      </span>
      <span className="r-num">
        {t.turns} turns{t.withheld ? <em> · {t.withheld} withheld</em> : ''}
      </span>
      <span className="r-scores" title={t.scores ? SCORE_KEYS.map((k) => `${SCORE_LABEL[k]} ${t.scores![k]}`).join(' · ') : undefined}>
        {t.scores ? (
          SCORE_KEYS.map((k) => (
            <i key={k} className="sq">
              <i style={{ height: `${(t.scores![k] / 5) * 100}%` }} />
            </i>
          ))
        ) : (
          <span className="dim">—</span>
        )}
      </span>
      <span className="r-after" title="approved A/B · revealed · worth it A/B">
        {t.match ? (
          <>
            ok {yn(t.approvals.a)}
            {yn(t.approvals.b)} · {t.revealed ? 'revealed' : 'hidden'}
            {t.revealed ? ` · worth ${yn(t.worth_it.a)}${yn(t.worth_it.b)}` : ''}
          </>
        ) : (
          <span className="dim">{t.stopped_at ? t.stopped_at.replace('checkpoint', 'cp') : ''}</span>
        )}
      </span>
      <span className="r-reason">{t.reason ?? ''}</span>
    </button>
  )
})

export default Admin
