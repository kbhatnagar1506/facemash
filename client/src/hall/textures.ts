import * as THREE from 'three'
import { HALL, X0, XB, Z0 } from './layout'

// Procedural canvas textures for the Klaus atrium, matched to the on-site photos.

function tex(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
}

/**
 * Polished terrazzo: big bands of cream, speckled light grey, dark charcoal and
 * blue-grey, split by thin brown divider strips, as in the entrance/overview photos.
 */
export function terrazzo() {
  const PX = 28 // pixels per metre
  const c = document.createElement('canvas')
  c.width = (XB - X0) * PX
  c.height = HALL.d * PX
  const g = c.getContext('2d')!
  const m = (x: number) => (x - X0) * PX
  const n = (z: number) => (z - Z0) * PX
  const rect = (x0: number, z0: number, x1: number, z1: number, color: string) => {
    g.fillStyle = color
    g.fillRect(m(x0), n(z0), m(x1) - m(x0), n(z1) - n(z0))
  }
  const poly = (pts: [number, number][], color: string) => {
    g.fillStyle = color
    g.beginPath()
    pts.forEach(([x, z], i) => (i ? g.lineTo(m(x), n(z)) : g.moveTo(m(x), n(z))))
    g.closePath()
    g.fill()
  }
  // Big polished terrazzo rectangles (floor photo): rows running across the atrium,
  // each split into slabs of different widths, so seams line up one way and stagger
  // the other. Four tones (light grey, cream, mid grey, charcoal), never the same
  // tone next to itself, with thin silver divider strips at every seam.
  void poly
  const r = rng(29)
  const tones = ['#d8d7d3', '#e4ddcd', '#b1b1ae', '#76787c']
  const weights = [0.34, 0.3, 0.22, 0.14]
  const pickTone = (avoid: Set<number>) => {
    for (let tries = 0; tries < 20; tries++) {
      let v = r()
      let i = 0
      while (i < 3 && v > weights[i]) v -= weights[i++]
      if (!avoid.has(i)) return i
    }
    return [0, 1, 2, 3].find((i) => !avoid.has(i))!
  }
  const seams: [number, number, number, number][] = []
  let prevRow: { x0: number; x1: number; t: number }[] = []
  for (let z = Z0; z < Z0 + HALL.d; ) {
    const h = Math.min(4.6 + r() * 2.4, Z0 + HALL.d - z)
    const row: { x0: number; x1: number; t: number }[] = []
    for (let x = X0; x < XB; ) {
      const w = Math.min(4.2 + r() * 4.2, XB - x)
      const avoid = new Set<number>()
      if (row.length) avoid.add(row[row.length - 1].t)
      for (const p of prevRow) if (p.x1 > x && p.x0 < x + w) avoid.add(p.t)
      const t = pickTone(avoid)
      rect(x, z, x + w, z + h, tones[t])
      row.push({ x0: x, x1: x + w, t })
      if (x > X0) seams.push([x, z, x, z + h])
      x += w
    }
    if (z > Z0) seams.push([X0, z, XB, z])
    prevRow = row
    z += h
  }
  // (stone chips are added in the floor shader at real scale: see detail.ts addTerrazzo)
  for (const [x0, z0, x1, z1] of seams) {
    g.fillStyle = '#9d9b96'
    g.fillRect(m(x0) - 1.5, n(z0) - 1.5, m(x1) - m(x0) + 3, n(z1) - n(z0) + 3)
    g.fillStyle = '#eceae4'
    g.fillRect(m(x0) - 0.5, n(z0) - 0.5, m(x1) - m(x0) + 1, n(z1) - n(z0) + 1)
  }
  return tex(c)
}

/**
 * The far wall: a checkerboard of beige/taupe/grey/sage panels with a grid of
 * recessed windows, a few lit from offices inside.
 */
