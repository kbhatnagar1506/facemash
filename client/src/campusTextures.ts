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

/** Grass: tufts, clover patches and blade strokes on a green base. */
export function grassTexture() {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#8fd06f'
  g.fillRect(0, 0, S, S)
  const r = rng(3)
  // soft light/dark patches (wrap around so the tile is seamless)
  for (let i = 0; i < 40; i++) {
    const x = r() * S
    const y = r() * S
    const rad = 14 + r() * 30
    const col = r() < 0.5 ? 'rgba(120,190,90,.35)' : 'rgba(170,225,120,.35)'
    for (const dx of [-S, 0, S])
      for (const dy of [-S, 0, S]) {
        const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad)
        grd.addColorStop(0, col)
        grd.addColorStop(1, 'rgba(0,0,0,0)')
        g.fillStyle = grd
        g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2)
      }
  }
  // blades
  for (let i = 0; i < 2600; i++) {
    const x = r() * S
    const y = r() * S
    const l = 2 + r() * 4
    const a = -Math.PI / 2 + (r() - 0.5) * 0.9
    g.strokeStyle = r() < 0.5 ? 'rgba(92,160,70,.55)' : 'rgba(190,235,140,.5)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l)
    g.stroke()
  }
  // a few tiny flowers
  for (let i = 0; i < 18; i++) {
    g.fillStyle = ['#fff7d6', '#ffe36e', '#f6c1d6'][i % 3]
    g.beginPath()
    g.arc(r() * S, r() * S, 1.3, 0, Math.PI * 2)
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
    const base = 140 + (r() - 0.5) * 36
    const chip = r() < 0.04 ? 40 : 0
    img.data[i * 4] = base + chip
    img.data[i * 4 + 1] = base + 2 + chip
    img.data[i * 4 + 2] = base + 10 + chip
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  g.strokeStyle = 'rgba(60,62,70,.35)'
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
