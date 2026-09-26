import { memo, useLayoutEffect, useRef, useState } from 'react'
import { hms, stamp } from '../ui/time'
import { EVENT, LABEL_TEXT, MY_DATA, PEOPLE, matchLabel, type Person, type SourceId } from './data'
import { T0, TL, phase, shownTurns, turnTime } from './timeline'

export type Selection = { kind: 'person'; id: string } | { kind: 'data'; id: SourceId } | { kind: 'me' } | null

type Props = { sel: NonNullable<Selection>; t: number; onSelect: (s: Selection) => void }

const DATA = Object.fromEntries(MY_DATA.map((d) => [d.id, d]))
const initials = (name: string) => name.split(' ').map((w) => w[0]).join('')

export const Panel = memo(function Panel({ sel, t, onSelect }: Props) {
  return (
    <aside className="panel" aria-label="Details">
      <button className="close" onClick={() => onSelect(null)} aria-label="Close">
        ✕
      </button>
      {sel.kind === 'person' && <PersonView key={sel.id} p={PEOPLE.find((p) => p.id === sel.id)!} t={t} />}
      {sel.kind === 'me' && <MeView t={t} onSelect={onSelect} />}
      {sel.kind === 'data' && <DataView id={sel.id} t={t} onSelect={onSelect} />}
    </aside>
  )
})

function PersonView({ p, t }: { p: Person; t: number }) {
  const ph = phase(p, t)
  const turns = shownTurns(p, t)
  const label = matchLabel(p.score.overall)
  const [asked, setAsked] = useState(false)
  const log = useRef<HTMLOListElement>(null)
  const first = p.name.split(' ')[0]
  const next = p.turns[turns.length]
  const typing = (ph === 'talking' || ph === 'handshake') && next

  useLayoutEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, !!typing])

  return (
    <div className="pview">
      <header className="phead">
        <div className={`avatar ${ph === 'matched' ? label : ph}`}>{initials(p.name)}</div>
        <div>
          <h2>{p.name}</h2>
          <div className="role">{p.role}</div>
          <div className="where">
            {p.distance} m away · {p.spot}
          </div>
        </div>
      </header>

      {ph === 'matched' ? (
        <section className={`match ${label}`}>
          <div className="match-top">
            <Ring value={p.score.overall} />
            <div>
              <div className="match-label">{LABEL_TEXT[label]}</div>
              <div className="dim small">classified by jev · {hms(classifiedAt(p))}</div>
            </div>
          </div>
          <Bar k="Thoughts" v={p.score.thoughts} />
          <Bar k="Current career" v={p.score.career} />
          <Bar k="What you're building" v={p.score.building} />
          <div className="opener">
            <div className="opener-h">Suggested first topic</div>
            <p>{p.opener}</p>
          </div>
          <button className={`meet${asked ? ' done' : ''}`} onClick={() => setAsked(true)} disabled={asked}>
            {asked ? `Sent · muse will tell ${first}'s agent` : `Suggest meeting ${first}`}
          </button>
        </section>
      ) : (
        <section className="match pending">
          <div className="match-top">
            <Ring value={null} />
            <div>
              <div className="match-label">{ph === 'classifying' ? 'jev is classifying…' : ph === 'handshake' ? 'Agents are connecting…' : 'Agents are talking'}</div>
              <div className="dim small">Similarity, compatibility and a first topic appear once the chat ends.</div>
            </div>
          </div>
          <Bar k="Thoughts" v={null} />
          <Bar k="Current career" v={null} />
          <Bar k="What you're building" v={null} />
        </section>
      )}

      <div className="chat-h">
        <span>
          muse <span className="dim">⇄</span> {p.agent}
        </span>
        <span className="oc">
          <i className="dot live" /> OpenClaw
        </span>
      </div>
      <ol className="chat" ref={log}>
        {turns.length === 0 && <li className="sys">{ph === 'handshake' ? `${first} entered your ${EVENT.radius} m radius. Agents are connecting…` : ''}</li>}
        {turns.map((turn, i) => {
          const at = turnTime(p, i)
          const mine = turn.from === 'muse'
          return (
            <li key={i} className={`turn ${mine ? 'muse' : 'them'}${turn.flag ? ' flagged' : ''}`}>
              <div className="meta">
                <b>{mine ? 'muse' : p.agent}</b>
                <time dateTime={new Date(at).toISOString()} title={stamp(at)}>
                  {hms(at)}
                </time>
                <span className={`gr${turn.flag ? ' bad' : ''}`}>{turn.flag ? '✗ unsourced' : '✓ sourced'}</span>
              </div>
              <div className="bubble">{turn.text}</div>
              <div className="cite">
                {turn.flag ? (
                  <>⚠ OpenClaw: {turn.flag}</>
                ) : mine ? (
                  <>
                    ↳ from your <b>{DATA[turn.src!].label}</b> · {turn.cite}
                  </>
                ) : (
                  <>
                    ↳ from {first}'s history · {turn.cite}
                  </>
                )}
              </div>
            </li>
          )
        })}
        {typing && (
          <li className={`turn ${next.from === 'muse' ? 'muse' : 'them'} typing`}>
            <div className="meta">
              <b>{next.from === 'muse' ? 'muse' : p.agent}</b>
            </div>
            <div className="bubble">
              <span className="dots" aria-label="typing" />
            </div>
            <div className="cite">{next.from === 'muse' ? '↳ searching your history…' : `↳ searching ${first}'s history…`}</div>
          </li>
        )}
        {ph === 'classifying' && <li className="sys">Chat ended. jev is scoring thoughts, career and what you're building…</li>}
      </ol>
    </div>
  )
}

