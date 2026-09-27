// WebSocket client for the Go server. Remote player positions live in a
// mutable map (read every frame by three.js); roster and chat changes are
// pushed to React through subscribe().

import { fetchMe } from './account'

export type Room = 'campus' | 'hackgt'

// Close codes the server uses to refuse a hello (see server/main.go).
const CLOSE_SIGN_IN = 4401 // no valid ticket: fetch a fresh one (tickets last a day)
const CLOSE_TOO_MANY = 4429 // this account already has several tabs in the game
const CLOSE_FULL = 1013 // server full, try again later

export interface NetPlayer {
  id: number
  name: string
  color: string
  x: number
  z: number
  y?: number
  r: number
  m: boolean
  /** what they're doing: 0 nothing special, 1 running, 2 on a bike, 3 sitting, 4 waving */
  a?: number
  /** bean look from /avatar (see look.ts) */
  look?: string
}

export interface ChatLine {
  key: number
  id: number
  name: string
  text: string
  at: number
}

type Listener = () => void

/** Agent talk frames the server pushes to this account (see talk/talkState.ts). */
export interface TalkFrame {
  t: 'encounter' | 'agents' | 'verdict' | 'reveal' | 'closed' | 'reconnected'
  id?: string
  [k: string]: unknown
}

export class Net {
  /** Players currently in view (the server streams only nearby players: area of interest). */
  players = new Map<number, NetPlayer>()
  /** Names/colours/looks the server has introduced, kept even when someone walks out of view. */
  info = new Map<number, { name: string; color: string; look?: string }>()
  chat: ChatLine[] = []
  bubbles = new Map<number, { text: string; at: number }>()
  myId = 0
  connected = false
  room: Room = 'campus'
  /** Set when the server rejects a move; the local player snaps back here. */
  correction: { x: number; z: number } | null = null

  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private talkListeners = new Set<(f: TalkFrame) => void>()
  private everConnected = false
  private hello: { name: string; color: string; x: number; z: number; room: Room; look?: string; ticket?: string }
  private lastSent = ''
  private chatKey = 0
  private closed = false

  /** `ticket` (from /api/me) signs you in, so the server saves where you are as you play. */
  constructor(name: string, color: string, x: number, z: number, look?: string, room: Room = 'campus', ticket?: string) {
    this.hello = { name, color, x, z, room, look, ticket }
    this.room = room
    this.open()
  }

