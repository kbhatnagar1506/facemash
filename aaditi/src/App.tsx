import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { CHATS, TENANT, TENANTS } from './data'
import { srcStatus, store, useChats, type Chat } from './store'
import { ChatPane } from './ui/ChatPane'
import { Sidebar } from './ui/Sidebar'
import { VerifyLog } from './ui/VerifyLog'
import { stamp, useNow } from './ui/time'
import './terminal.css'

const SCOPES = [...TENANTS.map((t) => t.id), 'all']
const MAX_PANES = 6
const inScope = (scope: string, tenantId: string) => scope === 'all' || scope === tenantId

function defaultPanes(scope: string) {
  if (scope === 'all') return TENANTS.flatMap((t) => CHATS.filter((c) => c.tenantId === t.id).slice(0, 2)).map((c) => c.id)
  return CHATS.filter((c) => c.tenantId === scope).map((c) => c.id)
}

const HELP =
  '/tenant <acme|globex|initech|all>  /open <chat>  /close  /pause  /resume  /list  ·  plain text = operator note to the focused chat  ·  Tab cycles panes'

export default function App() {
  const chats = useChats()
  const now = useNow(80)
  const [scope, setScope] = useState('acme')
  const [panes, setPanes] = useState(() => Object.fromEntries(SCOPES.map((s) => [s, defaultPanes(s)])))
  const [focus, setFocus] = useState(() => Object.fromEntries(SCOPES.map((s) => [s, defaultPanes(s)[0]])))
  const [out, setOut] = useState('type /help for commands · Alt+1..3 switch tenant · Alt+0 all tenants')
  const [drawer, setDrawer] = useState(false)

  const scoped = chats.filter((c) => inScope(scope, c.tenantId))
  const open = panes[scope].map((id) => chats.find((c) => c.id === id)).filter((c): c is Chat => !!c)
  const focusId = focus[scope]
  const focused = open.find((c) => c.id === focusId)

  const switchScope = (s: string) => {
    setScope(s)
    setDrawer(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return
      const i = e.key === '0' ? SCOPES.length - 1 : Number(e.key) - 1
      if (i >= 0 && i < SCOPES.length) {
        e.preventDefault()
        switchScope(SCOPES[i])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setFocusId = (id: string) => setFocus((f) => ({ ...f, [scope]: id }))

  const openChat = (id: string): string => {
    const c = chats.find((x) => x.id === id)
    if (!c) return `no such chat: ${id}`
    // tenant isolation: a scoped console can't reach another tenant's sessions
    if (!inScope(scope, c.tenantId)) return `denied: ${id} belongs to tenant ${c.tenantId}, console is scoped to ${scope}`
    setPanes((p) => {
      const cur = p[scope]
      if (cur.includes(id)) return p
      return { ...p, [scope]: [...cur, id].slice(-MAX_PANES) }
    })
    setFocusId(id)
    setDrawer(false)
    return `opened ${id}`
  }

  const closeChat = (id: string) => {
    const cur = panes[scope]
    const i = cur.indexOf(id)
    const next = cur.filter((x) => x !== id)
    setPanes((p) => ({ ...p, [scope]: next }))
    if (focusId === id) setFocusId(next[Math.min(i, next.length - 1)])
  }

  const cycle = (dir: number) => {
    if (!open.length) return
    const i = open.findIndex((c) => c.id === focusId)
    setFocusId(open[(i + dir + open.length) % open.length].id)
  }

  const run = (line: string): string => {
    const [cmd, arg] = line.trim().split(/\s+/)
    if (!line.startsWith('/')) {
      if (!focused) return 'no chat focused · /open <chat> first'
      store.send(focused.id, line.trim())
      return `note sent to ${focused.id} (${focused.tenantId})`
    }
    switch (cmd) {
      case '/help':
        return HELP
      case '/tenant':
        if (!arg || !SCOPES.includes(arg)) return `usage: /tenant <${SCOPES.join('|')}>`
        switchScope(arg)
        return `scope → ${arg}`
      case '/open':
        return arg ? openChat(arg) : 'usage: /open <chat>'
      case '/close':
        if (!focused) return 'no chat focused'
        closeChat(focused.id)
        return `closed ${focused.id}`
      case '/pause':
      case '/resume':
        if (!focused) return 'no chat focused'
        store.setPaused(focused.id, cmd === '/pause')
        return `${focused.id} ${cmd === '/pause' ? 'paused' : 'resumed'}`
      case '/list':
        return TENANTS.filter((t) => inScope(scope, t.id))
          .map((t) => `${t.id}: ${chats.filter((c) => c.tenantId === t.id).map((c) => c.id).join(' ')}`)
          .join('  ·  ')
      default:
        return `unknown command ${cmd} · /help`
    }
  }

  let verified = 0
  let flagged = 0
  let unverified = 0
  let inflight = 0
  for (const c of scoped)
    for (const m of c.messages)
      for (const s of m.sources) {
        const st = srcStatus(s, now)
        if (st === 'verified') verified++
        else if (st === 'mismatch') flagged++
        else if (st === 'unverified') unverified++
        else if (st) inflight++
      }
  const live = scoped.filter((c) => !c.paused).length

  return (
    <div className="app">
      <header className="top">
        <button className="menu" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer} aria-label="Sessions">
          ☰
        </button>
        <span className="brand">▌agentd</span>
        <div className="tabs" role="tablist" aria-label="Tenant scope">
          {SCOPES.map((s, i) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              className={`tab${scope === s ? ' on' : ''}`}
              style={{ '--tenant': TENANT[s]?.color ?? '#e5e5e5' } as CSSProperties}
              onClick={() => switchScope(s)}
            >
              <span className="k">{s === 'all' ? 0 : i + 1}</span> {s === 'all' ? '* all' : s}
            </button>
          ))}
        </div>
        <div className="stats">
          <span>
            <b>{live}</b> live
          </span>
          <span className="ok">✓ {verified}</span>
          <span className="flag">✗ {flagged}</span>
          <span className="unk">? {unverified}</span>
          <span className="busy">⟳ {inflight}</span>
        </div>
        <time className="clock" title={stamp(now)}>
          {new Date(now).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' })}
        </time>
      </header>

      <div className={`body${drawer ? ' drawer' : ''}`}>
        <Sidebar scope={scope} chats={scoped} now={now} open={panes[scope]} focus={focusId} onOpen={(id) => setOut(openChat(id))} />
        <main className={`panes n-${Math.max(1, open.length)}`}>
          {open.length === 0 && <div className="empty">no panes open · pick a session or /open &lt;chat&gt;</div>}
          {open.map((c) => (
            <ChatPane key={c.id} chat={c} now={now} focused={c.id === focusId} onFocus={() => setFocusId(c.id)} onClose={() => closeChat(c.id)} />
          ))}
        </main>
        <VerifyLog chats={scoped} now={now} />
      </div>

      <Prompt scope={scope} focused={focused} out={out} onRun={(l) => setOut(run(l))} onCycle={cycle} />
    </div>
  )
}

type PromptProps = { scope: string; focused: Chat | undefined; out: string; onRun: (line: string) => void; onCycle: (dir: number) => void }

function Prompt({ scope, focused, out, onRun, onCycle }: PromptProps) {
  const [value, setValue] = useState('')
  const history = useRef<string[]>([])
  const pos = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  return (
    <footer className="prompt">
      <div className="out">{out}</div>
      <label className="line">
        <span className="ps1">
          ops@<span style={{ color: TENANT[scope]?.color }}>{scope}</span>
          <span className="dim">:{focused?.id ?? '-'}</span>$
        </span>
        <input
          ref={input}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label="Command"
          placeholder={focused ? `note to ${focused.id}, or /help` : '/help'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault()
              onCycle(e.shiftKey ? -1 : 1)
            } else if (e.key === 'Enter' && value.trim()) {
              history.current.push(value)
              pos.current = history.current.length
              onRun(value)
              setValue('')
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const h = history.current
              pos.current = Math.max(0, Math.min(h.length, pos.current + (e.key === 'ArrowUp' ? -1 : 1)))
              setValue(h[pos.current] ?? '')
            } else if (e.key === 'Escape') setValue('')
          }}
        />
      </label>
    </footer>
  )
}
