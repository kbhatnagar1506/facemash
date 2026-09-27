import { useEffect, useState } from 'react'
import { ApiError, ms, type Usage } from '../api'
import { hms, spinner } from '../ui/time'
import { Avatar } from './Avatar'
import { fmtInt } from './format'
import type { AdminStore } from './live'

// Usage view: how long people spend in the game (the numbers that show it's used) and what
// the paid services were used for. /api/admin/usage, refreshed every 15 s while open.

const REFRESH_MS = 15_000

const num1 = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`)
const usd = (v: number | null) => (v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const compact = (n: number) => (n >= 1e6 ? `${num1(n / 1e6)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : fmtInt(n))
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')

export function UsageView({ store, now }: { store: AdminStore; now: number }) {
  const [u, setU] = useState<Usage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    const load = () =>
      store.api.usage().then(
        (x) => !dead && (setU(x), setErr(null)),
        (e) => !dead && setErr(e instanceof ApiError ? e.message : 'network error'),
      )
    void load()
    const t = window.setInterval(load, REFRESH_MS)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [store])

  return (
    <div className="adm-list adm-usage">
      <div className="l-inner u-page">
        <section className="l-hub">
          <div className="hub-title">
            <span>USAGE · TIME IN THE GAME</span>
            <span className="dim">{err ? `couldn't refresh (${err})` : u ? `as of ${hms(ms(u.as_of))}` : `${spinner(now)} loading`}</span>
          </div>
          {u && <PlayStats u={u} />}
        </section>
        {u && (
          <>
            <Hours u={u} />
            {u.speed && <Speed s={u.speed} />}
            <div className="u-cols">
              <Top u={u} />
              <Services u={u} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ v, k, unit, sub }: { v: string; k: string; unit?: string; sub?: string }) {
  return (
    <div className="stat u-tile">
      <div className="stat-v">
        {v}
        {unit && <small> {unit}</small>}
      </div>
      <div className="stat-k">{k}</div>
      {sub && <div className="u-sub">{sub}</div>}
    </div>
  )
}

function PlayStats({ u }: { u: Usage }) {
  const p = u.play
  return (
    <>
      <div className="hub-stats u-stats">
        <Tile v={num1(p.hours)} unit="h" k="total time in the game" sub={`${num1(p.hours_today)} h today`} />
        <Tile v={fmtInt(p.people)} k="people who played" sub={`${fmtInt(p.people_today)} today`} />
        <Tile v={mins(p.avg_per_person_min)} k="average time per person" />
        <Tile v={fmtInt(p.peak_online)} k="most online at once" sub={p.peak_at ? `at ${new Date(p.peak_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : undefined} />
      </div>
      <div className="hub-stats u-stats u-stats-2">
        <Tile v={fmtInt(p.sessions)} k="sessions" sub={`${fmtInt(p.sessions_today)} today`} />
        <Tile v={mins(p.avg_session_min)} k="average session" sub={`median ${mins(p.median_session_min)}`} />
        <Tile v={share(p.returning, p.people)} k="came back for another session" sub={`${fmtInt(p.returning)} people`} />
        <Tile v={share(p.active_hours, p.hours)} k="of the time moving about" sub={`${num1(p.hall_hours)} h in the HackGT hall`} />
        <Tile v={fmtInt(p.online_now)} k="online now" />
      </div>
    </>
  )
}

// people per hour, the last 24 hours: one series, so no legend; hover (or focus) a bar for detail
function Hours({ u }: { u: Usage }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...u.hourly.map((h) => h.people))
  const top = Math.max(1, Math.ceil(max / 5) * 5)
  const h = hover == null ? null : u.hourly[hover]
  const label = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric' })
  return (
    <section className="u-card">
      <div className="u-head">
        <span>PEOPLE PLAYING · LAST 24 HOURS</span>
        <span className="dim">
          {h ? `${label(h.hour)} · ${fmtInt(h.people)} people · ${mins(h.minutes)} played` : `peak hour ${fmtInt(max === 1 && !u.hourly.some((x) => x.people) ? 0 : max)} people`}
        </span>
      </div>
      <div className="u-chart" role="img" aria-label="People playing per hour over the last 24 hours" onMouseLeave={() => setHover(null)}>
        <div className="u-axis" aria-hidden>
          <span>{top}</span>
          <span>{Math.round(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="u-bars">
          <i className="u-grid" style={{ bottom: '50%' }} />
          {u.hourly.map((x, i) => (
            <button
              key={x.hour}
              className={`u-bar${hover === i ? ' on' : ''}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${label(x.hour)}: ${x.people} people, ${Math.round(x.minutes)} minutes played`}
            >
              <span style={{ height: `${(x.people / top) * 100}%` }} />
            </button>
          ))}
        </div>
      </div>
      <div className="u-ticks" aria-hidden>
        {u.hourly.map((x, i) => (
          <span key={x.hour}>{i % 4 === 0 ? label(x.hour) : ''}</span>
        ))}
      </div>
    </section>
  )
}

const msec = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`)

// how snappy the agent talks are: jev's pick of the next question, and the answers
function Speed({ s }: { s: NonNullable<Usage['speed']> }) {
  return (
    <section className="u-card">
      <div className="u-head">
        <span>AGENT TALK SPEED</span>
        <span className="dim">
          last {s.hours_back} h · {fmtInt(s.talks)} talks · {num1(s.questions_per_talk)} questions each
        </span>
      </div>
      {s.picks || s.answers ? (
        <div className="hub-stats u-stats">
          <Tile v={msec(s.pick_p50_ms)} k="picking the next question (median)" sub={`90% under ${msec(s.pick_p90_ms)} · from ${Math.round(s.avg_options)} choices`} />
          <Tile v={fmtInt(s.pick_failed)} k="picks that timed out" sub={`of ${fmtInt(s.picks)} (a fallback question is asked)`} />
          <Tile v={msec(s.first_words_p50_ms)} k="to an answer's first words (median)" sub={`90% under ${msec(s.first_words_p90_ms)}`} />
          <Tile v={msec(s.answer_p50_ms)} k="to the whole answer (median)" sub={`${fmtInt(s.answers)} answers`} />
        </div>
      ) : (
        <p className="u-empty">No agent talks in the last {s.hours_back} hours.</p>
      )}
    </section>
  )
}

function Top({ u }: { u: Usage }) {
  return (
    <section className="u-card">
      <div className="u-head">
        <span>MOST TIME IN THE GAME</span>
        <span className="dim">top {u.top.length}</span>
      </div>
      {u.top.length ? (
        <table className="u-table">
          <thead>
            <tr>
              <th>#</th>
              <th>person</th>
              <th className="r">time</th>
              <th className="r">sessions</th>
            </tr>
          </thead>
          <tbody>
            {u.top.map((p, i) => (
              <tr key={p.id}>
                <td className="dim">{i + 1}</td>
                <td>
                  <span className="u-who">
                    <Avatar seed={p.id} bean={p.bean} size={22} />
                    {p.first_name || `#${p.id}`}
                    <span className="dim"> #{p.id}</span>
                  </span>
                </td>
                <td className="r">{mins(p.minutes)}</td>
                <td className="r">{fmtInt(p.sessions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="u-empty">No one has played yet.</p>
      )}
    </section>
  )
}

const KIND: Record<string, string> = { gemini: 'Gemini', jev: 'jev', voice: 'Voice (ElevenLabs)' }

function Services({ u }: { u: Usage }) {
  const v = u.voice
  return (
    <section className="u-card">
      <div className="u-head">
        <span>AI AND VOICE</span>
        <span className="dim">{u.cost_usd == null ? 'cost: set USAGE_RATES' : `${usd(u.cost_usd)} · ${usd(u.cost_today_usd)} today`}</span>
      </div>
      <div className="u-voice">
        <b>{fmtInt(v.people)}</b> onboarded by voice · <b>{fmtInt(v.calls)}</b> answers · <b>{num1(v.minutes)}</b> min spoken · avg {Math.round(v.avg_call_sec)} s
      </div>
      {u.services.length ? (
        <table className="u-table u-svc">
          <thead>
            <tr>
              <th>service</th>
              <th className="r">calls</th>
              <th className="r">today</th>
              <th className="r">tokens in / out</th>
              <th className="r">cost</th>
            </tr>
          </thead>
          <tbody>
            {u.services.map((s) => (
              <tr key={s.kind + s.model}>
                <td>
                  {KIND[s.kind] ?? s.kind}
                  <div className="dim u-model">{s.model}</div>
                </td>
                <td className="r">
                  {fmtInt(s.calls)}
                  {s.failed > 0 && <div className="dim u-model">{fmtInt(s.failed)} failed</div>}
                </td>
                <td className="r">{fmtInt(s.calls_today)}</td>
                <td className="r">{s.kind === 'voice' ? `${num1(s.minutes)} min` : s.tokens_in || s.tokens_out ? `${compact(s.tokens_in)} / ${compact(s.tokens_out)}` : '—'}</td>
                <td className="r">{usd(s.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="u-empty">No AI or voice calls yet.</p>
      )}
      <p className="u-note dim">Counts every account, test ones included: the calls cost the same.</p>
    </section>
  )
}
