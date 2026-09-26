import * as THREE from 'three'

// Canvas textures for the landing scene. None of them contain words: the scene
// speaks in shapes, the page carries the text. (The one number, the app's 87%, is
// the number the copy quotes.)

const INK = '#1B1D24'

function tex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

let blob: THREE.Texture | null = null
/** Soft contact shadow shared by every bean. */
export function blobTexture() {
  if (blob) return blob
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, 'rgba(58,47,34,1)')
  r.addColorStop(0.45, 'rgba(58,47,34,0.55)')
  r.addColorStop(1, 'rgba(58,47,34,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 64, 64)
  blob = tex(c)
  return blob
}

let face: THREE.Texture | null = null
/** The strangers' visor: white, with two dot eyes, mapped onto a unit SphereGeometry
 *  (u = 0.25 faces +z) scaled to the crowd visor, so the eyes sit at x = ±0.13. */
export function visorFace() {
  if (face) return face
  const W = 512
  const H = 128
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#15161C'
  for (const s of [-1, 1]) {
    g.beginPath()
    g.ellipse(W * (0.25 + s * 0.048), H * 0.47, 8, 11, 0, 0, Math.PI * 2)
    g.fill()
  }
  face = tex(c)
  return face
}

/** A white tag with a tail, holding one vector glyph. 2x canvas; 1 px = 1/300 world unit at 1x. */
function tag(draw: (g: CanvasRenderingContext2D, cx: number, cy: number) => void) {
  const W = 300
  const H = 250
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const bw = 170
  const bh = 150
  const x = (W - bw) / 2
  const y = 24
  g.save()
  g.shadowColor = 'rgba(27,29,36,0.16)'
  g.shadowBlur = 26
  g.shadowOffsetY = 8
  g.fillStyle = '#ffffff'
  g.beginPath()
  g.roundRect(x, y, bw, bh, 44)
  g.moveTo(W / 2 - 18, y + bh - 1)
  g.lineTo(W / 2, y + bh + 22)
  g.lineTo(W / 2 + 18, y + bh - 1)
  g.closePath()
  g.fill()
  g.restore()
  draw(g, W / 2, y + bh / 2)
  const t = tex(c)
  return { map: t, aspect: W / H, tail: (H - (y + bh + 22)) / H }
}

/** A small bug, drawn with strokes: body, head, six legs, two antennae. */
export function bugTag() {
  return tag((g, cx, cy) => {
    const red = '#E5484D'
    g.save()
    g.translate(cx, cy + 4)
    g.strokeStyle = red
    g.lineCap = 'round'
    g.lineWidth = 7
    for (const s of [-1, 1]) {
      g.beginPath()
      g.moveTo(s * 18, -8)
      g.lineTo(s * 36, -20)
      g.moveTo(s * 20, 6)
      g.lineTo(s * 40, 6)
      g.moveTo(s * 18, 20)
      g.lineTo(s * 34, 34)
      g.moveTo(s * 7, -30)
      g.quadraticCurveTo(s * 12, -46, s * 22, -50)
      g.stroke()
    }
    g.fillStyle = red
    g.beginPath()
    g.ellipse(0, 8, 21, 27, 0, 0, Math.PI * 2)
    g.fill()
    g.beginPath()
    g.arc(0, -22, 13, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = '#ffffff'
    g.lineWidth = 4
    g.beginPath()
    g.moveTo(0, -6)
    g.lineTo(0, 32)
    g.stroke()
    g.restore()
  })
}

/** A green disc with a check. */
export function checkTag() {
  return tag((g, cx, cy) => {
    g.fillStyle = '#30A46C'
    g.beginPath()
    g.arc(cx, cy, 44, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = '#ffffff'
    g.lineWidth = 11
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.beginPath()
    g.moveTo(cx - 20, cy + 1)
    g.lineTo(cx - 5, cy + 16)
    g.lineTo(cx + 21, cy - 14)
    g.stroke()
  })
}

/** The networking app's notification: an app icon, two unread lines, and the match dial
 *  reading 87%. Redrawn once the display face has loaded, so the number is never set in
 *  a fallback font. */
export function matchCard() {
  const W = 640
  const H = 220
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const FONT = '"Bricolage Grotesque", Inter, ui-sans-serif, system-ui, sans-serif'
  const draw = () => {
    g.clearRect(0, 0, W, H)
    const x = 20
    const y = 20
    const w = W - 40
    const h = H - 40
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.roundRect(x, y, w, h, 40)
    g.fill()
    g.strokeStyle = 'rgba(27,29,36,0.08)'
    g.lineWidth = 3
    g.stroke()
    // app icon
    g.fillStyle = '#E4DED3'
    g.beginPath()
    g.roundRect(x + 34, y + 38, 104, 104, 28)
    g.fill()
    g.fillStyle = '#CFC7B9'
    g.beginPath()
    g.arc(x + 86, y + 78, 17, 0, Math.PI * 2)
    g.fill()
    g.beginPath()
    g.ellipse(x + 86, y + 124, 30, 18, 0, Math.PI, 0)
    g.fill()
    // two unread lines
    g.fillStyle = '#E7E2D9'
    g.beginPath()
    g.roundRect(x + 168, y + 58, 190, 22, 11)
    g.fill()
    g.fillStyle = '#EFEBE4'
    g.beginPath()
    g.roundRect(x + 168, y + 100, 132, 22, 11)
    g.fill()
    // the dial: track, 87% arc, the number
    const dx = x + w - 100
    const dy = y + h / 2
    const r = 60
    g.lineWidth = 12
    g.lineCap = 'round'
    g.strokeStyle = '#ECE7DF'
    g.beginPath()
    g.arc(dx, dy, r, 0, Math.PI * 2)
    g.stroke()
    g.strokeStyle = INK
    g.beginPath()
    g.arc(dx, dy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * 0.87)
    g.stroke()
    let size = 44
    g.font = `700 ${size}px ${FONT}`
    const fit = 2 * (r - 6) - 20
    const tw = g.measureText('87%').width
    if (tw > fit) {
      size = Math.floor((size * fit) / tw)
      g.font = `700 ${size}px ${FONT}`
    }
    g.fillStyle = INK
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('87%', dx, dy + 2)
  }
  draw()
  const map = tex(c)
  document.fonts
    ?.load(`700 44px ${FONT}`)
    .then(() => {
      draw()
      map.needsUpdate = true
    })
    .catch(() => {})
  return { map, aspect: W / H }
}
