// A local stand-in for the admin API, used only when the page is opened with ?mock=1 (or ?demo=1).
// It makes realistic agent talks: a couple live and streaming lines, finished ones that matched
// or stopped at a checkpoint, and withheld lines. Nothing here is real attendee data.
//
//   ?mock=1            ~60 talks, 2 live
//   ?mock=1&n=500      a big event, for performance
//   ?mock=1&empty=1    no talks yet
//   ?mock=1&as=401     signed out;  &as=403  not an organizer
//   ?mock=1&poll=1     the stream "fails", so the 3 s polling fallback runs

import { ACCENT_COLORS, BODY_COLORS, EYES, HATS, ITEMS, PATTERNS, encodeLook } from '../look'
import { ApiError, type AdminApi, type Checkpoint, type Line, type Overview, type Person, type Scores, type Side, type StreamHandlers, type TalkDetail, type TalkQuery, type TalkSummary, type Usage } from './api'

// deterministic randomness so screenshots are stable
let seed = 1337
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo)
const round1 = (x: number) => Math.round(x * 10) / 10

const NAMES = ['Priya', 'Ethan', 'Maya', 'Nina', 'Arjun', 'Sofia', 'Dev', 'Grace', 'Zoe', 'Kai', 'Sam', 'Leo', 'Hana', 'Omar', 'Tomás', 'Aiko', 'Ravi', 'Lena', 'Jordan', 'Imani', 'Wei', 'Marcus', 'Ana', 'Theo', 'Fatima', 'Noah', 'Isha', 'Diego', 'Chloe', 'Kofi', 'Mei', 'Aarav', 'Ruby', 'Yusuf', 'Elena', 'Jin', 'Tariq', 'Sara', 'Owen', 'Nadia', 'Rohan', 'Lucia', 'Ben', 'Amara', 'Felix', 'Keiko', 'Luca', 'Zara']

function makePeople(n: number): Person[] {
  const out: Person[] = []
  for (let i = 0; i < n; i++) {
    const body = pick(BODY_COLORS)
    let accent = pick(ACCENT_COLORS)
    if (accent === body) accent = '#ffffff'
    const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${String.fromCharCode(65 + Math.floor(i / NAMES.length) - 1)}.` : '')
    out.push({
      id: 1000 + i,
      first_name: name,
      bean: encodeLook({ body, accent, pattern: pick(PATTERNS), eyes: pick(EYES), hat: pick(HATS), item: pick(ITEMS) }),
      source: rnd() < 0.7 ? 'muse' : 'voice',
    })
  }
  return out
}

type Beat = { from: Side; kind: Line['kind']; text: (a: string, b: string) => string; q?: string; cites?: string[]; withheld?: string }

const OPENERS: Beat[][] = [
  [
    { from: 'a', kind: 'greeting', text: (_a, b) => `Hi! I'm here for ${_a}. Looks like ${b} is at the table next to us in Klaus.` },
    { from: 'b', kind: 'greeting', text: (a, b) => `Hey, I'm ${b}'s agent. Nice to meet ${a}'s. What's ${a} building this weekend?` },
  ],
  [
    { from: 'b', kind: 'greeting', text: (_a, b) => `Hello from ${b}'s side. We passed each other near the sponsor row.` },
    { from: 'a', kind: 'greeting', text: (a) => `Hi! ${a} noticed the laptop stickers. Happy to compare notes.` },
  ],
]

