import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { POLL_MS, SCORE_KEYS, ms, type Checkpoint, type Line, type Person, type Side, type TalkDetail, type TalkSummary } from '../api'
import { hms, spinner, stamp } from '../ui/time'
import { Avatar } from './Avatar'
import { STOP_LABEL, duration, mmss, pct, phaseOf, pillText, scoreLabel, secs, ynWord } from './format'
import type { AdminStore } from './live'

// A talk expanded to the whole screen: the two people on either side, the agents' conversation in
// the middle (withheld lines struck through, checkpoints inline), and jev's verdict on the right.

type Props = { store: AdminStore; id: string; now: number; origin: { x: number; y: number }; onClose: () => void }

const KIND: Record<Line['kind'], string> = { greeting: 'hello', question: 'asks', answer: 'answers', close: 'bye' }

export function ChatFocus({ store, id, now, origin, onClose }: Props) {
  const [closing, setClosing] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const t: TalkSummary | undefined = store.talks.get(id)
  const d: TalkDetail | undefined = store.details.get(id)
  const lines = store.lines(id) ?? []
  const stale = store.needsDetail(id)

  const close = () => {
    setClosing(true)
    setTimeout(onClose, 180)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // the full transcript now, again whenever the talk moves on, and every 3 s while live and polling
  useEffect(() => {
    if (stale) void store.ensureDetail(id, true)
  }, [id, stale, store])
  const live = t?.status === 'live'
  useEffect(() => {
    if (!live) return
    const iv = setInterval(() => store.mode === 'poll' && store.ensureDetail(id, true), POLL_MS)
    return () => clearInterval(iv)
  }, [id, live, store])

  useLayoutEffect(() => {
    const el = log.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: lines.length > 1 ? 'smooth' : 'auto' })
  }, [lines.length])

  if (!t) return null
  const phase = phaseOf(t, lines)
  const start = ms(t.started_at)
  const withheld = lines.filter((l) => l.withheld).length
  const next: Side | null = phase === 'live' ? (lines.length ? (lines[lines.length - 1].from === 'a' ? 'b' : 'a') : 'a') : null
  const P = (s: Side) => (s === 'a' ? t.a : t.b)
  const cps = d?.checkpoints ?? []

  // lines and checkpoints on one timeline
  const items: ({ at: number; line: Line; i: number } | { at: number; cp: Checkpoint })[] = [
    ...lines.map((line, i) => ({ at: ms(line.at), line, i })),
    // an untimed checkpoint goes after the lines it judged
    ...cps.map((cp, i) => ({ at: cp.at ? ms(cp.at) : Number.MAX_SAFE_INTEGER - 2 + i, cp })),
  ].sort((x, y) => x.at - y.at)

  return (
    <div className={`focus-scrim${closing ? ' closing' : ''}`} onMouseDown={close}>
      <div
        className="focus"
        role="dialog"
        aria-label={`Agent talk between ${t.a.first_name} and ${t.b.first_name}`}
        style={{ '--ox': `${origin.x}px`, '--oy': `${origin.y}px` } as CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="f-head">
          <div>
            <div className="f-who">
              muse·{t.a.first_name} <span className="dim">⇄</span> muse·{t.b.first_name}
            </div>
            <div className="f-sub">
              {t.id} · started <time title={stamp(start)}>{hms(start)}</time> · {mmss(duration(t, now))} {phase === 'live' ? 'talking' : 'long'} · {t.turns} turns · jev {t.config_version}
            </div>
          </div>
          <span className={`pill big ${phase}`}>{pillText(phase, t, spinner(now))}</span>
          <button className="f-close" onClick={close} aria-label="Close full screen chat">
            ✕ <span>esc</span>
          </button>
        </header>

        <div className="f-body">
          <aside className="f-side">
            <PersonCard p={t.a} side="a" t={t} lines={lines} />
            <section className="f-card">
              <h3>
                <i className={`dot ${phase === 'live' ? 'live' : ''}`} /> line monitor
              </h3>
              <dl className="f-stats">
                <dt>status</dt>
                <dd>{t.status}</dd>
                <dt>lines</dt>
                <dd>{lines.length}</dd>
                <dt>sourced</dt>
                <dd>{lines.filter((l) => !l.withheld && l.cites.length).length}</dd>
                <dt>withheld</dt>
                <dd className={withheld ? 'hot' : ''}>{Math.max(withheld, t.withheld)}</dd>
                {t.stopped_at && (
                  <>
                    <dt>ended</dt>
                    <dd>{STOP_LABEL[t.stopped_at] ?? t.stopped_at}</dd>
                  </>
                )}
              </dl>
              <p className="f-note">Every sentence should trace back to its owner's brief or notes. The guard cuts what doesn't (and any contact details) before it is said; a trimmed line is flagged with the reason, a line cut entirely is struck out.</p>
            </section>
            {d && <Timings d={d} />}
          </aside>

          <main
            className="f-log"
            ref={log}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            {!lines.length && <div className="f-empty">{stale ? `${spinner(now)} loading transcript…` : phase === 'live' ? `${spinner(now)} agents are opening the conversation…` : 'no lines recorded'}</div>}
            {items.map((it) =>
              'cp' in it ? (
                <CheckpointMark key={it.cp.name} cp={it.cp} start={start} />
              ) : (
                <Bubble key={it.i} l={it.line} p={P(it.line.from)} />
              ),
            )}
            {next && (
              <div className={`fm ${next} typing`}>
                <Avatar seed={P(next).id} bean={P(next).bean} size={40} />
                <div className="fm-body">
                  <div className="fm-meta">muse·{P(next).first_name} is replying</div>
                  <div className="fm-bubble">
                    <span className="bounce">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                </div>
              </div>
            )}
            {phase !== 'live' && lines.length > 0 && <div className="f-end">── {phase === 'judging' ? 'agents finished · jev is judging' : t.stopped_at ? `agents finished · ${STOP_LABEL[t.stopped_at] ?? t.stopped_at}` : 'agents finished'} ──</div>}
          </main>

          <aside className="f-side">
            <PersonCard p={t.b} side="b" t={t} lines={lines} />
            <Verdict t={t} phase={phase} now={now} />
            {cps.length > 0 && (
              <section className="f-card">
                <h3>checkpoints</h3>
                {cps.map((cp) => (
                  <CheckpointCard key={cp.name} cp={cp} t={t} start={start} />
                ))}
              </section>
            )}
            <After t={t} d={d} />
          </aside>
        </div>
      </div>
    </div>
  )
}

