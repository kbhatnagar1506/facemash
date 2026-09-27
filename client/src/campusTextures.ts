import * as THREE from 'three'

// Procedural ground textures for the campus. All are tiling and mapped in world
// space (see worldUV), so grass, roads and paths keep a consistent real scale.

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true) {
  const t = new THREE.CanvasTexture(c)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

/**
 * Grass, Pokémon-route style: bright saturated green laid out as 2 m tiles with a faint
 * checker, each tile carrying the little darker "tuft" ticks the games draw on grass.
 * One texture = 2 x 2 tiles.
 */
export function grassTexture() {
  const S = 256
  const T = S / 2
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const r = rng(3)
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? '#86da5c' : '#7fd456'
      g.fillRect(i * T, j * T, T, T)
    }
  // soft mottling so it isn't flat paint
  for (let i = 0; i < 26; i++) {
    const x = r() * S
    const y = r() * S
    const rad = 10 + r() * 22
    const col = r() < 0.5 ? 'rgba(96,190,70,.25)' : 'rgba(170,236,120,.25)'
    for (const dx of [-S, 0, S])
      for (const dy of [-S, 0, S]) {
        const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad)
        grd.addColorStop(0, col)
        grd.addColorStop(1, col.replace(/[\d.]+\)$/, '0)')) // fade to the same colour, not to black
        g.fillStyle = grd
        g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2)
      }
  }
  // the classic tuft ticks: small "v" / "w" strokes, a dark one with a light one beside it
  const tick = (x: number, y: number, s: number) => {
    g.lineWidth = 2.2
    g.lineCap = 'round'
    g.strokeStyle = 'rgba(58,150,52,.75)'
    g.beginPath()
    g.moveTo(x - s, y - s * 1.2)
    g.lineTo(x - s * 0.35, y)
    g.lineTo(x, y - s * 0.9)
    g.lineTo(x + s * 0.35, y)
    g.lineTo(x + s, y - s * 1.2)
    g.stroke()
    g.strokeStyle = 'rgba(200,245,150,.6)'
    g.lineWidth = 1.4
    g.beginPath()
    g.moveTo(x - s * 0.9, y - s * 1.35)
    g.lineTo(x - s * 0.45, y - s * 0.35)
    g.stroke()
  }
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++) {
      // a loose 3 x 3 pattern of ticks in every tile, jittered
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++) {
          if (r() < 0.35) continue
          const x = i * T + (a + 0.5) * (T / 3) + (r() - 0.5) * 18
          const y = j * T + (b + 0.6) * (T / 3) + (r() - 0.5) * 18
          tick(x, y, 4 + r() * 2.5)
        }
    }
  // faint tile seams
  g.strokeStyle = 'rgba(70,160,60,.18)'
  g.lineWidth = 2
  g.strokeRect(1, 1, T - 2, T - 2)
  g.strokeRect(T + 1, 1, T - 2, T - 2)
  g.strokeRect(1, T + 1, T - 2, T - 2)
  g.strokeRect(T + 1, T + 1, T - 2, T - 2)
  return finish(c)
}

/** Sandy dirt for footpaths: warm tan with pebbles and a few darker scuffs. */
export function dirtTexture() {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#f0d8a2'
  g.fillRect(0, 0, S, S)
  const r = rng(11)
  for (let i = 0; i < 30; i++) {
    const x = r() * S
    const y = r() * S
    const rad = 12 + r() * 26
    const col = r() < 0.5 ? 'rgba(222,190,132,.3)' : 'rgba(252,234,192,.35)'
    for (const dx of [-S, 0, S])
      for (const dy of [-S, 0, S]) {
        const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad)
        grd.addColorStop(0, col)
        grd.addColorStop(1, col.replace(/[\d.]+\)$/, '0)')) // fade to the same colour, not to black
        g.fillStyle = grd
        g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2)
      }
  }
  for (let i = 0; i < 45; i++) {
    const x = r() * S
    const y = r() * S
    const rad = 1.2 + r() * 2
    g.fillStyle = r() < 0.5 ? 'rgba(200,164,108,.55)' : 'rgba(255,246,222,.8)'
    g.beginPath()
    g.ellipse(x, y, rad, rad * 0.75, r() * 3, 0, Math.PI * 2)
    g.fill()
  }
  return finish(c)
}

/** Greyscale detail (mostly white) to multiply over coloured areas: fields, parks, lots. */
export function detailTexture() {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const img = g.createImageData(S, S)
  const r = rng(9)
  for (let i = 0; i < S * S; i++) {
    const v = 215 + r() * 40
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return finish(c, true, false)
}

/** Asphalt: fine aggregate with a few darker patches and cracks. */
export function asphaltTexture() {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const img = g.createImageData(S, S)
  const r = rng(21)
  for (let i = 0; i < S * S; i++) {
    const base = 176 + (r() - 0.5) * 16
    const chip = r() < 0.03 ? 22 : 0
    img.data[i * 4] = base + chip
    img.data[i * 4 + 1] = base + 2 + chip
    img.data[i * 4 + 2] = base + 10 + chip
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  g.strokeStyle = 'rgba(90,94,104,.15)'
  g.lineWidth = 1.2
  for (let i = 0; i < 5; i++) {
    let x = r() * S
    let y = r() * S
    g.beginPath()
    g.moveTo(x, y)
    for (let k = 0; k < 8; k++) {
      x += (r() - 0.5) * 22
      y += (r() - 0.5) * 22
      g.lineTo(x, y)
    }
    g.stroke()
  }
  return finish(c)
}

/** Warm brick pavers in a running bond, for footpaths and plazas. */
export function paverTexture() {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#cdb893'
  g.fillRect(0, 0, S, S)
  const r = rng(5)
  const bw = 32
  const bh = 16
  for (let row = 0; row < S / bh; row++)
    for (let col = -1; col < S / bw + 1; col++) {
      const x = col * bw + (row % 2) * (bw / 2)
      const y = row * bh
      const shade = 0.9 + r() * 0.18
      const base = [236 * shade, 214 * shade, 170 * shade].map((v) => Math.min(255, v | 0))
      g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`
      g.fillRect(x + 1, y + 1, bw - 2, bh - 2)
    }
  return finish(c)
}

/** Planar UVs from world x/z, `size` metres per texture tile. */
export function worldUV(geo: THREE.BufferGeometry, size: number) {
  const p = geo.getAttribute('position')
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = p.getX(i) / size
    uv[i * 2 + 1] = p.getZ(i) / size
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geo
}