const EXCHANGES: Beat[][] = [
  [
    { from: 'b', kind: 'question', q: 'q.building', text: (a) => `What is ${a} building at HackGT?` },
    { from: 'a', kind: 'answer', q: 'q.building', cites: ['memory · hackgt project', 'profile · building'], text: (a) => `${a} is on a team making a BLE badge that shows who's nearby. The firmware is almost done; the app is the hard part.` },
  ],
  [
    { from: 'a', kind: 'question', q: 'q.stack', text: (_a, b) => `What does ${b} usually build with?` },
    { from: 'b', kind: 'answer', q: 'q.stack', cites: ['memory · github languages'], text: (_a, b) => `Mostly TypeScript and Go. ${b} wrote a small WebSocket game server last month and liked it more than expected.` },
  ],
  [
    { from: 'b', kind: 'question', q: 'q.after', text: (a) => `Is ${a} thinking about internships or starting something after this?` },
    { from: 'a', kind: 'answer', q: 'q.after', cites: ['memory · career notes'], text: (a) => `${a} wants a summer internship on an infra team, but keeps a list of startup ideas "just in case".` },
  ],
  [
    { from: 'a', kind: 'question', q: 'q.fun', text: (_a, b) => `What does ${b} do when not coding?` },
    { from: 'b', kind: 'answer', q: 'q.fun', cites: ['memory · weekend plans'], text: (_a, b) => `${b} climbs at the gym on 10th Street twice a week and is trying to get into film photography.` },
  ],
  [
    { from: 'b', kind: 'question', q: 'q.class', text: (a) => `Favourite class ${a} has taken?` },
    { from: 'a', kind: 'answer', q: 'q.class', cites: ['memory · coursework'], text: (a) => `${a} loved Computer Graphics. Wrote a tiny ray tracer and still brings it up.` },
  ],
  [
    { from: 'a', kind: 'question', q: 'q.award', text: (_a, b) => `Has ${b} won anything at a hackathon before?` },
    { from: 'b', kind: 'answer', q: 'q.award', cites: ['memory · hackathons'], text: (_a, b) => `${b} has been to a few hackathons and loves the late-night demos.`, withheld: "guard withheld 1 sentence(s) not supported by this agent's own brief or notes" },
  ],
  [
    { from: 'b', kind: 'question', q: 'q.help', text: (a) => `Does ${a}'s team need help with anything right now?` },
    { from: 'a', kind: 'answer', q: 'q.help', cites: ['memory · hackgt project'], text: (a) => `Honestly, yes: a designer. ${a}'s team is four backend people and the UI shows it.` },
  ],
  [
    { from: 'a', kind: 'question', q: 'q.contact', text: (_a, b) => `Could ${b} share a phone number so they can text later?` },
    { from: 'b', kind: 'answer', q: 'q.contact', text: () => '', withheld: 'guard withheld 1 sentence(s) that were only contact details or secrets' },
  ],
  [
    { from: 'b', kind: 'question', q: 'q.food', text: (a) => `Has ${a} tried the late-night food yet?` },
    { from: 'a', kind: 'answer', q: 'q.food', cites: ['memory · today'], text: (a) => `${a} had the midnight waffles and rated them a solid 8.` },
  ],
]

const CLOSES: Beat[] = [
  { from: 'a', kind: 'close', text: (_a, b) => `This was great. I'll tell ${_a} about ${b}. Thanks!` },
  { from: 'b', kind: 'close', text: (a) => `Thanks! I think ${a} and my person should say hi in person.` },
]

const REASONS_MATCH = [
  'Both are building proximity apps and one needs exactly the skill the other has.',
  'Shared love of graphics and climbing; both want infra internships.',
  'Complementary teams: one needs a designer, the other is one.',
  'Similar stacks and a real overlap in what they want to do next.',
]
const REASONS_NO = [
  'Pleasant, but little overlap in goals or interests.',
  'Answers stayed shallow; no clear reason to meet now.',
  'One side disengaged early.',
]
const OPENERS_CHOICE = ['Ask about the BLE badge', 'Compare ray tracers', 'Climbing gym on 10th', 'Midnight waffles verdict', 'Their WebSocket game server']
const REASON_CHOICE = ['shared project space', 'complementary skills', 'same career goal', 'common hobby']
const HOT = ['BLE', 'ray tracing', 'climbing', 'internships', 'Go', 'TypeScript', 'design help', 'film photography', 'waffles']

type Plan = { beats: Beat[]; cp1At: number; pass1: boolean; match: boolean }

