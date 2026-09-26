import { createContext, useContext, useEffect, useState } from 'react'
import { ago, hms, stamp, useNow } from '../ui/time'
import { ACCOUNT, INFO, THREADS, infoLabel, type Check, type From, type Status, type Thread } from './data'
import './wireframe.css'

// Wireframe: every ongoing agent conversation running on behalf of one user account.
// Numbered pins map to the design notes at the bottom of the page.

const T0 = Date.now()
type Msg = { from: From; at: number; text: string; checks?: Check[] }
type Decision = { choice: 'approved' | 'declined'; at: number }
type Live = Thread & { msgs: Msg[] }

const STATUS: Record<Status, string> = { 'needs-you': 'Needs you', active: 'Active', waiting: 'Waiting on them', done: 'Done' }
const FILTERS: (Status | 'all')[] = ['all', 'needs-you', 'active', 'waiting', 'done']
const GLYPH = { verified: '✓', mismatch: '✗', unverified: '?', pending: '…' }

const NOTES = [
  'Account bar: the single identity every agent acts as. "Pause all agents" is the kill switch.',
  'Summary: how many chats are live, what is waiting on you, and how much of your info has gone out.',
  'Chat grid: one card per ongoing agent conversation, showing the agent, who it is talking to, the channel, the goal and its status.',
  'Timestamps: every message has its send time (hover for full date). Cards show time since last activity.',
  'Source line: under every message. For your agent: which of your info it shared, and the record it was verified against. For the other side: their claims checked against your records. ✗ means a claim contradicts your records.',
  'Needs you: anything outside an agent’s permissions (money over the limit, sensitive info) stops here until you decide.',
  'Your info: every piece of your data the agents can use, where it is verified from, and which chats used it. Click one to filter the grid.',
  'Thread view: the full transcript. You can take over and message as yourself at any point.',
]

const NotesOn = createContext(true)
function Pin({ n }: { n: number }) {
  return useContext(NotesOn) ? (
    <span className="pin" title={NOTES[n - 1]} aria-label={`design note ${n}`}>
      {n}
    </span>
  ) : null
}

const toMsgs = (t: Thread): Msg[] => t.lines.map((l) => ({ from: l.from, text: l.text, checks: l.checks, at: T0 - l.min * 60_000 }))

