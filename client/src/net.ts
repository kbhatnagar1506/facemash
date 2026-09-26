// WebSocket client for the Go server. Remote player positions live in a
// mutable map (read every frame by three.js); roster and chat changes are
// pushed to React through subscribe().

export type Room = 'campus' | 'hackgt'

export interface NetPlayer {
  id: number
  name: string
  color: string
  x: number
  z: number
  y?: number
  r: number
  m: boolean
}

export interface ChatLine {
  key: number
  id: number
  name: string
  text: string
  at: number
}

type Listener = () => void

export class Net {
  players = new Map<number, NetPlayer>()
  chat: ChatLine[] = []
  bubbles = new Map<number, { text: string; at: number }>()
  myId = 0
  connected = false
  room: Room = 'campus'
  /** Set when the server rejects a move; the local player snaps back here. */
  correction: { x: number; z: number } | null = null

  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private hello: { name: string; color: string; x: number; z: number; room: Room }
  private lastSent = ''
  private chatKey = 0
  private closed = false

  constructor(name: string, color: string, x: number, z: number) {
    this.hello = { name, color, x, z, room: 'campus' }
    this.open()
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', ...this.hello }))
    }
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data))
    ws.onclose = () => {
      this.connected = false
      this.players.clear()
      this.emit()
      if (!this.closed) setTimeout(() => this.open(), 1500)
    }
  }

  private onMessage(msg: any) {
    switch (msg.t) {
      case 'welcome':
      case 'room':
        if (msg.t === 'welcome') this.myId = msg.id
        this.connected = true
        this.room = msg.room
        this.players.clear()
        for (const p of msg.players) this.players.set(p.id, p)
        this.lastSent = ''
        this.emit()
        break
      case 'join':
        this.players.set(msg.p.id, msg.p)
        this.addChat(0, '', `${msg.p.name} ${this.room === 'hackgt' ? 'entered HackGT' : 'arrived on campus'}!`)
        break
      case 'leave': {
        const p = this.players.get(msg.id)
        this.players.delete(msg.id)
        if (p) this.addChat(0, '', `${p.name} left.`)
        break
      }
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
      case 'correct':
        this.correction = { x: msg.x, z: msg.z }
        break
    }
  }

  private addChat(id: number, name: string, text: string) {
    this.chat = [...this.chat.slice(-30), { key: this.chatKey++, id, name, text, at: Date.now() }]
    this.emit()
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

  private emit() {
    for (const fn of this.listeners) fn()
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}