function plan(): Plan {
  const ex = [...EXCHANGES].sort(() => rnd() - 0.5).slice(0, 3 + Math.floor(rnd() * 3))
  const beats = [...pick(OPENERS), ...ex.flat(), ...CLOSES]
  const pass1 = rnd() > 0.18
  const match = pass1 && rnd() > 0.4
  const cp1At = 2 + 4 // after greetings + two exchanges
  return { beats: pass1 ? beats : [...beats.slice(0, cp1At), CLOSES[0]], cp1At, pass1, match }
}

type Mock = { d: TalkDetail; plan: Plan; shown: number; t0: number }

function lineOf(b: Beat, a: Person, bb: Person, at: number): Line {
  return {
    at: new Date(at).toISOString(),
    from: b.from,
    kind: b.kind,
    text: b.text(a.first_name, bb.first_name),
    question_id: b.q ?? null,
    cites: b.withheld ? [] : (b.cites ?? []),
    withheld: !!b.withheld,
    withheld_reason: b.withheld ?? null,
  }
}

const scoresFor = (match: boolean): Scores =>
  match
    ? { value_a: round1(between(3.6, 5)), value_b: round1(between(3.4, 5)), soon: round1(between(3, 5)), talk_again: round1(between(3.8, 5)), depth: round1(between(3, 4.8)) }
    : { value_a: round1(between(1.4, 3.2)), value_b: round1(between(1.2, 3.4)), soon: round1(between(1, 2.8)), talk_again: round1(between(1.5, 3.2)), depth: round1(between(1, 3)) }

const r2 = (x: number) => Math.round(x * 100) / 100
const gates = (pass: boolean) => ({
  both_engaged: r2(pass ? between(0.82, 0.99) : between(0.2, 0.5)),
  on_topic: r2(between(0.7, 0.98)),
  safe: r2(between(0.95, 1)),
})

/** Finish a talk: checkpoints, verdict, approvals, reveal. */
function finish(m: Mock, end: number) {
  const { d, plan: p } = m
  const cp1: Checkpoint = {
    name: 'checkpoint1',
    at: new Date(m.t0 + p.cp1At * 3200 + 900).toISOString(),
    gates: gates(p.pass1),
    scores: null,
    choices: null,
    passed: p.pass1,
  }
  d.checkpoints = [cp1]
  d.status = 'done'
  d.ended_at = new Date(end).toISOString()
  d.withheld = d.lines.filter((l) => l.withheld).length
  d.turns = d.lines.length
  if (!p.pass1) {
    d.stopped_at = 'checkpoint1'
    d.match = false
    d.reason = 'Stopped at checkpoint 1: ' + pick(REASONS_NO).toLowerCase()
    d.overall = Math.round(between(12, 35))
    d.scores = null
    d.timings_ms = { first_bubble: Math.round(between(700, 1800)), checkpoint1: Math.round(between(14000, 22000)), verdict: Math.round(between(22000, 26000)), reveal: null }
    return
  }
  const scores = scoresFor(p.match)
  d.checkpoints.push({
    name: 'checkpoint2',
    at: new Date(end - 400).toISOString(),
    gates: gates(true),
    scores,
    choices: { reason: { choice: pick(REASON_CHOICE), confidence: r2(between(0.55, 0.95)) }, opener: { choice: pick(OPENERS_CHOICE), confidence: r2(between(0.5, 0.92)) } },
    passed: p.match,
  })
  d.stopped_at = 'checkpoint2'
  d.scores = scores
  d.match = p.match
  d.overall = Math.round(p.match ? between(68, 94) : between(30, 58))
  d.reason = pick(p.match ? REASONS_MATCH : REASONS_NO)
  d.hot_topics = [...HOT].sort(() => rnd() - 0.5).slice(0, 3)
  if (p.match) {
    const a = rnd() < 0.85 ? true : rnd() < 0.5 ? false : null
    const b = rnd() < 0.8 ? true : rnd() < 0.5 ? false : null
    d.approvals = { a, b }
    d.revealed = a === true && b === true
    d.icebreaker = { line: `You two both mentioned ${d.hot_topics[0]}.`, question: `${d.a.first_name}, what got you into ${d.hot_topics[0]}?` }
    if (d.revealed) d.worth_it = { a: rnd() < 0.8 ? true : null, b: rnd() < 0.7 ? true : rnd() < 0.5 ? false : null }
  }
  d.timings_ms = { first_bubble: Math.round(between(700, 1800)), checkpoint1: Math.round(between(14000, 22000)), verdict: Math.round(between(38000, 52000)), reveal: d.revealed ? Math.round(between(60000, 240000)) : null }
}