function Bubble({ l, p }: { l: Line; p: Person }) {
  const at = ms(l.at)
  return (
    <div className={`fm ${l.from}${l.withheld ? (l.text.trim() ? ' partial' : ' struck') : ''}`}>
      <Avatar seed={p.id} bean={p.bean} size={40} />
      <div className="fm-body">
        <div className="fm-meta">
          <time title={stamp(at)}>{hms(at)}</time> · muse·{p.first_name} {KIND[l.kind] ?? l.kind}
          {l.question_id && <span className="qid">{l.question_id}</span>}
        </div>
        <div className="fm-bubble">{l.text.trim() || 'withheld line'}</div>
        {l.withheld ? (
          <div className="fm-src">
            ⊘ {l.text.trim() ? <s>part withheld</s> : 'withheld'} · {l.withheld_reason || 'no reason given'}
          </div>
        ) : l.cites.length ? (
          <div className="fm-src">↳ from {l.cites.join(' · ')}</div>
        ) : null}
      </div>
    </div>
  )
}

function CheckpointMark({ cp, start }: { cp: Checkpoint; start: number }) {
  return (
    <div className={`f-cp ${cp.passed ? 'pass' : 'fail'}`}>
      <span>
        {cp.name === 'checkpoint1' ? 'checkpoint 1' : 'checkpoint 2'} · {cp.passed ? 'passed' : 'stopped'}
        {cp.at ? ` · +${mmss((ms(cp.at) - start) / 1000)}` : ''}
      </span>
    </div>
  )
}

function PersonCard({ p, side, t, lines }: { p: Person; side: Side; t: TalkSummary; lines: Line[] }) {
  const cited = [...new Set(lines.filter((l) => l.from === side && !l.withheld).flatMap((l) => l.cites))]
  const on = t.status === 'live'
  return (
    <section className={`f-person ${on ? 'on' : 'off'} ${side}`}>
      <div className="u-state">{on ? '● IN AGENT TALK' : `○ ${side === 'a' ? 'SIDE A' : 'SIDE B'}`}</div>
      <div className="fp-name">
        <Avatar seed={p.id} bean={p.bean} size={44} />
        {p.first_name}
      </div>
      <div className="fp-role">
        #{p.id} · {p.source === 'muse' ? 'connected a Muse agent' : p.source === 'voice' ? 'voice onboarding' : 'no agent source'}
      </div>
      <div className="fp-row">approval: {ynWord(t.approvals[side], '✓ approved', '✗ declined')}</div>
      <div className="fp-row">worth it: {ynWord(t.worth_it[side], '✓ yes', '✗ no', '—')}</div>
      <div className="fp-cited">
        <b>memories the agent cited</b>
        {cited.length ? cited.map((k) => <span key={k}>{k}</span>) : <em>nothing yet</em>}
      </div>
    </section>
  )
}

