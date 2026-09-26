import * as THREE from 'three'
import { HALL, X0, Z0 } from './layout'

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
  c.width = HALL.w * PX
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
  // Base: speckled light grey.
  rect(X0, Z0, HALL.w / 2, HALL.d / 2, '#cfccc6')
  // Cream fields on both sides.
  rect(X0, Z0, -7, HALL.d / 2, '#e9e5dc')
  rect(10, Z0, HALL.w / 2, HALL.d / 2, '#e9e5dc')
  // Dark charcoal runner from the doors into the atrium (entrance photo).
  // Dark on the left half of the doors, curving out into the atrium (door photo).
  poly([[-4.6, 28], [0.4, 28], [2.4, 21], [8.6, 14], [8.6, -1.5], [1.2, -1.5], [1.2, 12], [-2.4, 19]], '#55575b')
  // Blue-grey band sweeping towards the photo booth.
  poly([[-3.4, -1.5], [6.8, -1.5], [7.8, -19], [-1.8, -19]], '#8d99a4')
  // Cream arc by the stair foot.
  g.fillStyle = '#e9e5dc'
  g.beginPath()
  g.ellipse(m(-11), n(19), 9 * PX, 6 * PX, 0, 0, Math.PI * 2)
  g.fill()
  // Speckle every field with chips of its neighbours' colours.
  const r = rng(7)
  const img = g.getImageData(0, 0, c.width, c.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const k = r()
    const lum = d[i] + d[i + 1] + d[i + 2]
    if (k < 0.07) {
      const v = lum > 500 ? -40 - r() * 50 : 60 + r() * 60 // dark chips on light, light chips on dark
      d[i] += v
      d[i + 1] += v
      d[i + 2] += v
    } else if (k < 0.2) {
      const v = (r() - 0.5) * 16
      d[i] += v
      d[i + 1] += v
      d[i + 2] += v
    }
  }
  g.putImageData(img, 0, 0)
  // Thin brown divider strips.
  g.fillStyle = '#8b7a64'
  for (const z of [18.2, -1.5]) g.fillRect(0, n(z) - 4, c.width, 8)
  g.fillRect(m(-7) - 4, 0, 8, n(18.2))
  g.fillRect(m(10) - 4, 0, 8, c.height)
  return tex(c)
}

/**
 * The far wall: a checkerboard of beige/taupe/grey/sage panels with a grid of
 * recessed windows, a few lit from offices inside.
 */
export function checkerWall(cols: number, rows: number, windowCols: number[], seed = 3) {
  const P = 96
  const c = document.createElement('canvas')
  c.width = cols * P
  c.height = rows * P
  const g = c.getContext('2d')!
  const shades = ['#c9c3b6', '#9d978a', '#dcd8cf', '#aeb0a2', '#bdb6a6', '#8a877d', '#c5cabd', '#e3e0d8']
  const r = rng(seed)
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      g.fillStyle = shades[Math.floor(r() * shades.length)]
      g.fillRect(i * P, j * P, P, P)
      g.strokeStyle = 'rgba(60,55,45,.25)'
      g.lineWidth = 2
      g.strokeRect(i * P + 1, j * P + 1, P - 2, P - 2)
    }
  for (const i of windowCols)
    for (let j = 0; j < rows - 1; j++) {
      const lit = r() < 0.18
      const x = i * P + P * 0.18
      const y = j * P + P * 0.22
      g.fillStyle = '#7d7a72'
      g.fillRect(x - 5, y - 5, P * 0.64 + 10, P * 0.62 + 10)
      g.fillStyle = lit ? '#f6ecc4' : '#2e3439'
      g.fillRect(x, y, P * 0.64, P * 0.62)
      g.fillStyle = 'rgba(255,255,255,.18)'
      g.fillRect(x, y, P * 0.64, 4)
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
