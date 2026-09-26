import * as THREE from 'three'

// Surface detail for every lit material in the atrium, applied in world space
// (triplanar), so a 40 m slab and a 0.4 m chair get the same real-scale grain.

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
}

/** Tileable multi-octave value noise, greyscale around 0.5. */
function grainTexture() {
  const S = 256
  const r = rng(77)
  const layer = (cells: number) => {
    const g = Array.from({ length: cells * cells }, () => r())
    return (x: number, y: number) => {
      const fx = (x / S) * cells
      const fy = (y / S) * cells
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      const at = (i: number, j: number) => g[((j + cells) % cells) * cells + ((i + cells) % cells)]
      const sx = tx * tx * (3 - 2 * tx)
      const sy = ty * ty * (3 - 2 * ty)
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
      return a + (b - a) * sy
    }
  }
  const octaves = [layer(8), layer(32), layer(128)]
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(S, S)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const v = 0.25 * octaves[0](x, y) + 0.35 * octaves[1](x, y) + 0.4 * octaves[2](x, y)
      const i = (y * S + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255)
      img.data[i + 3] = 255
    }
  ctx.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/** Terrazzo chips: small angular stones of mixed colours on a transparent tile. */
function chipTexture() {
  const S = 512
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const r = rng(13)
  const colors = ['#2f3033', '#4a4b4f', '#6b6c70', '#8a7a66', '#f6f4ef', '#d9d6cf', '#5d6b62', '#a38f78']
  for (let i = 0; i < 5200; i++) {
    const x = r() * S
    const y = r() * S
    const s = 1.2 + Math.pow(r(), 3) * 7
    g.fillStyle = colors[Math.floor(r() * colors.length)]
    g.beginPath()
    const n = 4 + Math.floor(r() * 3)
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r() * 0.6
      const rr = s * (0.6 + r() * 0.5)
      if (k === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
      else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
    }
    g.closePath()
    g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

let grain: THREE.Texture | null = null
let chips: THREE.Texture | null = null

const WORLD_VERT = `
  vec4 dWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    dWorld = instanceMatrix * dWorld;
  #endif
  dWorld = modelMatrix * dWorld;
  vDW = dWorld.xyz;
  vDN = normalize(mat3(modelMatrix) * objectNormal);
`

/** Fine grain + soft mottling on any lit material. `strength` ~0.06–0.14. */
export function addDetail(mat: THREE.Material, strength = 0.09, scale = 0.6) {
  if (mat.userData.detail) return
  mat.userData.detail = true
  grain ??= grainTexture()
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer)
    shader.uniforms.uGrain = { value: grain }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDW;\nvarying vec3 vDN;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VERT}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uGrain;\nvarying vec3 vDW;\nvarying vec3 vDN;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    vec3 bw = abs(normalize(vDN)); bw /= (bw.x + bw.y + bw.z);
    float s = ${scale.toFixed(3)};
    float fine = texture2D(uGrain, vDW.yz / s).r * bw.x + texture2D(uGrain, vDW.xz / s).r * bw.y + texture2D(uGrain, vDW.xy / s).r * bw.z;
    float broad = texture2D(uGrain, vDW.yz / (s * 9.0)).r * bw.x + texture2D(uGrain, vDW.xz / (s * 9.0)).r * bw.y + texture2D(uGrain, vDW.xy / (s * 9.0)).r * bw.z;
    diffuseColor.rgb *= 1.0 + (fine - 0.5) * ${(strength * 2).toFixed(3)} + (broad - 0.5) * ${strength.toFixed(3)};
  }`,
      )
  }
  const key = mat.customProgramCacheKey?.() ?? ''
  mat.customProgramCacheKey = () => `${key}|detail${strength}_${scale}`
  mat.needsUpdate = true
}

/** Polished terrazzo: fine stone chips over the floor's colour bands. */
export function addTerrazzo(mat: THREE.Material) {
  if (mat.userData.terrazzo) return
  mat.userData.terrazzo = true
  chips ??= chipTexture()
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uChips = { value: chips }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDW;\nvarying vec3 vDN;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VERT}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uChips;\nvarying vec3 vDW;\nvarying vec3 vDN;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    vec4 ch = texture2D(uChips, vDW.xz / 1.3);
    vec4 ch2 = texture2D(uChips, vDW.xz / 0.55 + 0.37);
    float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    // chips read darker on the light bands and lighter on the dark bands
    vec3 c1 = mix(ch.rgb * 0.85, ch.rgb * 1.2 + 0.05, step(lum, 0.35));
    diffuseColor.rgb = mix(diffuseColor.rgb, c1, ch.a * 0.75);
    diffuseColor.rgb = mix(diffuseColor.rgb, ch2.rgb, ch2.a * 0.35);
  }`,
      )
  }
  mat.customProgramCacheKey = () => 'terrazzo'
  mat.needsUpdate = true
}

/** Walk a subtree and give every lit, opaque material surface detail. */
export function detailEverything(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (!m || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) return
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (mat.userData.terrazzo || mat.userData.detail) continue
      const lit =
        (mat as THREE.MeshLambertMaterial).isMeshLambertMaterial ||
        (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
        (mat as THREE.MeshToonMaterial).isMeshToonMaterial
      if (!lit || mat.transparent) continue
      // fabric (drapes) gets a stronger, finer weave; big architecture a softer grain
      const fabric = mat.side === THREE.DoubleSide
      addDetail(mat, fabric ? 0.14 : 0.09, fabric ? 0.25 : 0.7)
    }
  })
}
