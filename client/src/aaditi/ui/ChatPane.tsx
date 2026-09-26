import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { AGENT, TENANT, USER } from '../data'
import { srcStatus, type Chat } from '../store'
import { MessageRow } from './Message'
import { spinner } from './time'

export const chatState = (c: Chat, now: number) => {
  if (c.paused) return 'paused'
  if (c.ackAt !== null || c.phase === 'agent') {
    const last = c.messages.at(-1)
    return last && now - last.at > 500 ? 'typing' : 'reading'
  }
  const last = c.messages.at(-1)
  return last && last.settledAt > now ? 'replying' : 'waiting'
}

type Props = { chat: Chat; now: number; focused: boolean; onFocus: () => void; onClose: () => void }

export function ChatPane({ chat, now, focused, onFocus, onClose }: Props) {
  const agent = AGENT[chat.agentId]
  const user = USER[chat.userId]
  const tenant = TENANT[chat.tenantId]
  const log = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const last = chat.messages.at(-1)
  const lastT = last ? Math.min(now, last.settledAt) : 0
  const state = chatState(chat, now)
  useLayoutEffect(() => {
    const el = log.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.messages.length, lastT, state])

  let checked = 0
  let verified = 0
  let flagged = 0
  let latency = 0
  let replies = 0
  for (const m of chat.messages) {
    if (m.latencyMs !== undefined && m.role === 'agent') {
      latency += m.latencyMs
      replies++
    }
    for (const s of m.sources) {
      const st = srcStatus(s, now)
      if (st === 'verified' || st === 'mismatch' || st === 'unverified') checked++
      if (st === 'verified') verified++
      if (st === 'mismatch') flagged++
    }
  }

  return (
    <section
      className={`pane${focused ? ' focused' : ''}`}
      style={{ '--tenant': tenant.color } as CSSProperties}
      onMouseDown={onFocus}
      aria-label={`${tenant.id} ${agent.name} with ${user.name}`}
    >
      <header className="pane-head">
        <span className="tag">{tenant.id}</span>
        <span className="aname">{agent.name}</span>
        <span className="dim">⇄</span>
        <span className="uname">{user.name}</span>
        <span className="dim email">&lt;{user.email}&gt;</span>
        <span className="spacer" />
        <span className="dim">{chat.id}</span>
        <span className={`state ${state}`}>
          {state === 'typing' ? spinner(now) : '●'} {state}
        </span>
        <button
          className="x"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          aria-label={`Close ${chat.id}`}
          title="close pane"
        >
          ×
        </button>
      </header>
      <div
        className="log"
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {chat.messages.map((m) => (
          <MessageRow key={m.id} m={m} t={Math.min(now, m.settledAt)} agent={agent} user={user} tenantId={chat.tenantId} />
        ))}
        {state === 'typing' && (
          <div className="msg agent pending">
            <span className="ts" />
            <span className="who">{agent.name}</span>
            <span className="text dim">{spinner(now)} thinking…</span>
          </div>
        )}
      </div>
      <footer className="pane-foot">
        <span>{agent.model}</span>
        <span>{chat.messages.filter((m) => m.role !== 'system').length} msgs</span>
        <span>
          src <b className="ok">{verified}</b>/{checked} verified
        </span>
        {flagged > 0 && <b className="flag">{flagged} flagged</b>}
        {replies > 0 && <span>avg reply {(latency / replies / 1000).toFixed(1)}s</span>}
      </footer>
    </section>
  )
}
