import { memo } from 'react'
import type { Agent, User } from '../data'
import { srcStatus, type Msg, type Src, type SrcStatus } from '../store'
import { hms, spinner, stamp } from './time'

const GLYPH: Record<SrcStatus, string> = { pulling: '', verifying: '', verified: '✓', mismatch: '✗', unverified: '?' }

function SourceChip({ s, status, t }: { s: Src; status: SrcStatus; t: number }) {
  const busy = status === 'pulling' || status === 'verifying'
  const title = `${s.ref}\npulled ${stamp(s.verifyAt)}${busy ? '' : `\n${status} ${stamp(s.doneAt)}`}${s.note ? `\n${s.note}` : ''}`
  return (
    <span className={`src ${status}`} title={title}>
      <span className="head">
        <span className="g">{busy ? spinner(t) : GLYPH[status]}</span>
        <span className="ref">{s.ref}</span>
      </span>
      {busy ? (
        <span className="st">{status}…</span>
      ) : (
        <>
          {s.note && <span className="note">{s.note}</span>}
          <span className="ms">{Math.round(s.doneAt - s.at)}ms</span>
        </>
      )}
    </span>
  )
}

// The line under every message: which records about the user were pulled, and whether they back it up.
function SourceLine({ sources, t, tenantId }: { sources: Src[]; t: number; tenantId: string }) {
  const statuses = sources.map((s) => srcStatus(s, t))
  const done = statuses.filter((s) => s === 'verified' || s === 'mismatch' || s === 'unverified').length
  const verified = statuses.filter((s) => s === 'verified').length
  const flagged = statuses.filter((s) => s === 'mismatch').length
  const started = statuses.some((s) => s !== null)
  const settled = done === sources.length
  return (
    <div className="sources">
      <span className="branch">└─</span>
      <span className="ns">src[{tenantId}]</span>
      {!started && <span className="st">{spinner(t)} resolving citations…</span>}
      {sources.map((s, i) => {
        const st = statuses[i]
        return st && <SourceChip key={s.id} s={s} status={st} t={t} />
      })}
      {started && (
        <span className={`sum ${settled ? (flagged ? 'flag' : 'ok') : 'busy'}`}>
          {settled ? `${verified}/${sources.length} verified${flagged ? ` · ${flagged} flagged` : ''}` : `${done}/${sources.length} checked`}
        </span>
      )}
    </div>
  )
}

type Props = { m: Msg; t: number; agent: Agent; user: User; tenantId: string }

// `t` is min(now, settledAt), so a settled message gets the same props every frame and memo skips it.
export const MessageRow = memo(function MessageRow({ m, t, agent, user, tenantId }: Props) {
  const ts = (
    <time className="ts" dateTime={new Date(m.at).toISOString()} title={stamp(m.at)}>
      [{hms(m.at)}]
    </time>
  )
  if (m.role === 'system') {
    return (
      <div className="msg system">
        {ts}
        <span className="text">── {m.text} ──</span>
      </div>
    )
  }
  const who = m.role === 'agent' ? agent.name : m.role === 'user' ? user.email.split('@')[0] : 'operator'
  const shown = m.streamMs ? Math.floor(m.text.length * Math.min(1, (t - m.at) / m.streamMs)) : m.text.length
  const streaming = shown < m.text.length
  return (
    <div className={`msg ${m.role}`}>
      {ts}
      <span className="who" title={m.role === 'user' ? `${user.name} <${user.email}> · ${user.id}` : undefined}>
        {who}
      </span>
      <span className="text">
        {m.text.slice(0, shown)}
        {streaming && <span className="caret">▍</span>}
        {m.latencyMs !== undefined && !streaming && <span className="lat"> +{(m.latencyMs / 1000).toFixed(1)}s</span>}
      </span>
      {m.sources.length > 0 && <SourceLine sources={m.sources} t={t} tenantId={tenantId} />}
    </div>
  )
})