export function Wireframe() {
  const now = useNow(10_000)
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [infoFilter, setInfoFilter] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [notes, setNotes] = useState(true)
  const [paused, setPaused] = useState(false)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [sent, setSent] = useState<Record<string, Msg[]>>({})

  // apply what the user did in this session on top of the mock threads
  const threads = THREADS.map((t) => {
    const d = decisions[t.id]
    const msgs = toMsgs(t)
    let status = t.status
    if (d && t.approval) {
      msgs.push({ from: 'you', at: d.at, text: d.choice === 'approved' ? `Approved: ${t.approval.ask}` : `Declined: ${t.approval.ask}` })
      msgs.push({
        from: 'agent',
        at: d.at + 1500,
        text: d.choice === 'approved' ? t.approval.yes : t.approval.no,
        checks: d.choice === 'approved' ? [{ info: t.approval.info, result: 'verified', note: `approved by you at ${hms(d.at)}` }] : undefined,
      })
      status = 'active'
    }
    const mine = sent[t.id] ?? []
    if (mine.length) status = 'active'
    return { ...t, status, typing: t.typing && !paused, msgs: [...msgs, ...mine].sort((a, b) => a.at - b.at) }
  })

  const decide = (id: string, choice: Decision['choice']) => setDecisions((d) => ({ ...d, [id]: { choice, at: Date.now() } }))
  const send = (id: string, text: string) => setSent((s) => ({ ...s, [id]: [...(s[id] ?? []), { from: 'you', at: Date.now(), text }] }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenId(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const usedBy = (infoId: string) => threads.filter((t) => t.msgs.some((m) => m.checks?.some((c) => c.info === infoId)))
  const shown = threads.filter((t) => (filter === 'all' || t.status === filter) && (!infoFilter || usedBy(infoFilter).includes(t)))
  const allChecks = threads.flatMap((t) => t.msgs.flatMap((m) => (m.checks ?? []).map((c) => ({ c, from: m.from }))))
  const shares = allChecks.filter((x) => x.from === 'agent').length
  const flagged = allChecks.filter((x) => x.c.result === 'mismatch').length
  const lastAt = Math.max(...threads.flatMap((t) => t.msgs.map((m) => m.at)))
  const needs = threads.filter((t) => t.status === 'needs-you')
  const open = threads.find((t) => t.id === openId)

  return (
    <NotesOn.Provider value={notes}>
      <div className="wf">
        <header className="wf-top">
          <div className="ph logo">LOGO</div>
          <div className="wf-title">
            Agent activity <Pin n={1} />
          </div>
          <div className="acct">
            <div className="avatar">{ACCOUNT.initials}</div>
            <div>
              <div className="acct-name">{ACCOUNT.name}</div>
              <div className="dim">
                {ACCOUNT.email} · {ACCOUNT.plan}
              </div>
            </div>
          </div>
          <div className="top-actions">
            <button className={`btn${paused ? ' inv' : ''}`} onClick={() => setPaused((p) => !p)}>
              {paused ? '▶ Resume all agents' : '❚❚ Pause all agents'}
            </button>
            <button className="btn ghost" title="Not part of this wireframe">
              Permissions
            </button>
            <button className="btn ghost" onClick={() => setNotes((n) => !n)} aria-pressed={notes}>
              Notes {notes ? 'on' : 'off'}
            </button>
          </div>
        </header>

        {paused && <div className="banner">All agents paused. Nothing is sent on your behalf until you resume.</div>}

        <section className="summary" aria-label="Summary">
          <Pin n={2} />
          <Stat k="ongoing chats" v={threads.filter((t) => t.status !== 'done').length} />
          <Stat k="need you" v={needs.length} strong={needs.length > 0} />
          <Stat k="times your info was shared" v={shares} />
          <Stat k="claims flagged against your records" v={flagged} />
          <Stat k="last activity" v={`${ago(lastAt, now)} ago`} />
        </section>

        <div className="wf-body">
          <main className="wf-main">
            <div className="toolbar">
              <div className="tabs" role="tablist">
                {FILTERS.map((f) => (
                  <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
                    {f === 'all' ? 'All' : STATUS[f]} <span className="count">{f === 'all' ? threads.length : threads.filter((t) => t.status === f).length}</span>
                  </button>
                ))}
              </div>
              {infoFilter && (
                <button className="chip" onClick={() => setInfoFilter(null)}>
                  used {infoLabel(infoFilter)} ✕
                </button>
              )}
              <Pin n={3} />
            </div>

            <div className="grid">
              {shown.map((t, i) => (
                <Card key={t.id} t={t} now={now} first={i === 0} onOpen={() => setOpenId(t.id)} />
              ))}
              {shown.length === 0 && <div className="ph empty">No chats match this filter</div>}
            </div>

            {notes && (
              <section className="notes" aria-label="Design notes">
                <h2>Design notes</h2>
                <ol>
                  {NOTES.map((n, i) => (
                    <li key={i}>
                      <span className="pin static">{i + 1}</span>
                      {n}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </main>

          <aside className="rail">
            <section className="box">
              <h2>
                Needs you <span className="count">{needs.length}</span> <Pin n={6} />
              </h2>
              {needs.length === 0 && <p className="dim">Nothing waiting on you.</p>}
              {needs.map((t) => (
                <div className="ask" key={t.id}>
                  <div className="dim small">
                    {t.agent} ⇄ {t.counterparty}
                  </div>
                  <p>{t.approval?.ask}</p>
                  <div className="row">
                    <button className="btn inv" onClick={() => decide(t.id, 'approved')}>
                      Approve
                    </button>
                    <button className="btn" onClick={() => decide(t.id, 'declined')}>
                      Decline
                    </button>
                    <button className="link" onClick={() => setOpenId(t.id)}>
                      View chat →
                    </button>
                  </div>
                </div>
              ))}
            </section>

            <section className="box">
              <h2>
                Your info agents can use <Pin n={7} />
              </h2>
              <ul className="ledger">
                {INFO.map((info) => {
                  const users = usedBy(info.id)
                  const on = infoFilter === info.id
                  return (
                    <li key={info.id}>
                      <button className={`ledger-row${on ? ' on' : ''}`} onClick={() => setInfoFilter(on ? null : info.id)} disabled={!users.length}>
                        <span className="l-label">{info.label}</span>
                        <span className="l-used">{users.length ? `${users.length} chat${users.length > 1 ? 's' : ''}` : 'unused'}</span>
                        <span className="l-value">{info.value}</span>
                        <span className="l-src">
                          ✓ {info.source} · {ago(T0 - info.verifiedMin * 60_000, now)} ago
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          </aside>
        </div>

        {open && <ThreadView t={open} onClose={() => setOpenId(null)} onDecide={(c) => decide(open.id, c)} onSend={(text) => send(open.id, text)} />}
      </div>
    </NotesOn.Provider>
  )
}

function Card({ t, now, first, onOpen }: { t: Live; now: number; first: boolean; onOpen: () => void }) {
  const last = t.msgs.slice(-2)
  const infoUsed = new Set(t.msgs.flatMap((m) => (m.from === 'agent' ? (m.checks ?? []).map((c) => c.info) : []))).size
  const lastAt = t.msgs.at(-1)!.at
  return (
    <article className={`card ${t.status}`}>
      <header className="card-head">
        <div className="ph icon" aria-hidden />
        <div className="card-titles">
          <div className="aname">{t.agent}</div>
          <div className="cp">
            ⇄ {t.counterparty} <span className="tag">{t.party}</span>
          </div>
        </div>
        <StatusPill s={t.status} />
      </header>
      <div className="goal">
        <span className="lbl">Goal</span> {t.goal}
      </div>
      <div className="preview">
        {last.map((m, i) => (
          <Message key={i} m={m} t={t} pins={first && i === last.length - 1} />
        ))}
        {t.typing && (
          <div className="typing">
            {t.agent} is typing<span className="dots" aria-hidden />
          </div>
        )}
      </div>
      <footer className="card-foot">
        <span>{t.channel}</span>
        <span>{t.msgs.length} msgs</span>
        <span>{infoUsed} info shared</span>
        <span title={stamp(lastAt)}>{ago(lastAt, now)} ago</span>
        <button className="link" onClick={onOpen}>
          Open chat →
        </button>
      </footer>
    </article>
  )
}

function Stat({ k, v, strong }: { k: string; v: number | string; strong?: boolean }) {
  return (
    <div className={`stat${strong ? ' strong' : ''}`}>
      <div className="v">{v}</div>
      <div className="k">{k}</div>
    </div>
  )
}

function StatusPill({ s }: { s: Status }) {
  return <span className={`pill ${s}`}>{s === 'active' && <span className="live" aria-hidden />}{STATUS[s]}</span>
}

function Sources({ checks, from }: { checks: Check[]; from: From }) {
  return (
    <div className="src">
      <span className="lead">└ {from === 'them' ? 'checked against your info' : 'your info shared'}</span>
      {checks.map((c, i) => (
        <span key={i} className={`chk ${c.result}`} title={c.result}>
          <span className="g">{GLYPH[c.result]}</span>
          <b>{infoLabel(c.info)}</b>
          <span className="cnote">{c.note}</span>
          {c.result === 'mismatch' && <span className="flag">FLAG</span>}
        </span>
      ))}
    </div>
  )
}

function Message({ m, t, pins }: { m: Msg; t: Thread; pins?: boolean }) {
  const who = m.from === 'agent' ? `${t.agent} (for you)` : m.from === 'them' ? t.counterparty : m.from === 'you' ? 'You' : 'System'
  return (
    <div className={`msg ${m.from}`}>
      <div className="meta">
        <span className="who">{who}</span>
        <time dateTime={new Date(m.at).toISOString()} title={stamp(m.at)}>
          {hms(m.at)}
        </time>
        {pins && <Pin n={4} />}
      </div>
      <div className="bubble">{m.text}</div>
      {m.checks && m.checks.length > 0 && (
        <>
          <Sources checks={m.checks} from={m.from} />
          {pins && <Pin n={5} />}
        </>
      )}
    </div>
  )
}

type ViewProps = {
  t: Live
  onClose: () => void
  onDecide: (c: Decision['choice']) => void
  onSend: (text: string) => void
}

function ThreadView({ t, onClose, onDecide, onSend }: ViewProps) {
  const [draft, setDraft] = useState('')
  return (
    <div className="scrim" onMouseDown={onClose}>
      <aside className="drawer" role="dialog" aria-label={`${t.agent} with ${t.counterparty}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="ph icon" aria-hidden />
          <div className="card-titles">
            <div className="aname">
              {t.agent} <Pin n={8} />
            </div>
            <div className="cp">
              ⇄ {t.counterparty} <span className="tag">{t.party}</span> · {t.channel}
            </div>
          </div>
          <StatusPill s={t.status} />
          <button className="btn ghost close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="drawer-meta">
          <div>
            <span className="lbl">Goal</span> {t.goal}
          </div>
          <div>
            <span className="lbl">Acting as</span> {ACCOUNT.name} · can share: name, email, calendar, card ≤ $50
          </div>
        </div>
        <div className="transcript">
          {t.msgs.map((m, i) => (
            <Message key={i} m={m} t={t} />
          ))}
          {t.typing && (
            <div className="typing">
              {t.agent} is typing<span className="dots" aria-hidden />
            </div>
          )}
        </div>
        {t.status === 'needs-you' && t.approval && (
          <div className="approval">
            <p>{t.approval.ask}</p>
            <div className="row">
              <button className="btn inv" onClick={() => onDecide('approved')}>
                Approve
              </button>
              <button className="btn" onClick={() => onDecide('declined')}>
                Decline
              </button>
            </div>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            if (!draft.trim()) return
            onSend(draft.trim())
            setDraft('')
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Take over: message ${t.counterparty} as yourself`} aria-label="Message as yourself" />
          <button className="btn inv" type="submit">
            Send
          </button>
        </form>
      </aside>
    </div>
  )
}