const classifiedAt = (p: Person) => T0 + TL[p.id].classify * 1000

function MeView({ t, onSelect }: { t: number; onSelect: (s: Selection) => void }) {
  const met = PEOPLE.filter((p) => phase(p, t) !== 'hidden')
  const cites = (id: SourceId) => met.flatMap((p) => shownTurns(p, t).filter((x) => x.src === id)).length
  const ranked = met.filter((p) => phase(p, t) === 'matched').sort((a, b) => b.score.overall - a.score.overall)
  return (
    <div className="pview">
      <header className="phead">
        <div className="avatar me">you</div>
        <div>
          <h2>You</h2>
          <div className="role">muse is representing you at {EVENT.name}</div>
          <div className="where">
            {met.length} agents met · {ranked.filter((p) => p.score.overall >= 55).length} worth meeting
          </div>
        </div>
      </header>
      <p className="explain">
        Muse can only say what is in these sources. Every reply it sends cites one of them, and OpenClaw drops anything unsourced.
      </p>
      <div className="list-h">Your data</div>
      <ul className="dlist">
        {MY_DATA.map((d) => (
          <li key={d.id}>
            <button onClick={() => onSelect({ kind: 'data', id: d.id })}>
              <span className="dl">{d.label}</span>
              <span className="dn">{cites(d.id)} cited</span>
              <span className="ds">{d.summary}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="list-h">Matches so far</div>
      <ul className="dlist">
        {ranked.map((p) => (
          <li key={p.id}>
            <button onClick={() => onSelect({ kind: 'person', id: p.id })}>
              <span className="dl">
                <i className={`sw ${matchLabel(p.score.overall)}`} /> {p.name}
              </span>
              <span className="dn">{p.score.overall}%</span>
              <span className="ds">{p.role}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DataView({ id, t, onSelect }: { id: SourceId; t: number; onSelect: (s: Selection) => void }) {
  const d = DATA[id]
  const uses = PEOPLE.flatMap((p) =>
    shownTurns(p, t).flatMap((turn, i) => (turn.src === id ? [{ p, turn, at: turnTime(p, i) }] : [])),
  ).sort((a, b) => b.at - a.at)
  return (
    <div className="pview">
      <header className="phead">
        <div className="avatar data">{d.label[0]}</div>
        <div>
          <h2>Your {d.label}</h2>
          <div className="role">{d.summary}</div>
          <div className="where">
            cited {uses.length} times in {new Set(uses.map((u) => u.p.id)).size} conversations
          </div>
        </div>
      </header>
      <div className="list-h">Where muse used it</div>
      <ul className="dlist">
        {uses.length === 0 && <li className="dim small">Not cited yet.</li>}
        {uses.map(({ p, turn, at }, k) => (
          <li key={k}>
            <button onClick={() => onSelect({ kind: 'person', id: p.id })}>
              <span className="dl">to {p.name}</span>
              <span className="dn" title={stamp(at)}>
                {hms(at)}
              </span>
              <span className="ds">↳ {turn.cite}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Ring({ value }: { value: number | null }) {
  const c = 2 * Math.PI * 30
  return (
    <svg className="ring" viewBox="0 0 72 72" aria-label={value === null ? 'not scored yet' : `${value}% similarity`}>
      <circle cx="36" cy="36" r="30" className="track" />
      {value !== null && <circle cx="36" cy="36" r="30" className="val" strokeDasharray={`${(c * value) / 100} ${c}`} />}
      <text x="36" y="41">
        {value === null ? '–' : `${value}%`}
      </text>
    </svg>
  )
}

function Bar({ k, v }: { k: string; v: number | null }) {
  return (
    <div className="bar">
      <span className="bk">{k}</span>
      <span className="track">{v !== null ? <span className="fill" style={{ width: `${v}%` }} /> : <span className="shimmer" />}</span>
      <span className="bv">{v === null ? '' : `${v}%`}</span>
    </div>
  )
}
