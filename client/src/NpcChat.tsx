import { useCallback, useEffect, useRef, useState } from 'react'
import type { Net } from './net'
import type { PlayerInfo } from './Player'

// Walk right up to an AI attendee and it stops, turns to you and says hi (server/npc_chat.go).
// Its hello pops up here, Pokémon style, and you can talk back without leaving the game; it
// answers from its own memory. The same chat is on /chats. Walk away (or Esc) to close it.

export interface NpcChatOpen {
  talk: string
  pid: number
  name: string
}

type Msg = { id: number; from: 'you' | 'them' | 'agents' | 'your_agent' | 'their_agent'; text: string }

const AWAY_M = 7 // walk this far from them and the chat closes

export function useNpcChat() {
  const [chat, setChat] = useState<NpcChatOpen | null>(null)
  useEffect(() => {
    const on = (e: Event) => setChat((e as CustomEvent<NpcChatOpen>).detail)
    addEventListener('gt-npc', on)
    return () => removeEventListener('gt-npc', on)
  }, [])
  const close = useCallback(() => setChat(null), [])
  return [chat, close] as const
}

export function NpcChat({ chat, net, info, onClose }: { chat: NpcChatOpen; net: Net; info: React.MutableRefObject<PlayerInfo>; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [waiting, setWaiting] = useState(false)
  const last = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // the thread, polled while it's open
  useEffect(() => {
    let dead = false
    last.current = 0
    setMsgs([])
    const load = () =>
      fetch(`/api/connections/${encodeURIComponent(chat.talk)}/messages?after=${last.current}`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { messages: Msg[] } | null) => {
          if (dead || !j?.messages.length) return
          last.current = j.messages[j.messages.length - 1].id
          setMsgs((m) => [...m, ...j.messages.filter((x) => !m.some((y) => y.id === x.id))])
          if (j.messages.some((x) => x.from === 'them')) setWaiting(false)
        })
        .catch(() => {})
    void load()
    const t = setInterval(load, 2000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [chat.talk])

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [msgs.length, waiting])

  // walk away and it closes; Esc closes; Enter jumps into the reply box
  useEffect(() => {
    const t = setInterval(() => {
      const p = net.players.get(chat.pid)
      if (p && Math.hypot(p.x - info.current.x, p.z - info.current.z) > AWAY_M) onClose()
    }, 500)
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter' && document.activeElement !== input.current) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    addEventListener('keydown', k)
    return () => {
      clearInterval(t)
      removeEventListener('keydown', k)
    }
  }, [chat.pid, net, info, onClose])

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    setText('')
    const r = await fetch(`/api/connections/${encodeURIComponent(chat.talk)}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t }),
    }).catch(() => null)
    if (!r?.ok) return setText(t)
    const m = (await r.json()) as Msg
    last.current = Math.max(last.current, m.id)
    setMsgs((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]))
    setWaiting(true)
    input.current?.blur() // back to walking
  }

  return (
    <div className="npc-chat" role="dialog" aria-label={`Chat with ${chat.name}`}>
      <div className="npc-chat-head">
        <b>{chat.name}</b>
        <button type="button" className="npc-chat-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="npc-chat-msgs" ref={list} aria-live="polite">
        {msgs.length === 0 && <p className="npc-line them">…</p>}
        {msgs.map((m) => (
          <p key={m.id} className={`npc-line ${m.from === 'you' ? 'you' : m.from === 'them' ? 'them' : 'agents'}`}>
            {m.text}
          </p>
        ))}
        {waiting && <p className="npc-line them typing">…</p>}
      </div>
      <form className="npc-chat-form" onSubmit={send}>
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} maxLength={600} placeholder={`Say something to ${chat.name}`} aria-label="Message" />
        <button type="submit" disabled={!text.trim()}>
          ▶
        </button>
      </form>
    </div>
  )
}