  private open() {
    // Production: the game server lives on its own host (VITE_BACKEND, e.g. Cloud Run);
    // locally it is the same host that served the page.
    const backend = import.meta.env.VITE_BACKEND as string | undefined
    const url = backend
      ? `${backend.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', ...this.hello }))
    }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => (ev.data instanceof ArrayBuffer ? this.onFrame(ev.data) : this.onMessage(JSON.parse(ev.data)))
    ws.onclose = (ev) => {
      this.connected = false
      this.players.clear()
      this.emit()
      if (this.closed) return
      if (ev.code === CLOSE_SIGN_IN) {
        // the game needs an account: pick up a fresh ticket, or go sign in
        fetchMe(true).then((me) => {
          if (this.closed) return
          if (me.ticket) {
            this.hello.ticket = me.ticket
            setTimeout(() => this.open(), 1500)
          } else if (me.googleClientId) location.replace('/?signin')
          else setTimeout(() => this.open(), 5000)
        })
        return
      }
      setTimeout(() => this.open(), ev.code === CLOSE_TOO_MANY || ev.code === CLOSE_FULL ? 5000 : 1500)
    }
  }

  /**
   * Binary position frame: 'S', count u16, then per player 13 bytes:
   * id u32 | x i16 dm | z i16 dm | r i16 crad | y i16 dm | moving u8 (little-endian).
   * The moving byte: bit 0 moving, bits 1-3 the activity (Player.a).
   */
  private onFrame(buf: ArrayBuffer) {
    const v = new DataView(buf)
    if (v.getUint8(0) !== 83 /* 'S' */) return
    const n = v.getUint16(1, true)
    const rows: number[][] = new Array(n)
    for (let i = 0, o = 3; i < n; i++, o += 13)
      rows[i] = [v.getUint32(o, true), v.getInt16(o + 4, true), v.getInt16(o + 6, true), v.getInt16(o + 8, true), v.getUint8(o + 12), v.getInt16(o + 10, true)]
    this.applyFrame(rows)
  }

  /** Nearby players this tick: [id, x dm, z dm, r crad, moving, y dm]; anyone missing walked out of range. */
  private applyFrame(rows: number[][]) {
    const seen = new Set<number>()
    let changed = false
    for (const [id, x, z, r, m, y] of rows) {
      if (id === this.myId) continue
      seen.add(id)
      const cur = this.players.get(id)
      if (cur) {
        cur.x = x / 10
        cur.z = z / 10
        cur.r = r / 100
        cur.m = (m & 1) === 1
        cur.a = (m >> 1) & 7
        cur.y = y / 10
      } else {
        const who = this.info.get(id)
        this.players.set(id, { id, name: who?.name ?? '', color: who?.color ?? '#e0564f', look: who?.look, x: x / 10, z: z / 10, r: r / 100, m: (m & 1) === 1, a: (m >> 1) & 7, y: y / 10 })
        changed = true
      }
    }
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id)) {
        this.players.delete(id)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private onMessage(msg: any) {
    switch (msg.t) {
      case 'welcome':
      case 'room':
        if (msg.t === 'welcome') {
          this.myId = msg.id
          // back after a drop: an agent talk may have moved on without us
          if (this.everConnected) this.emitTalk({ t: 'reconnected' })
          this.everConnected = true
        }
        this.connected = true
        this.room = msg.room
        this.players.clear()
        for (const p of msg.players) this.players.set(p.id, p)
        this.lastSent = ''
        this.emit()
        break
      case 'join':
        this.players.set(msg.p.id, msg.p)
        this.emit()
        break
      case 'leave': {
        if (this.players.delete(msg.id)) this.emit()
        this.info.delete(msg.id)
        break
      }
      case 'i':
        // introductions: who someone is, sent once when they first come into view
        for (const p of msg.p as { id: number; name: string; color: string; look?: string }[]) {
          this.info.set(p.id, { name: p.name, color: p.color, look: p.look })
          const cur = this.players.get(p.id)
          if (cur) Object.assign(cur, { name: p.name, color: p.color, look: p.look })
        }
        this.emit()
        break
      case 's':
        // (JSON form of the position frame; the server normally sends binary, see onFrame)
        this.applyFrame(msg.p as number[][])
        break
      case 'state':
        for (const p of msg.p as NetPlayer[]) {
          if (p.id === this.myId) continue
          const cur = this.players.get(p.id)
          if (cur) Object.assign(cur, p)
          else {
            this.players.set(p.id, p)
            this.emit()
          }
        }
        break
      case 'chat':
        this.bubbles.set(msg.id, { text: msg.text, at: performance.now() })
        this.addChat(msg.id, msg.name, msg.text)
        break
      case 'anchor': // an organizer set the reference point (Shift+R): the hall follows it now
        dispatchEvent(new CustomEvent('gt-anchor', { detail: msg }))
        break
      case 'correct':
        this.correction = { x: msg.x, z: msg.z }
        break
      case 'encounter':
      case 'agents':
      case 'verdict':
      case 'reveal':
      case 'closed':
        this.emitTalk(msg as TalkFrame)
        break
    }
  }

  private addChat(id: number, name: string, text: string) {
    this.chat = [...this.chat.slice(-30), { key: this.chatKey++, id, name, text, at: Date.now() }]
    this.emit()
  }

  /** Where this player's bean is now (hall or campus metres), as last reported by the game. */
  position(): [number, number] {
    return [this.hello.x, this.hello.z]
  }

  /** Called every frame; only sends when something changed, capped by the caller's rate. */
  move(x: number, z: number, r: number, m: boolean, y = 0) {
    // Keep the reconnect hello current so we rejoin where we were.
    this.hello.x = x
    this.hello.z = z
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return
    const msg = JSON.stringify({ t: 'move', x: +x.toFixed(2), z: +z.toFixed(2), y: +y.toFixed(2), r: +r.toFixed(2), m })
    if (msg === this.lastSent) return
    this.lastSent = msg
    this.ws.send(msg)
  }

  /** Move to another room at (x, z); the roster refreshes when the server replies. */
  enterRoom(room: Room, x: number, z: number) {
    this.hello.room = room
    this.hello.x = x
    this.hello.z = z
    this.room = room
    this.players.clear()
    this.bubbles.clear()
    this.lastSent = ''
    this.emit()
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'room', room, x, z }))
    }
  }

  say(text: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'chat', text }))
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Agent talk pushes (only ever this account's own talks). */
  onTalk(fn: (f: TalkFrame) => void) {
    this.talkListeners.add(fn)
    return () => {
      this.talkListeners.delete(fn)
    }
  }

  private emitTalk(f: TalkFrame) {
    for (const fn of this.talkListeners) fn(f)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}