function newTalk(id: number, a: Person, b: Person, t0: number): Mock {
  const d: TalkDetail = {
    id: `t_${id.toString(36).padStart(5, '0')}`,
    status: 'live',
    started_at: new Date(t0).toISOString(),
    ended_at: null,
    a,
    b,
    turns: 0,
    stopped_at: null,
    match: null,
    reason: null,
    overall: null,
    scores: null,
    approvals: { a: null, b: null },
    revealed: false,
    worth_it: { a: null, b: null },
    withheld: 0,
    config_version: 'jev-2026.09.2',
    lines: [],
    checkpoints: [],
    hot_topics: [],
    icebreaker: null,
    timings_ms: { first_bubble: 0, checkpoint1: 0, verdict: 0, reveal: null },
  }
  return { d, plan: plan(), shown: 0, t0 }
}

const summary = (d: TalkDetail): TalkSummary => {
  const { lines: _l, checkpoints: _c, hot_topics: _h, icebreaker: _i, timings_ms: _t, ...s } = d
  void _l, void _c, void _h, void _i, void _t
  return structuredClone(s)
}

const delay = <T,>(v: () => T, ms = 120 + rnd() * 160) => new Promise<T>((res, rej) => setTimeout(() => { try { res(v()) } catch (e) { rej(e) } }, ms))

