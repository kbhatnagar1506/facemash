import { Avatar } from './Avatar'
import type { Account } from './data'
import { KIND_LABEL, download, involves, sessionMs, sessionTotals, stats, toCSV, useRecorder } from './recorder'
import { ago, duration, hms, isToday, span, stamp } from './time'

type Props = { a: Account; s: ReturnType<typeof useRecorder>; now: number; onClose: () => void }

// One account: who they are, their account details, their totals, and everything the recorder saw them do.
export function UserDrawer({ a, s, now, onClose }: Props) {
  const online = s.online[a.id]
  const st = stats(s, a, now)
  const mine = s.events.filter((r) => involves(r, a.id))
  const sess = s.sessions.filter((x) => x.user === a.id)
  const tot = sessionTotals(sess, now)
  const name = (id: string) => s.accounts.find((x) => x.id === id)?.name ?? id

  return (
    <div className="scrim" onMouseDown={onClose}>
      <aside className="drawer" role="dialog" aria-label={`${a.name}'s account`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <Avatar id={a.id} size={56} off={!online} />
          <div className="grow">
            <div className="d-name">{a.name}</div>
            <div className="handle">
              @{a.username} · <span className={`status ${online ? 'on' : 'off'}`}>{online ? '● Online' : `○ Offline, last seen ${ago(st.last, now)}`}</span>
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="drawer-body">
          <section>
            <h3>Account</h3>
            <dl className="facts">
              <dt>Account ID</dt>
              <dd className="mono">{a.accountId}</dd>
              <dt>Email</dt>
              <dd>{a.email}</dd>
              <dt>Sign-in</dt>
              <dd>{a.provider}</dd>
              <dt>Plan</dt>
              <dd>{a.plan}</dd>
              <dt>Joined</dt>
              <dd>{a.created === 'today' ? `today, ${hms(mine.find((r) => r.kind === 'signup')?.at ?? now)}` : a.created}</dd>
              <dt>Device</dt>
              <dd>{a.device}</dd>
              <dt>City</dt>
              <dd>{a.city}</dd>
              <dt>Role</dt>
              <dd>{a.role}</dd>
              <dt>Building</dt>
              <dd>{a.building}</dd>
              <dt>{online ? 'At' : 'Last event'}</dt>
              <dd>
                {a.event}
                {online && a.where ? ` · ${a.where}` : ''}
              </dd>
            </dl>
          </section>

          <section className="d-stats">
            <div>
              <b>{st.sessions}</b>
              <span>sessions</span>
            </div>
            <div>
              <b>{st.chats}</b>
              <span>agent chats</span>
            </div>
            <div>
              <b>{st.matches}</b>
              <span>matches</span>
            </div>
            <div>
              <b>{st.hours.toFixed(1)}</b>
              <span>hours</span>
            </div>
          </section>

          <section>
            <h3>
              Sessions, 24 h · {tot.count} · {span(tot.totalMs)}
            </h3>
            {sess.length === 0 && <p className="dim">No sessions in the last 24 h.</p>}
            <ol className="sess-list">
              {[...sess].reverse().map((x) => (
                <li key={x.id}>
                  <time title={stamp(x.start)}>{isToday(x.start, now) ? hms(x.start) : `${hms(x.start)} −1d`}</time>
                  <span className="dim">→</span>
                  <time title={x.end ? stamp(x.end) : undefined}>{x.end === null ? <b className="status on">now</b> : isToday(x.end, now) ? hms(x.end) : `${hms(x.end)} −1d`}</time>
                  <span className="dur">{x.end === null ? duration(sessionMs(x, now)) : span(sessionMs(x, now))}</span>
                </li>
              ))}
            </ol>
          </section>

          <section>
            <div className="row-between">
              <h3>Recorded activity · {mine.length}</h3>
              <button className="btn ghost small" onClick={() => download(`${a.username}-activity.csv`, toCSV(s, mine), 'text/csv')}>
                Export CSV
              </button>
            </div>
            {mine.length === 0 && <p className="dim">Nothing recorded in the last 24 h.</p>}
            <ol className="timeline">
              {[...mine].reverse().map((r) => (
                <li key={r.id} className={r.kind}>
                  <time title={stamp(r.at)}>{isToday(r.at, now) ? hms(r.at) : `${hms(r.at)} −1d`}</time>
                  <span className="kind">{KIND_LABEL[r.kind]}</span>
                  <span className="text">
                    {r.user === a.id ? r.text : `${name(r.user)}: ${r.text}`}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </aside>
    </div>
  )
}