function Verdict({ t, phase, now }: { t: TalkSummary; phase: ReturnType<typeof phaseOf>; now: number }) {
  return (
    <section className="f-card jev">
      <h3>jev verdict</h3>
      {phase === 'live' && <p className="dim">Judged at the checkpoints once the agents have talked enough.</p>}
      {phase === 'judging' && <p>{spinner(now)} the agents said goodbye; jev is scoring…</p>}
      {phase === 'abandoned' && <p className="dim">The talk was abandoned before a verdict.</p>}
      {(phase === 'match' || phase === 'nomatch' || phase === 'done') && (
        <>
          <div className="f-score">
            {t.overall != null ? Math.round(t.overall) : '—'}
            <small>{phase === 'match' ? '% · match' : phase === 'nomatch' ? '% · no match' : '%'}</small>
          </div>
          {t.scores &&
            SCORE_KEYS.map((k) => (
              <Bar5 key={k} k={scoreLabel(k, t)} v={t.scores![k]} />
            ))}
          {t.reason && (
            <p className="f-reason">
              <b>reason</b>
              {t.reason}
            </p>
          )}
          {t.stopped_at && <p className="dim small">{STOP_LABEL[t.stopped_at] ?? t.stopped_at}</p>}
        </>
      )}
    </section>
  )
}

/** A 1-5 score. */
export function Bar5({ k, v }: { k: string; v: number }) {
  return (
    <div className="bar wide">
      <span>{k}</span>
      <span className="track">
        <span style={{ width: `${Math.max(0, Math.min(100, (v / 5) * 100))}%` }} />
      </span>
      <span>{v.toFixed(1)}</span>
    </div>
  )
}

function CheckpointCard({ cp, t, start }: { cp: Checkpoint; t: TalkSummary; start: number }) {
  return (
    <div className="f-cpc">
      <div className="f-cpc-h">
        <b>{cp.name === 'checkpoint1' ? 'checkpoint 1' : 'checkpoint 2'}</b>
        <span className={`tag ${cp.passed ? 'yes' : 'no'}`}>{cp.passed ? 'passed' : 'stopped'}</span>
        <span className="dim">{cp.at ? `+${mmss((ms(cp.at) - start) / 1000)}` : ''}</span>
      </div>
      {Object.entries(cp.gates).map(([g, p]) => (
        <div className="bar gate" key={g}>
          <span>{g.replaceAll('_', ' ')}</span>
          <span className="track">
            <span style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }} />
          </span>
          <span>{pct(p)}</span>
        </div>
      ))}
      {cp.scores && (
        <div className="f-cpc-scores">
          {SCORE_KEYS.map((k) => (
            <span key={k}>
              {scoreLabel(k, t)} <b>{(cp.scores![k] ?? 0).toFixed(1)}</b>
            </span>
          ))}
        </div>
      )}
      {cp.choices && Object.keys(cp.choices).length > 0 && (
        <dl className="f-choices">
          {Object.entries(cp.choices).map(([k, c]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>
                {c.choice} <span className="dim">{pct(c.confidence)}</span>
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  )
}

function After({ t, d }: { t: TalkSummary; d?: TalkDetail }) {
  if (t.status === 'live' && !t.match) return null
  return (
    <section className="f-card">
      <h3>after the talk</h3>
      <dl className="f-stats">
        <dt>match</dt>
        <dd>{ynWord(t.match, 'yes', 'no', '—')}</dd>
        <dt>{t.a.first_name} approved</dt>
        <dd>{ynWord(t.approvals.a, '✓', '✗', '…')}</dd>
        <dt>{t.b.first_name} approved</dt>
        <dd>{ynWord(t.approvals.b, '✓', '✗', '…')}</dd>
        <dt>revealed</dt>
        <dd className={t.revealed ? 'hot' : ''}>{t.revealed ? 'yes' : 'no'}</dd>
        <dt>worth it · {t.a.first_name}</dt>
        <dd>{ynWord(t.worth_it.a, '✓', '✗', '—')}</dd>
        <dt>worth it · {t.b.first_name}</dt>
        <dd>{ynWord(t.worth_it.b, '✓', '✗', '—')}</dd>
      </dl>
      {d?.icebreaker && (
        <div className="f-topic">
          <b>icebreaker</b>
          {d.icebreaker.line}
          <div className="f-q">“{d.icebreaker.question}”</div>
        </div>
      )}
      {!!d?.hot_topics?.length && (
        <div className="fp-cited hot">
          <b>hot topics</b>
          {d.hot_topics.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      )}
    </section>
  )
}

function Timings({ d }: { d: TalkDetail }) {
  const tm = d.timings_ms
  if (!tm || (!tm.first_bubble && !tm.checkpoint1 && !tm.verdict)) return null
  return (
    <section className="f-card">
      <h3>timings</h3>
      <dl className="f-stats">
        <dt>first bubble</dt>
        <dd>{secs(tm.first_bubble)}</dd>
        <dt>checkpoint 1</dt>
        <dd>{secs(tm.checkpoint1)}</dd>
        <dt>verdict</dt>
        <dd>{secs(tm.verdict)}</dd>
        <dt>reveal</dt>
        <dd>{secs(tm.reveal)}</dd>
      </dl>
    </section>
  )
}
