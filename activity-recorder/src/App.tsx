import { useEffect, useState } from 'react'
import { Avatar } from './Avatar'
import type { Account } from './data'
import { HourChart } from './HourChart'
import { KIND_LABEL, download, recorder, recordingMs, sessionMs, sessionTotals, sessionsCSV, stats, toCSV, useRecorder, type Kind, type Stats } from './recorder'
import { ago, duration, hms, isToday, span, stamp, useNow } from './time'
import { UserDrawer } from './UserDrawer'

type Filter = 'all' | 'online' | 'offline' | 'new'
type SortKey = 'name' | 'created' | 'sessions' | 'chats' | 'matches' | 'hours' | 'last'
type Row = { a: Account; st: Stats; online: boolean }

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['online', 'Online'],
  ['offline', 'Offline'],
  ['new', 'New today'],
]
const KINDS = Object.keys(KIND_LABEL) as Kind[]

export default function App() {
  const s = useRecorder()
  const now = useNow(1000)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'last', dir: -1 })
  const [openId, setOpenId] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind | 'all'>('all')
  const [sessView, setSessView] = useState<'all' | 'open' | 'closed'>('all')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenId(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isNew = (a: Account) => a.created === 'today'
  const rows: Row[] = s.accounts.map((a) => ({ a, st: stats(s, a, now), online: s.online[a.id] }))
  const match = (r: Row, f: Filter) => f === 'all' || (f === 'online' ? r.online : f === 'offline' ? !r.online : isNew(r.a))
  const count = (f: Filter) => rows.filter((r) => match(r, f)).length
  const needle = q.trim().toLowerCase()
  const shown = rows
    .filter((r) => match(r, filter))
    .filter((r) => !needle || [r.a.name, r.a.username, r.a.email, r.a.accountId, r.a.event].some((v) => v.toLowerCase().includes(needle)))
    .sort((x, y) => sort.dir * compare(x, y, sort.key))

  const day = s.events.filter((r) => r.at > now - 86_400_000)
  const n = (k: Kind) => day.filter((r) => r.kind === k).length
  const recorded = s.events.filter((r) => r.at >= s.startedAt).length
  const tot = sessionTotals(s.sessions, now)
  const sessList = [...s.sessions].reverse().filter((x) => sessView === 'all' || (sessView === 'open' ? x.end === null : x.end !== null))
  const recMs = recordingMs(s, now)
  const log = [...s.events].reverse().filter((r) => kind === 'all' || r.kind === kind)
  const byId = (id: string) => s.accounts.find((a) => a.id === id)!
  const open = openId ? s.accounts.find((a) => a.id === openId) : undefined

  const exportAccounts = () => {
    const head = ['account_id', 'name', 'username', 'email', 'sign_in', 'plan', 'created', 'device', 'city', 'status', 'event', 'sessions', 'agent_chats', 'matches', 'hours', 'last_activity']
    const body = rows.map(({ a, st, online }) =>
      [a.accountId, a.name, `@${a.username}`, a.email, a.provider, a.plan, a.created === 'today' ? new Date(now).toISOString().slice(0, 10) : a.created, a.device, a.city, online ? 'online' : 'offline', a.event, st.sessions, st.chats, st.matches, st.hours.toFixed(2), new Date(st.last).toISOString()]
        .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v))
        .join(','),
    )
    download(`muse-accounts-${new Date(now).toISOString().slice(0, 10)}.csv`, [head.join(','), ...body].join('\n'), 'text/csv')
  }

  const th = (key: SortKey, label: string, cls = '') => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSort((c) => ({ key, dir: c.key === key ? (-c.dir as 1 | -1) : key === 'name' ? 1 : -1 }))}>
        {label}
        <span className="arrow">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  )

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className={`rec${s.recording ? '' : ' paused'}`}>
            <i /> {s.recording ? 'REC' : 'PAUSED'}
          </span>
          <div>
            <h1>Activity recorder</h1>
            <p className="sub">
              Muse platform · every account · recording since <time title={stamp(s.startedAt)}>{hms(s.startedAt)}</time> · <span className="mono">{duration(recMs)}</span>
            </p>
          </div>
        </div>
        <div className="actions">
          <button className={`btn${s.recording ? '' : ' primary'}`} onClick={recorder.toggle}>
            {s.recording ? '❚❚ Pause recording' : '● Resume recording'}
          </button>
          <button className="btn" onClick={() => download(`muse-activity-${new Date(now).toISOString().slice(0, 19).replace(/:/g, '')}.csv`, toCSV(s), 'text/csv')}>
            Export log (CSV)
          </button>
          <button className="btn" onClick={exportAccounts}>
            Export accounts (CSV)
          </button>
        </div>
      </header>

      <section className="kpis" aria-label="Totals">
        <div className="kpi hero">
          <div className="k">Accounts</div>
          <div className="v">{s.accounts.length}</div>
          <div className="d">{count('new') ? `+${count('new')} signed up today` : 'no sign-ups today yet'}</div>
        </div>
        <Kpi k="Online now" v={count('online')} d={`${count('offline')} offline`} live />
        <Kpi k="Sessions, 24 h" v={tot.count} d={`${tot.open} open now · ${tot.count - tot.open} ended`} />
        <Kpi k="Total session time" v={span(tot.totalMs)} d={`avg ${span(tot.avgMs)} per ended session`} />
        <Kpi k="Agent chats, 24 h" v={n('chat')} d={`${n('radius')} radius encounters`} />
        <Kpi k="Matches, 24 h" v={n('match')} d={`${n('scored')} below the line · ${n('withheld')} withheld`} />
        <Kpi k="Events recorded" v={recorded} d={`${s.events.length.toLocaleString()} in the log with 24 h history`} />
      </section>

      <div className="layout">
        <main className="main">
          <HourChart events={s.events} now={now} />

          <section className="panel">
            <header className="panel-head wrap">
              <div>
                <h2>Accounts</h2>
                <p className="sub">
                  {shown.length} of {rows.length} · click a row for the account and its recorded activity
                </p>
              </div>
              <div className="tools">
                <div className="tabs" role="tablist" aria-label="Filter accounts">
                  {FILTERS.map(([f, label]) => (
                    <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
                      {label} <span className="count">{count(f)}</span>
                    </button>
                  ))}
                </div>
                <input className="search" type="search" placeholder="Search name, @username, email, account id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" />
              </div>
            </header>

            <div className="table-wrap">
              <table className="accounts">
                <thead>
                  <tr>
                    {th('name', 'User')}
                    <th className="c-acct">Account</th>
                    <th className="c-sign">Sign-in</th>
                    <th>Status</th>
                    {th('created', 'Joined', 'c-joined')}
                    {th('sessions', 'Sessions', 'num c-num')}
                    {th('chats', 'Chats', 'num c-num')}
                    {th('matches', 'Matches', 'num c-num')}
                    {th('hours', 'Hours', 'num c-num')}
                    {th('last', 'Last activity', 'c-last')}
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ a, st, online }) => (
                    <tr key={a.id} className={`${online ? 'online' : 'offline'}${openId === a.id ? ' selected' : ''}${isNew(a) ? ' fresh-row' : ''}`} onClick={() => setOpenId(a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpenId(a.id)}>
                      <td>
                        <div className="who">
                          <Avatar id={a.id} size={30} off={!online} />
                          <div>
                            <div className="name">
                              {a.name} {isNew(a) && <span className="tag">new</span>}
                            </div>
                            <div className="handle">@{a.username}</div>
                          </div>
                        </div>
                      </td>
                      <td className="c-acct">
                        <div>{a.email}</div>
                        <div className="mono dim">{a.accountId}</div>
                      </td>
                      <td className="c-sign">
                        <div>{a.provider}</div>
                        <div className="dim">
                          {a.plan} · {a.device}
                        </div>
                      </td>
                      <td>
                        <div className={`status ${online ? 'on' : 'off'}`}>{online ? '● Online' : '○ Offline'}</div>
                        <div className="dim">{online ? `${a.event}${a.where ? ` · ${a.where}` : ''}` : `last seen ${ago(st.last, now)}`}</div>
                      </td>
                      <td className="c-joined mono">{a.created === 'today' ? 'today' : a.created}</td>
                      <td className="num c-num">{st.sessions}</td>
                      <td className="num c-num">{st.chats}</td>
                      <td className="num c-num">{st.matches}</td>
                      <td className="num c-num">{st.hours.toFixed(1)}</td>
                      <td className="c-last" title={stamp(st.last)}>
                        {ago(st.last, now)}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={10} className="empty">
                        No accounts match.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <header className="panel-head wrap">
              <div>
                <h2>Sessions</h2>
                <p className="sub">
                  {tot.count} sessions in the last 24 h · {span(tot.totalMs)} in total · avg {span(tot.avgMs)} · longest {span(tot.longestMs)} · {tot.open} open now
                </p>
              </div>
              <div className="tools">
                <div className="tabs" role="tablist" aria-label="Filter sessions">
                  {(['all', 'open', 'closed'] as const).map((f) => (
                    <button key={f} role="tab" aria-selected={sessView === f} className={`tab${sessView === f ? ' on' : ''}`} onClick={() => setSessView(f)}>
                      {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Ended'}{' '}
                      <span className="count">{f === 'all' ? tot.count : f === 'open' ? tot.open : tot.count - tot.open}</span>
                    </button>
                  ))}
                </div>
                <button className="btn small" onClick={() => download(`muse-sessions-${new Date(now).toISOString().slice(0, 10)}.csv`, sessionsCSV(s, now), 'text/csv')}>
                  Export sessions (CSV)
                </button>
              </div>
            </header>
            <div className="table-wrap sessions-wrap">
              <table className="accounts sessions">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Started</th>
                    <th>Ended</th>
                    <th className="num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {sessList.map((x) => {
                    const a = byId(x.user)
                    return (
                      <tr key={x.id} className={x.end === null ? 'online' : 'offline'} onClick={() => setOpenId(a.id)}>
                        <td>
                          <div className="who">
                            <Avatar id={a.id} size={24} off={x.end !== null} />
                            <div>
                              <div className="name">{a.name}</div>
                              <div className="handle">@{a.username}</div>
                            </div>
                          </div>
                        </td>
                        <td className="mono" title={stamp(x.start)}>
                          {isToday(x.start, now) ? hms(x.start) : `${hms(x.start)} −1d`}
                        </td>
                        <td className="mono" title={x.end ? stamp(x.end) : undefined}>
                          {x.end === null ? <span className="status on">● live</span> : isToday(x.end, now) ? hms(x.end) : `${hms(x.end)} −1d`}
                        </td>
                        <td className="num mono">{x.end === null ? duration(sessionMs(x, now)) : span(sessionMs(x, now))}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </main>

        <aside className="panel log">
          <header className="panel-head">
            <div>
              <h2>
                Live log <span className={`dot${s.recording ? ' live' : ''}`} />
              </h2>
              <p className="sub">{log.length.toLocaleString()} events, newest first</p>
            </div>
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind | 'all')} aria-label="Filter log by event type">
              <option value="all">all events</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </header>
          <ol className="log-list">
            {log.slice(0, 250).map((r) => {
              const a = byId(r.user)
              return (
                <li key={r.id} className={`entry ${r.kind}${now - r.at < 4000 ? ' fresh' : ''}`} onClick={() => setOpenId(a.id)}>
                  <time title={stamp(r.at)}>{isToday(r.at, now) ? hms(r.at) : `${hms(r.at)} −1d`}</time>
                  <Avatar id={a.id} size={24} />
                  <div className="entry-body">
                    <div>
                      <b>{a.name}</b> <span className="kind">{KIND_LABEL[r.kind]}</span>
                    </div>
                    <div className="text">{r.text}</div>
                  </div>
                </li>
              )
            })}
          </ol>
        </aside>
      </div>

      {open && <UserDrawer a={open} s={s} now={now} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function compare(x: Row, y: Row, key: SortKey) {
  switch (key) {
    case 'name':
      return x.a.name.localeCompare(y.a.name)
    case 'created':
      return (x.a.created === 'today' ? '9999' : x.a.created).localeCompare(y.a.created === 'today' ? '9999' : y.a.created)
    case 'last':
      return (x.online ? 1 : 0) - (y.online ? 1 : 0) || x.st.last - y.st.last
    default:
      return x.st[key] - y.st[key]
  }
}

function Kpi({ k, v, d, live }: { k: string; v: number | string; d: string; live?: boolean }) {
  return (
    <div className="kpi">
      <div className="k">
        {live && <span className="dot live" />}
        {k}
      </div>
      <div className="v">{v}</div>
      <div className="d">{d}</div>
    </div>
  )
}
