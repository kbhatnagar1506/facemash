import { useEffect, useRef, useState } from 'react'
import './landing.css'

// Chats with your matches: every talk you both said yes to becomes a thread. You two write;
// your agents keep it going (the icebreaker to start, updates when one of you has news, a
// nudge when you're both in the atrium). /chats lists them; /chats?c=<id> opens one.
// Nothing links here: people open /chats themselves.

type Who = 'you' | 'them' | 'agents' | 'your_agent' | 'their_agent'
type Msg = { id: number; from: Who; text: string; at: string }
type Conn = { id: string; other: { first_name: string; bean: string }; last?: Msg; at: string }

const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function Brand() {
  return (
    <header className="muse-nav">
      <a className="brand" href="/">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect x="7" y="2" width="18" height="28" rx="9" fill="#3B63C4" />
          <rect x="11.5" y="7.5" width="12" height="8" rx="4" fill="#fff" />
          <circle cx="15.5" cy="11.5" r="1.25" fill="#1B1D24" />
          <circle cx="19.5" cy="11.5" r="1.25" fill="#1B1D24" />
        </svg>
        togethr
      </a>
    </header>
  )
}

function Dot({ look }: { look: string }) {
  const body = /b=(#[0-9a-fA-F]{6})/.exec(look)?.[1] ?? '#4f7fd6'
  return (
    <span className="chat-dot" style={{ background: body }} aria-hidden="true">
      <i />
    </span>
  )
}

function List() {
  const [conns, setConns] = useState<Conn[] | null>(null)
  const [state, setState] = useState<'ok' | 'signin' | 'error'>('ok')
  useEffect(() => {
    let dead = false
    const load = () =>
      fetch('/api/connections', { credentials: 'same-origin' })
        .then(async (r) => {
          if (r.status === 401) return setState('signin')
          if (!r.ok) return setState('error')
          const j = (await r.json()) as { connections: Conn[] }
          if (!dead) setConns(j.connections)
        })
        .catch(() => setState('error'))
    void load()
    const t = setInterval(load, 10000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [])
  return (
    <section className="muse-card chat-card">
      <h1>Your chats</h1>
      {state === 'signin' && (
        <>
          <p className="muse-sub">Sign in to see your matches.</p>
          <a className="btn btn-primary muse-wide" href="/?signin">
            Sign in
          </a>
        </>
      )}
      {state === 'error' && <p className="muse-error">Couldn't load your chats. Try again in a moment.</p>}
      {state === 'ok' && conns === null && <p className="muse-sub">Loading…</p>}
      {state === 'ok' && conns?.length === 0 && (
        <p className="muse-sub">No matches yet. When your agent and someone else's both think you should meet, and you both say yes, your chat shows up here.</p>
      )}
      {!!conns?.length && (
        <ul className="chat-list">
          {conns.map((c) => (
            <li key={c.id}>
              <a href={`/chats?c=${encodeURIComponent(c.id)}`}>
                <Dot look={c.other.bean} />
                <span className="chat-list-main">
                  <b>{c.other.first_name}</b>
                  <span>{c.last ? `${c.last.from === 'you' ? 'You: ' : c.last.from === 'them' ? '' : '✦ '}${c.last.text}` : 'Say hi'}</span>
                </span>
                <small>{ago(c.at)}</small>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Thread({ id }: { id: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [other, setOther] = useState<{ first_name: string; bean: string } | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const last = useRef(0)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let dead = false
    const load = () =>
      fetch(`/api/connections/${encodeURIComponent(id)}/messages?after=${last.current}`, { credentials: 'same-origin' })
        .then(async (r) => {
          if (!r.ok) return setErr(r.status === 404 ? "This chat isn't yours, or it doesn't exist." : 'Reconnecting…')
          const j = (await r.json()) as { other: { first_name: string; bean: string }; messages: Msg[] }
          if (dead) return
          setErr('')
          setOther(j.other)
          if (j.messages.length) {
            last.current = j.messages[j.messages.length - 1].id
            setMsgs((m) => [...m, ...j.messages.filter((x) => !m.some((y) => y.id === x.id))])
          }
        })
        .catch(() => setErr('Reconnecting…'))
    void load()
    const t = setInterval(load, 3000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [id])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [msgs.length])
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    setText('')
    const r = await fetch(`/api/connections/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t }),
    }).catch(() => null)
    if (!r?.ok) {
      setText(t)
      return setErr("Couldn't send that. Try again?")
    }
    const m = (await r.json()) as Msg
    last.current = Math.max(last.current, m.id)
    setMsgs((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]))
  }
  const name = other?.first_name ?? '…'
  const label = (m: Msg) => (m.from === 'agents' ? 'Your agents' : m.from === 'your_agent' ? 'Your agent' : m.from === 'their_agent' ? `${name}'s agent` : '')
  return (
    <section className="muse-card chat-card chat-thread">
      <div className="chat-head">
        <a className="chat-back" href="/chats" aria-label="All chats">
          ←
        </a>
        {other && <Dot look={other.bean} />}
        <h1>{name}</h1>
      </div>
      <div className="chat-msgs" aria-live="polite">
        {msgs.map((m) => {
          const agent = m.from === 'agents' || m.from === 'your_agent' || m.from === 'their_agent'
          return (
            <div key={m.id} className={`chat-msg ${agent ? 'agent' : m.from}`}>
              {agent && <small>✦ {label(m)}</small>}
              <p>{m.text}</p>
            </div>
          )
        })}
        <div ref={end} />
      </div>
      {err && <p className="muse-error">{err}</p>}
      <form className="chat-compose" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={600} placeholder={`Message ${name}`} aria-label="Message" />
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </section>
  )
}

export default function Chat() {
  const id = new URLSearchParams(location.search).get('c')
  useEffect(() => {
    document.title = 'Chats · togethr'
  }, [])
  return (
    <div className="landing muse-page">
      <Brand />
      <main className="muse-main">{id ? <Thread id={id} /> : <List />}</main>
    </div>
  )
}