export function checkerWall(cols: number, rows: number, windowCols: number[], seed = 3) {
  // Klaus atrium wall, from the photos: bays split by slim pilasters; each bay is a
  // stack of square panels in beige / taupe / warm grey / sage, with frosted glass
  // panels on standoff bolts, dark window openings, and a few brightly lit windows.
  const P = 96
  const c = document.createElement('canvas')
  c.width = cols * P
  c.height = rows * P
  const g = c.getContext('2d')!
  const r = rng(seed)
  const tones = ['#d8d1c2', '#bdb4a2', '#a39b8a', '#8e8778', '#c7c6b6', '#aeb3a2', '#e4dfd4', '#958e7f']
  const win = new Set(windowCols)
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const x = i * P
      const y = j * P
      const t = tones[Math.floor(r() * tones.length)]
      g.fillStyle = t
      g.fillRect(x, y, P, P)
      // subtle vertical sheen on each panel
      const sh = g.createLinearGradient(x, 0, x + P, 0)
      sh.addColorStop(0, 'rgba(255,255,255,.06)')
      sh.addColorStop(1, 'rgba(0,0,0,.06)')
      g.fillStyle = sh
      g.fillRect(x, y, P, P)
      const roll = r()
      const top = j < 2
      if (win.has(i) && j < rows - 1 && roll < 0.55) {
        // window opening: deep dark recess with a light frame; a few are lit
        const lit = top && r() < 0.45
        g.fillStyle = '#6f6a60'
        g.fillRect(x + 12, y + 14, P - 24, P - 26)
        g.fillStyle = lit ? '#fff4d2' : '#2a2f33'
        g.fillRect(x + 16, y + 18, P - 32, P - 34)
        if (!lit) {
          g.fillStyle = 'rgba(160,190,205,.25)'
          g.fillRect(x + 16, y + 18, P - 32, 10)
        }
      } else if (roll > 0.72) {
        // frosted glass panel on four standoff bolts, casting a slight shadow
        g.fillStyle = 'rgba(0,0,0,.12)'
        g.fillRect(x + 12, y + 12, P - 20, P - 20)
        g.fillStyle = 'rgba(205,224,214,.85)'
        g.fillRect(x + 8, y + 8, P - 20, P - 20)
        g.fillStyle = 'rgba(255,255,255,.35)'
        g.fillRect(x + 8, y + 8, P - 20, 5)
        g.fillStyle = '#8f9496'
        for (const [bx, by] of [[14, 14], [P - 18, 14], [14, P - 18], [P - 18, P - 18]]) {
          g.beginPath()
          g.arc(x + bx, y + by, 3, 0, Math.PI * 2)
          g.fill()
        }
      }
      // panel joints
      g.strokeStyle = 'rgba(55,50,42,.3)'
      g.lineWidth = 2
      g.strokeRect(x + 1, y + 1, P - 2, P - 2)
    }
  // slim pilasters every two panels
  for (let i = 0; i <= cols; i += 2) {
    g.fillStyle = 'rgba(245,242,235,.9)'
    g.fillRect(i * P - 4, 0, 8, c.height)
    g.fillStyle = 'rgba(0,0,0,.12)'
    g.fillRect(i * P + 4, 0, 3, c.height)
  }
  return tex(c)
}

/** White acoustic ceiling tiles. */
export function ceilingTiles(w: number, d: number) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#f1efea'
  g.fillRect(0, 0, 128, 128)
  // acoustic tile fissures
  const rt = rng(31)
  for (let i = 0; i < 420; i++) {
    g.fillStyle = `rgba(150,145,135,${0.15 + rt() * 0.25})`
    g.fillRect(rt() * 128, rt() * 128, 1 + rt() * 2, 1)
  }
  g.strokeStyle = '#d6d2c9'
  g.lineWidth = 3
  g.strokeRect(0, 0, 128, 128)
  const t = tex(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(w / 1.2, d / 1.2)
  return t
}

/** Dark night-time window wall with white mullions and doors (the right side). */
export function windowWall(panes: number, h = 4.4) {
  const P = 120
  const c = document.createElement('canvas')
  c.width = panes * P
  c.height = Math.round((h / 3) * P)
  const g = c.getContext('2d')!
  const grd = g.createLinearGradient(0, 0, 0, c.height)
  grd.addColorStop(0, '#26303a')
  grd.addColorStop(1, '#161b21')
  g.fillStyle = grd
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#e9e7e2'
  for (let i = 0; i <= panes; i++) g.fillRect(i * P - 5, 0, 10, c.height)
  g.fillRect(0, 0, c.width, 10)
  g.fillRect(0, c.height * 0.72, c.width, 8)
  // reflections of the atrium lights
  g.fillStyle = 'rgba(255,245,210,.5)'
  const r = rng(11)
  for (let i = 0; i < panes * 2; i++) {
    g.beginPath()
    g.arc(r() * c.width, r() * c.height * 0.6, 3 + r() * 3, 0, Math.PI * 2)
    g.fill()
  }
  return tex(c)
}

/** Text on a transparent or coloured card. Returns the texture and its aspect ratio. */
export function textCard(
  lines: { text: string; font: string; color: string; weight?: string }[],
  opts: { bg?: string; w?: number; h?: number; align?: CanvasTextAlign; pad?: number } = {},
) {
  const c = document.createElement('canvas')
  const W = opts.w ?? 1024
  const H = opts.h ?? 256
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  if (opts.bg) {
    g.fillStyle = opts.bg
    g.fillRect(0, 0, W, H)
  }
  const align = opts.align ?? 'center'
  g.textAlign = align
  g.textBaseline = 'middle'
  const x = align === 'center' ? W / 2 : align === 'left' ? (opts.pad ?? 40) : W - (opts.pad ?? 40)
  const step = H / (lines.length + 1)
  lines.forEach((l, i) => {
    g.font = l.font
    g.fillStyle = l.color
    g.fillText(l.text, x, step * (i + 1))
  })
  return { map: tex(c), aspect: W / H }
}

