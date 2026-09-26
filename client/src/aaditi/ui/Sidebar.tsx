import type { CSSProperties } from 'react'
import { AGENTS, TENANTS, USER } from '../data'
import type { Chat } from '../store'
import { chatState } from './ChatPane'
import { ago } from './time'

type Props = { scope: string; chats: Chat[]; now: number; open: string[]; focus: string | undefined; onOpen: (id: string) => void }

export function Sidebar({ scope, chats, now, open, focus, onOpen }: Props) {
  const tenants = TENANTS.filter((t) => scope === 'all' || t.id === scope)
  return (
    <nav className="side" aria-label="Agents and sessions">
      {tenants.map((t) => {
        const tChats = chats.filter((c) => c.tenantId === t.id)
        return (
          <div className="tenant-block" key={t.id} style={{ '--tenant': t.color } as CSSProperties}>
            <div className="tenant-title">
              <span className="tag">{t.id}</span> {t.name}
            </div>
            <div className="tenant-meta">
              {t.region} · {t.plan} · rls tenant_id={t.id}
            </div>

            <div className="side-h">agents</div>
            {AGENTS.filter((a) => a.tenantId === t.id).map((a) => {
              const mine = tChats.filter((c) => c.agentId === a.id)
              const busy = mine.some((c) => chatState(c, now) === 'typing')
              const paused = mine.length > 0 && mine.every((c) => c.paused)
              return (
                <div className="agent-row" key={a.id} title={a.role}>
                  <span className={`dot ${paused ? 'paused' : busy ? 'busy' : 'live'}`}>●</span>
                  <span className="aname">{a.name}</span>
                  <span className="dim model">{a.model.replace('claude-', '')}</span>
                  <span className="dim count">{mine.length}</span>
                </div>
              )
            })}

            <div className="side-h">sessions</div>
            {tChats.map((c) => {
              const st = chatState(c, now)
              const last = c.messages.at(-1)
              const isOpen = open.includes(c.id)
              return (
                <button
                  key={c.id}
                  className={`session${isOpen ? ' open' : ''}${focus === c.id ? ' focused' : ''}`}
                  onClick={() => onOpen(c.id)}
                >
                  <span className="dim">{c.id}</span>
                  <span className="sname">
                    {c.agentId.split('.')[1]} ⇄ {USER[c.userId].name.split(' ')[0]}
                  </span>
                  <span className={`state ${st}`}>{st === 'typing' ? '…' : '●'}</span>
                  <span className="dim when">{last ? ago(last.at, now) : ''}</span>
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
