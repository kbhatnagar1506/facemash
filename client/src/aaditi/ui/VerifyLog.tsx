import { TENANT } from '../data'
import { srcStatus, type Chat, type SrcStatus } from '../store'
import { hms, spinner, stamp } from './time'

const GLYPH: Record<SrcStatus, string> = { pulling: '↓', verifying: '', verified: '✓', mismatch: '✗', unverified: '?' }

// Every source lookup in scope, newest first: the audit trail of what the agents checked about users.
export function VerifyLog({ chats, now }: { chats: Chat[]; now: number }) {
  const rows = []
  for (const c of chats) {
    for (const m of c.messages) {
      for (const s of m.sources) {
        const st = srcStatus(s, now)
        if (!st) continue
        const t = st === 'pulling' ? s.at : st === 'verifying' ? s.verifyAt : s.doneAt
        rows.push({ s, st, t, chat: c })
      }
    }
  }
  rows.sort((a, b) => b.t - a.t)
  return (
    <aside className="vlog" aria-label="Source verification log">
      <div className="vlog-h">
        verify log <span className="dim">· {rows.length} lookups</span>
      </div>
      <ol className="vlog-list">
        {rows.slice(0, 120).map(({ s, st, t, chat }) => (
          <li key={s.id} className={`vrow ${st}`} title={`${chat.id} · ${stamp(t)}${s.note ? `\n${s.note}` : ''}`}>
            <span className="ts">{hms(t)}</span>
            <span className="tn" style={{ color: TENANT[chat.tenantId].color }}>
              {chat.tenantId}
            </span>
            <span className="g">{st === 'verifying' ? spinner(now) : GLYPH[st]}</span>
            <span className="ref">{s.ref}</span>
            {s.note && st !== 'pulling' && st !== 'verifying' && <span className="note">{s.note}</span>}
          </li>
        ))}
      </ol>
    </aside>
  )
}