/** Blue and white striped tablecloth. */
export function stripes(a = '#2d5fa8', b = '#f4f6fa', n = 12) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const g = c.getContext('2d')!
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 2 ? b : a
    g.fillRect((256 / n) * i, 0, 256 / n + 1, 64)
  }
  return tex(c)
}

/** Fishing net draped over the stair rail. */
export function netTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  g.strokeStyle = 'rgba(70,70,60,.85)'
  g.lineWidth = 3
  for (let i = -256; i < 512; i += 24) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 256, 256); g.stroke()
    g.beginPath(); g.moveTo(i + 256, 0); g.lineTo(i, 256); g.stroke()
  }
  const t = tex(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/** Photo-booth curtain: vertical folds in blue. */
export function curtain(base = '#2f86d6') {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 16
  const g = c.getContext('2d')!
  for (let x = 0; x < 256; x++) {
    const k = 0.82 + 0.18 * Math.sin((x / 256) * Math.PI * 14)
    const col = new THREE.Color(base).multiplyScalar(k)
    g.fillStyle = `#${col.getHexString()}`
    g.fillRect(x, 0, 1, 16)
  }
  return tex(c)
}

/**
 * The east window wall as frosted glass: white mullions and transoms, opaque
 * pale blue-green panes with diagonal reflection glints (you can't see outside).
 */
export function glassPanes(panes: number, h = 4.6) {
  const P = 128
  const c = document.createElement('canvas')
  c.width = panes * P
  c.height = Math.round((h / 3) * P)
  const g = c.getContext('2d')!
  // Frosted glass: opaque, pale blue-green, brighter toward the top like it's catching the sky.
  const frost = g.createLinearGradient(0, 0, 0, c.height)
  frost.addColorStop(0, '#dbe9ec')
  frost.addColorStop(0.55, '#c3d6da')
  frost.addColorStop(1, '#aec4c9')
  g.fillStyle = frost
  g.fillRect(0, 0, c.width, c.height)
  // fine frosting grain
  const img = g.getImageData(0, 0, c.width, c.height)
  const rr = rng(41)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (rr() - 0.5) * 10
    img.data[i] += v
    img.data[i + 1] += v
    img.data[i + 2] += v
  }
  g.putImageData(img, 0, 0)
  const r = rng(17)
  for (let i = 0; i < panes; i++) {
    // two soft diagonal glints per pane
    for (let k = 0; k < 2; k++) {
      const x = i * P + P * (0.2 + r() * 0.5)
      g.save()
      g.translate(x, c.height / 2)
      g.rotate(-0.5)
      const grd = g.createLinearGradient(-14, 0, 14, 0)
      grd.addColorStop(0, 'rgba(255,255,255,0)')
      grd.addColorStop(0.5, `rgba(255,255,255,${0.35 + r() * 0.2})`)
      grd.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grd
      g.fillRect(-14 - k * 10, -c.height, 28 - k * 14, c.height * 2)
      g.restore()
    }
  }
  g.fillStyle = '#ecebe6'
  for (let i = 0; i <= panes; i++) g.fillRect(i * P - 5, 0, 10, c.height)
  g.fillRect(0, 0, c.width, 12)
  g.fillRect(0, c.height - 12, c.width, 12)
  g.fillRect(0, c.height * 0.72, c.width, 7)
  // door hardware on every third pane (the photos show push-bar doors along the glass)
  g.fillStyle = '#b9bdc3'
  for (let i = 1; i < panes; i += 3) g.fillRect(i * P + 12, c.height * 0.5, P - 24, 5)
  return tex(c)
}

/** Laptop screen showing the Meta infinity logo (blue gradient on a light screen). */
let metaScreenTex: THREE.CanvasTexture | null = null
export function metaScreen() {
  if (metaScreenTex) return metaScreenTex
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 200
  const g = c.getContext('2d')!
  g.fillStyle = '#f2f2f2'
  g.fillRect(0, 0, 320, 200)
  const grd = g.createLinearGradient(40, 40, 280, 160)
  grd.addColorStop(0, '#2a62d8')
  grd.addColorStop(0.5, '#3a86f4')
  grd.addColorStop(1, '#2f73e6')
  g.strokeStyle = grd
  g.lineWidth = 26
  g.lineCap = 'round'
  g.lineJoin = 'round'
  // the Meta "infinity": two tall rounded loops crossing in the middle
  g.beginPath()
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * Math.PI * 2
    const x = 160 + 108 * Math.sin(t)
    const y = 104 - 58 * Math.sin(2 * t) * (1 + 0.25 * Math.cos(2 * t))
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.stroke()
  metaScreenTex = new THREE.CanvasTexture(c)
  metaScreenTex.colorSpace = THREE.SRGBColorSpace
  return metaScreenTex
}
