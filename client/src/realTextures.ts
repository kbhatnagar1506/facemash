import * as THREE from 'three'

// Photographed PBR materials from Poly Haven (CC0), in /public/textures.
// The game keeps its own palette, so the colour photos are used as *detail*: their
// brightness becomes a neutral multiplier around ~0.9, and their normal and
// roughness maps give real surface relief and sheen.

const loader = new THREE.TextureLoader()
const cache = new Map<string, THREE.Texture>()

function repeatWrap(t: THREE.Texture, rx: number, ry: number) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(rx, ry)
  t.anisotropy = 8
  return t
}

/** A normal or roughness map (linear data), tiled rx × ry times over the surface's UVs. */
export function dataMap(name: string, rx = 1, ry = rx) {
  const key = `${name}|${rx}|${ry}`
  let t = cache.get(key)
  if (!t) {
    t = repeatWrap(loader.load(`/textures/${name}.jpg`), rx, ry)
    t.colorSpace = THREE.NoColorSpace
    cache.set(key, t)
  }
  return t
}

/**
 * Greyscale detail from a colour photo: luminance normalised so its mean sits at
 * `mean`, with contrast `amount`. Starts flat and fills in once the photo loads.
 */
export function detailMap(name: string, rx = 1, ry = rx, amount = 0.35, mean = 0.9) {
  const key = `detail|${name}|${rx}|${ry}|${amount}|${mean}`
  const hit = cache.get(key)
  if (hit) return hit
  // full size from the start: WebGL2 textures are immutable once uploaded
  const S = 512
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const v = Math.round(mean * 255)
  g.fillStyle = `rgb(${v},${v},${v})`
  g.fillRect(0, 0, S, S)
  const t = repeatWrap(new THREE.CanvasTexture(c), rx, ry)
  t.colorSpace = THREE.NoColorSpace
  cache.set(key, t)
  const img = new Image()
  img.onload = () => {
    g.drawImage(img, 0, 0, S, S)
    const d = g.getImageData(0, 0, S, S)
    let sum = 0
    const lum = new Float32Array(S * S)
    for (let i = 0; i < S * S; i++) {
      const l = 0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2]
      lum[i] = l
      sum += l
    }
    const m = sum / (S * S) || 1
    for (let i = 0; i < S * S; i++) {
      const o = Math.max(0, Math.min(1, mean + amount * (lum[i] - m) / m)) * 255
      d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = o
      d.data[i * 4 + 3] = 255
    }
    g.putImageData(d, 0, 0)
    t.needsUpdate = true
  }
  img.src = `/textures/${name}.jpg`
  return t
}