export function createMockApi(params: URLSearchParams): AdminApi {
  seed = 1337
  const as = params.get('as')
  const empty = params.has('empty')
  const n = Math.max(0, Math.min(5000, Number(params.get('n')) || 60))
  const people = makePeople(Math.max(8, Math.min(400, Math.round(n * 0.8))))
  const talks: Mock[] = []
  const now = Date.now()
  let nextId = 1
  const LINE_MS = 3200

  if (!empty) {
    // finished talks over the last ~20 h, newest first
    for (let i = 0; i < n; i++) {
      const a = pick(people)
      let b = pick(people)
      while (b === a) b = pick(people)
      const t0 = now - 90_000 - i * ((20 * 3600_000) / Math.max(n, 1)) - rnd() * 60_000
      const m = newTalk(nextId++, a, b, t0)
      m.plan.beats.forEach((beat, k) => m.d.lines.push(lineOf(beat, a, b, t0 + 1200 + k * LINE_MS)))
      m.shown = m.plan.beats.length
      finish(m, t0 + m.plan.beats.length * LINE_MS + 2000)
      if (rnd() < 0.04) m.d.status = 'abandoned'
      talks.push(m)
    }
    // two live ones, part-way through
    for (const [k, part] of [[0, 5], [1, 2]] as const) {
      const a = people[k * 2]
      const b = people[k * 2 + 1]
      const m = newTalk(nextId++, a, b, now - part * LINE_MS - 1500)
      for (; m.shown < part; m.shown++) m.d.lines.push(lineOf(m.plan.beats[m.shown], a, b, m.t0 + 1200 + m.shown * LINE_MS))
      m.d.turns = m.shown
      m.d.withheld = m.d.lines.filter((l) => l.withheld).length
      talks.unshift(m)
    }
  }

  const byStart = () => [...talks].sort((x, y) => Date.parse(y.d.started_at) - Date.parse(x.d.started_at))
  const guard = () => {
    if (as === '401') throw new ApiError(401, '401 Unauthorized')
    if (as === '403') throw new ApiError(403, '403 Forbidden')
  }

  const overview = (): Overview => {
    const done = talks.filter((m) => m.d.status !== 'live')
    const hasTalks = talks.length > 0
    return {
      users_total: hasTalks ? people.length + 212 : 0,
      users_signed_in_today: hasTalks ? Math.round(people.length * 0.9) + 140 : 0,
      active_now: hasTalks ? 37 + talks.filter((m) => m.d.status === 'live').length * 2 : 0,
      in_klaus_now: hasTalks ? 24 : 0,
      activity_hours_total: hasTalks ? round1(1843.6 + (Date.now() - now) / 3600_000 * 37) : null,
      memories_total: hasTalks ? 5210 : 0,
      muse_connected: hasTalks ? 141 : 0,
      voice_onboarded: hasTalks ? 63 : null,
      talks_total: talks.length,
      talks_live: talks.length - done.length,
      talks_today: talks.length,
      matches_total: done.filter((m) => m.d.match).length,
      approvals_both: done.filter((m) => m.d.approvals.a && m.d.approvals.b).length,
      reveals_total: done.filter((m) => m.d.revealed).length,
      worth_it_yes: done.reduce((s, m) => s + (m.d.worth_it.a === true ? 1 : 0) + (m.d.worth_it.b === true ? 1 : 0), 0),
      worth_it_no: done.reduce((s, m) => s + (m.d.worth_it.a === false ? 1 : 0) + (m.d.worth_it.b === false ? 1 : 0), 0),
      withheld_lines_total: talks.reduce((s, m) => s + m.d.lines.filter((l) => l.withheld).length, 0),
      as_of: new Date().toISOString(),
    }
  }

  // mock usage: a day of play shaped like an event (quiet overnight, busy afternoons)
  const usage = (): Usage => {
    const hasTalks = talks.length > 0
    const end = Math.floor(Date.now() / 3600_000) * 3600_000
    const hourly = Array.from({ length: 24 }, (_, i) => {
      const at = new Date(end - (23 - i) * 3600_000)
      const h = at.getHours()
      const busy = !hasTalks ? 0 : h >= 1 && h < 8 ? 0.15 : h >= 13 && h < 19 ? 1 : 0.6
      const ppl = Math.round(busy * (70 + (i * 37) % 25))
      return { hour: at.toISOString(), people: ppl, minutes: round1(ppl * (22 + (i * 13) % 20)) }
    })
    const top = people.slice(0, hasTalks ? 10 : 0).map((p, i) => ({ ...p, minutes: round1(260 - i * 17.5), sessions: 6 - Math.floor(i / 2) }))
    const rate = (inM: number, outM: number, tin: number, tout: number) => Math.round((tin / 1e6 * inM + tout / 1e6 * outM) * 100) / 100
    const k = hasTalks ? 1 : 0
    return {
      play: {
        people: 318 * k, people_today: 204 * k, sessions: 1102 * k, sessions_today: 486 * k,
        hours: round1(1843.6 * k), hours_today: round1(612.4 * k), active_hours: round1(1021.2 * k), hall_hours: round1(733.9 * k),
        avg_session_min: round1(100.4 * k), median_session_min: round1(41.5 * k), avg_per_person_min: round1(347.8 * k),
        returning: 241 * k, peak_online: 142 * k, peak_at: hasTalks ? new Date(end - 5 * 3600_000).toISOString() : null, online_now: 37 * k,
      },
      hourly,
      top,
      voice: { calls: 71 * k, minutes: round1(152.3 * k), avg_call_sec: 129 * k, people: 63 * k },
      services: hasTalks
        ? [
            { kind: 'gemini', model: 'gemini-3.1-flash-lite', calls: 18422, failed: 31, calls_today: 7310, tokens_in: 21_400_000, tokens_out: 2_950_000, minutes: 0, cost_usd: rate(0.1, 0.4, 21_400_000, 2_950_000), cost_today_usd: rate(0.1, 0.4, 8_100_000, 1_120_000) },
            { kind: 'gemini', model: 'gemini-3.8-flash', calls: 2210, failed: 4, calls_today: 902, tokens_in: 4_800_000, tokens_out: 910_000, minutes: 0, cost_usd: rate(0.5, 3, 4_800_000, 910_000), cost_today_usd: rate(0.5, 3, 1_900_000, 360_000) },
            { kind: 'jev', model: 'jev-latest', calls: 4411, failed: 12, calls_today: 1650, tokens_in: 0, tokens_out: 0, minutes: 0, cost_usd: null, cost_today_usd: null },
            { kind: 'voice', model: 'elevenlabs', calls: 71, failed: 0, calls_today: 22, tokens_in: 0, tokens_out: 0, minutes: 152.3, cost_usd: 15.23, cost_today_usd: 4.9 },
          ]
        : [],
      cost_usd: hasTalks ? 31.4 : null,
      cost_today_usd: hasTalks ? 11.2 : null,
      as_of: new Date().toISOString(),
    }
  }

  const subs = new Set<StreamHandlers>()
  let ticker = 0
  const emit = (f: (h: StreamHandlers) => void) => subs.forEach(f)

  // the live talks advance one line every ~3 s; a finished live talk is replaced by a new one
  const tick = () => {
    for (const m of talks) {
      if (m.d.status !== 'live') continue
      if (m.shown < m.plan.beats.length) {
        const l = lineOf(m.plan.beats[m.shown++], m.d.a, m.d.b, Date.now())
        m.d.lines.push(l)
        m.d.turns = m.d.lines.length
        m.d.withheld = m.d.lines.filter((x) => x.withheld).length
        emit((h) => h.line(m.d.id, structuredClone(l)))
        emit((h) => h.talk(summary(m.d)))
      } else {
        finish(m, Date.now())
        emit((h) => h.talk(summary(m.d)))
        const a = pick(people)
        let b = pick(people)
        while (b === a) b = pick(people)
        const fresh = newTalk(nextId++, a, b, Date.now())
        talks.unshift(fresh)
        emit((h) => h.talk(summary(fresh.d)))
      }
    }
  }
  const start = () => {
    if (!ticker && !empty) ticker = window.setInterval(tick, LINE_MS)
  }
  // polling mode still needs the talks to move
  if (params.has('poll')) start()

  return {
    me: () => delay(() => (guard(), { admin: true, email: 'organizer@example.com', tenant: 'hackgt13' })),
    overview: () => delay(() => (guard(), overview())),
    usage: () => delay(() => (guard(), usage())),
    talks: (q: TalkQuery = {}) =>
      delay(() => {
        guard()
        let list = byStart().map((m) => m.d)
        if (q.status === 'live') list = list.filter((d) => d.status === 'live')
        if (q.status === 'done') list = list.filter((d) => d.status !== 'live')
        if (q.match !== undefined) list = list.filter((d) => (d.match === true) === q.match)
        const from = Number(q.cursor) || 0
        const lim = q.limit ?? 50
        const items = list.slice(from, from + lim).map(summary)
        return { items, next: from + lim < list.length ? String(from + lim) : null }
      }),
    talk: (id: string) =>
      delay(() => {
        guard()
        const m = talks.find((x) => x.d.id === id)
        if (!m) throw new ApiError(404, '404 Not Found')
        return structuredClone(m.d)
      }),
    stream(h) {
      if (params.has('poll') || as) {
        setTimeout(() => h.error(), 200)
        return () => {}
      }
      subs.add(h)
      setTimeout(() => h.open(), 150)
      start()
      const ov = window.setInterval(() => h.overview(overview()), 10_000)
      return () => {
        subs.delete(h)
        clearInterval(ov)
        if (!subs.size) {
          clearInterval(ticker)
          ticker = 0
        }
      }
    },
  }
}
