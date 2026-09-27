import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Collider, pointInPoly, type Campus, type Pt } from './map'
import { cutawayUniforms } from './cutaway'
import { byTile, finishInstances, hash2, PointGrid, roadClearance, useToonRamp } from './campusKit'

// The Pokémon-overworld dressing for the outdoor campus: chunky layered trees, patches of
// wild tall grass that sway and rustle as you wade through, bobbing flower beds, and
// shimmering water. Everything is instanced per streaming tile, placed deterministically
// from positions, and animated in the vertex shader off two shared uniforms (time and how
// fast the player is moving), so hundreds of tufts cost a handful of draw calls and no
// per-frame CPU work.

/** Streaming for the dressing: trees in 120 m cells out to ~230 m, small stuff in 60 m cells out to ~130 m. */
export const TREE_CELL = 120
export const TREE_RADIUS = 230
export const SMALL_CELL = 60
export const SMALL_RADIUS = 130

/** Shared animation uniforms (uPlayer comes from cutawayUniforms, which Player.tsx writes). */
export const wind = { uTime: { value: 0 }, uMove: { value: 0 } }

/** Ticks the wind clock and measures how fast the local player is moving (for rustling). */
export function WindClock({ active }: { active: boolean }) {
  const last = useRef<THREE.Vector3 | null>(null)
  useFrame(({ clock }, dt) => {
    wind.uTime.value = clock.elapsedTime
    if (!active) return
    const p = cutawayUniforms.uPlayer.value
    let target = 0
    if (last.current && dt > 0) {
      const v = Math.hypot(p.x - last.current.x, p.z - last.current.z) / dt
      target = v > 60 ? 0 : Math.min(1, v / 5) // a teleport isn't a walk
      last.current.copy(p)
    } else last.current = p.clone()
    const k = Math.min(1, dt * (target > wind.uMove.value ? 10 : 3))
    wind.uMove.value += (target - wind.uMove.value) * k
  })
  return null
}

interface SwayOpts {
  key: string
  /** metres of sway at height `href` */
  amp: number
  freq: number
  href: number
  exp: number
  /** how much neighbours differ in phase (0 = everyone in step, like the games' flower beds) */
  phase: number
  /** shoved aside and shaken when the player walks through */
  rustle: boolean
  /** screen-door see-through when it stands between the (north-up) camera and the player */
  fade?: boolean
}
const f = (n: number) => n.toFixed(4)

/**
 * Vertex-shader wind for instanced foliage: the whole instance bends from its base
 * (more the higher up the vertex is), a slow gust wave rolls across the map, and, for
 * grass and flowers, things right around the walking player get pushed aside and shake.
 */
function withSway<T extends THREE.Material>(mat: T, o: SwayOpts): T {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = wind.uTime
    sh.uniforms.uMove = wind.uMove
    sh.uniforms.uPlayer = cutawayUniforms.uPlayer
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uMove;\nuniform vec3 uPlayer;\nvarying float vFade;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
#ifdef USE_INSTANCING
  mat4 iM = instanceMatrix;
#else
  mat4 iM = mat4(1.0);
#endif
  vec3 org = (modelMatrix * iM * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float s2 = dot(iM[0].xyz, iM[0].xyz);
  float hgt = max(position.y, 0.0) * sqrt(s2);
  float w = pow(hgt / ${f(o.href)}, ${f(o.exp)});
  float ph = (org.x * 0.73 + org.z * 0.41) * ${f(o.phase)};
  float gust = 0.65 + 0.35 * sin(uTime * 0.6 + org.x * 0.025 - org.z * 0.018);
  vec3 d = vec3(sin(uTime * ${f(o.freq)} + ph), 0.0, 0.45 * cos(uTime * ${f(o.freq * 0.77)} + ph * 1.3)) * ${f(o.amp)} * gust * w;
  ${
    o.rustle
      ? `vec2 aw = org.xz - uPlayer.xz;
  float dist = length(aw);
  float k = (1.0 - smoothstep(0.4, 1.8, dist)) * uMove;
  d.xz += (aw / max(dist, 0.001)) * k * 0.28 * w;
  d.xz += vec2(sin(uTime * 31.0 + ph * 9.0), cos(uTime * 27.0 + ph * 7.0)) * k * 0.12 * w;
  d.y -= k * 0.1 * w;`
      : ''
  }
  transformed += (transpose(mat3(iM)) * d) / s2;
  // in front of the player as the overworld camera sees it: a little south, roughly in line
  vec2 rel = org.xz - uPlayer.xz;
  vFade = ${o.fade ? '(1.0 - smoothstep(2.2, 3.6, abs(rel.x))) * smoothstep(-1.0, 0.5, rel.y) * (1.0 - smoothstep(7.0, 10.0, rel.y))' : '0.0'};
}`,
      )
    if (o.fade) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
  if (vFade > 0.05) {
    // screen-door: drop a checkerboard of pixels (more of them the more it's in the way)
    vec2 q = mod(floor(gl_FragCoord.xy), 2.0);
    float cell = q.x == q.y ? q.x : 2.0 + q.x; // the two diagonal cells rank first
    if (cell < vFade * 1.99) discard; // at most half: a see-through checkerboard
  }`,
        )
    }
  }
  mat.customProgramCacheKey = () => `sway-${o.key}`
  return mat
}

/* ------------------------------------------------------------------ placement */

// Areas that aren't open lawn: nothing wild grows on a car park, pitch or pond.
const NOT_LAWN = new Set(['parking', 'pitch', 'track', 'water', 'sand', 'stadium', 'sports_centre', 'fitness_centre'])
const FLOWER_AREAS = new Set(['park', 'garden', 'grass', 'recreation_ground', 'meadow', 'grassland'])
const FLOWER_COLORS = ['#f2475e', '#ffd23c', '#fff5ee', '#f2475e', '#ffd23c', '#ff8fc0']

type Boxed = { pts: Pt[]; box: [number, number, number, number] }
/** Areas bucketed into 50 m cells by bounding box, for quick point-in-area tests. */
function areaGrid(areas: Boxed[]) {
  const m = new Map<number, Boxed[]>()
  for (const a of areas)
    for (let gx = Math.floor(a.box[0] / 50); gx <= Math.floor(a.box[2] / 50); gx++)
      for (let gz = Math.floor(a.box[1] / 50); gz <= Math.floor(a.box[3] / 50); gz++) {
        const k = (gx + 32768) * 65536 + gz + 32768
        const l = m.get(k)
        if (l) l.push(a)
        else m.set(k, [a])
      }
  return m
}
function inAreas(grid: Map<number, Boxed[]>, x: number, z: number) {
  for (const a of grid.get((Math.floor(x / 50) + 32768) * 65536 + Math.floor(z / 50) + 32768) ?? []) {
    const [x0, z0, x1, z1] = a.box
    if (x < x0 || x > x1 || z < z0 || z > z1) continue
    if (pointInPoly(x, z, a.pts)) return true
  }
  return false
}
const boxed = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0])
  const zs = pts.map((p) => p[1])
  return { pts, box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] as [number, number, number, number] }
}

export interface Placements {
  /** [x, z, kind 0 = round / 1 = pine] */
  trees: [number, number, number][]
  /** [x, z, rotation, scale] */
  tufts: [number, number, number, number][]
  /** [x, z, rotation, scale, color index] */
  flowers: [number, number, number, number, number][]
}

/**
 * Everything the overworld scatters, computed once per campus: street trees (the OSM
 * trees plus a row along the footpaths), flower beds along path edges and in the parks,
 * and tall-grass patches in the open lawns away from paths, buildings and trees.
 */
export function usePlacements(campus: Campus): Placements {
  // built just after the first frame, so the campus shows up first and the dressing follows
  const [out, setOut] = useState<Placements>(EMPTY)
  useEffect(() => {
    const t = setTimeout(() => setOut(computePlacements(campus)), 30)
    return () => clearTimeout(t)
  }, [campus])
  return out
}
const EMPTY: Placements = { trees: [], tufts: [], flowers: [] }

function computePlacements(campus: Campus): Placements {
  {
    const t0 = performance.now()
    const coll = new Collider(campus)
    const clear = roadClearance(campus)
    const shells = campus.event?.entrances ?? []
    const nearShell = (x: number, z: number, d: number) => {
      for (const [ex, ez] of shells) if ((x - ex) ** 2 + (z - ez) ** 2 < d * d) return true
      return false
    }
    const notLawn = areaGrid(campus.areas.filter((a) => NOT_LAWN.has(a.kind)).map((a) => boxed(a.pts)))
    const [sx, sz] = campus.spawn

    // trees
    const treeGrid = new PointGrid(8)
    const pts: [number, number][] = campus.trees.map(([x, z]) => [x, z])
    pts.forEach(([x, z]) => treeGrid.add(x, z))
    for (const r of campus.roads) {
      if (!r.foot) continue
      let side = 1
      for (let i = 1; i < r.pts.length; i++) {
        const [ax, az] = r.pts[i - 1]
        const [bx, bz] = r.pts[i]
        const L = Math.hypot(bx - ax, bz - az)
        const nx = -(bz - az) / L
        const nz = (bx - ax) / L
        for (let t = 8; t < L; t += 16) {
          const off = r.w / 2 + 2.6
          const x = ax + ((bx - ax) * t) / L + nx * off * side
          const z = az + ((bz - az) * t) / L + nz * off * side
          side = -side
          if (coll.blocked(x, z, 2.5) || !clear(x, z, 1.8)) continue
          if (nearShell(x, z, 9) || treeGrid.near(x, z, 6)) continue
          pts.push([x, z])
          treeGrid.add(x, z)
        }
      }
    }
    const trees = pts.map(([x, z]) => [x, z, hash2(x, z, 7) < 0.3 ? 1 : 0] as [number, number, number])

    // flower beds: little clusters along the footpath edges, and scattered through the parks
    const flowers: Placements['flowers'] = []
    const flowerGrid = new PointGrid(6)
    const bed = (cx: number, cz: number, n: number, spread: number, salt: number) => {
      const color = Math.floor(hash2(cx, cz, salt) * FLOWER_COLORS.length)
      let placed = 0
      for (let i = 0; i < n; i++) {
        const a = i * 2.39996 + hash2(cx, cz, salt + 1) * 6.28
        const rr = spread * Math.sqrt((i + 0.5) / n)
        const x = cx + Math.cos(a) * rr
        const z = cz + Math.sin(a) * rr
        if (nearShell(x, z, 6) || treeGrid.near(x, z, 1.1) || !clear(x, z, 0.3) || inAreas(notLawn, x, z) || coll.blocked(x, z, 0.9)) continue
        flowers.push([x, z, hash2(x, z, 3) * 6.28, 1.6 + hash2(x, z, 4) * 0.45, color])
        placed++
      }
      if (placed) flowerGrid.add(cx, cz)
    }
    for (const r of campus.roads) {
      if (!r.foot) continue
      for (let i = 1; i < r.pts.length; i++) {
        const [ax, az] = r.pts[i - 1]
        const [bx, bz] = r.pts[i]
        const L = Math.hypot(bx - ax, bz - az)
        if (L < 4) continue
        const nx = -(bz - az) / L
        const nz = (bx - ax) / L
        for (let t = 3; t < L - 1; t += 9) {
          const px = ax + ((bx - ax) * t) / L
          const pz = az + ((bz - az) * t) / L
          const h = hash2(px, pz, 5)
          if (h > 0.22) continue
          const side = hash2(px, pz, 6) < 0.5 ? 1 : -1
          const off = r.w / 2 + 1.1
          const cx = px + nx * off * side
          const cz = pz + nz * off * side
          if (flowerGrid.near(cx, cz, 5)) continue
          bed(cx, cz, 4 + Math.floor(h * 12), 0.8, 11)
        }
      }
    }
    for (const a of campus.areas) {
      if (!FLOWER_AREAS.has(a.kind)) continue
      const { box } = boxed(a.pts)
      for (let x = Math.ceil(box[0] / 9) * 9; x < box[2]; x += 9)
        for (let z = Math.ceil(box[1] / 9) * 9; z < box[3]; z += 9) {
          const cx = x + (hash2(x, z, 21) - 0.5) * 6
          const cz = z + (hash2(x, z, 22) - 0.5) * 6
          if (hash2(x, z, 23) > 0.12 || !pointInPoly(cx, cz, a.pts) || flowerGrid.near(cx, cz, 6)) continue
          bed(cx, cz, 5 + Math.floor(hash2(x, z, 24) * 5), 1.2, 31)
        }
    }

    // tall grass: rounded patches on a jittered 22 m grid, wherever there's open lawn
    const tufts: Placements['tufts'] = []
    const [bx0, bz0, bx1, bz1] = campus.bounds
    // cheapest tests first
    // (`roomy`: the whole patch is already known to be clear of roads and buildings)
    const open = (x: number, z: number, roomy = false) =>
      (x - sx) ** 2 + (z - sz) ** 2 > 64 &&
      !nearShell(x, z, 10) &&
      !treeGrid.near(x, z, 2.2) &&
      !flowerGrid.near(x, z, 2.2) &&
      (roomy || clear(x, z, 1.4)) &&
      !inAreas(notLawn, x, z) &&
      (roomy || !coll.blocked(x, z, 2.2))
    const G = 22
    for (let gx = Math.floor(bx0 / G) * G; gx < bx1; gx += G)
      for (let gz = Math.floor(bz0 / G) * G; gz < bz1; gz += G) {
        if (hash2(gx, gz, 41) > 0.36) continue
        // a few tries per cell, so squeezed campus lawns still get their patch
        let cx = 0
        let cz = 0
        let ok = false
        for (let k = 0; k < 4 && !ok; k++) {
          cx = gx + G * (0.15 + 0.7 * hash2(gx, gz, 42 + k * 7))
          cz = gz + G * (0.15 + 0.7 * hash2(gx, gz, 43 + k * 7))
          ok = open(cx, cz)
        }
        if (!ok) continue
        const hw = 1.6 + 2.0 * hash2(gx, gz, 44)
        const hd = 1.4 + 1.6 * hash2(gx, gz, 45)
        const R = Math.max(hw, hd) + 0.3
        const roomy = clear(cx, cz, 1.4 + R) && !coll.blocked(cx, cz, 2.2 + R)
        const start = tufts.length
        const S = 0.8
        for (let u = -hw; u <= hw; u += S)
          for (let v = -hd; v <= hd; v += S) {
            if ((Math.abs(u) / hw) ** 4 + (Math.abs(v) / hd) ** 4 > 1) continue
            const x = cx + u + (hash2(u + cx, v + cz, 46) - 0.5) * 0.25
            const z = cz + v + (hash2(u + cx, v + cz, 47) - 0.5) * 0.25
            if (!open(x, z, roomy)) continue
            tufts.push([x, z, hash2(x, z, 48) * 6.28, 0.9 + hash2(x, z, 49) * 0.3])
          }
        if (tufts.length - start < 5) tufts.length = start // too small to read as a patch
      }
    const out = { trees, tufts, flowers }
    if (location.search.includes('perf')) {
      console.log(`overworld placements: ${trees.length} trees, ${flowers.length} flowers, ${tufts.length} tufts in ${(performance.now() - t0).toFixed(0)} ms`)
      Object.assign(window, { __overworld: out })
    }
    return out
  }
}

/* ------------------------------------------------------------------ geometry */

function colorize(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, ny: number) => THREE.Color) {
  const p = g.getAttribute('position')
  const n = g.getAttribute('normal')
  const cols = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) fn(p.getX(i), p.getY(i), p.getZ(i), n.getY(i)).toArray(cols, i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3))
  return g
}
const plain = (g: THREE.BufferGeometry) => {
  const out = g.index ? g.toNonIndexed() : g
  out.deleteAttribute('uv')
  return out
}

/** A clump of pointed blades fanning out from the base, dark at the root, bright at the tips. */
function tuftGeometry() {
  const N = 6
  const pos: number[] = []
  const col: number[] = []
  const root = new THREE.Color('#2c7f34')
  const mid = new THREE.Color('#4cb944')
  const tip = new THREE.Color('#9ae866')
  const c = new THREE.Color()
  const v = new THREE.Vector3()
  const push = (x: number, y: number, z: number, a: number, h: number) => {
    v.set(x, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), a)
    pos.push(v.x, v.y, v.z)
    const k = y / h
    c.copy(root).lerp(mid, Math.min(1, k * 2)).lerp(tip, Math.max(0, k * 2 - 1))
    col.push(c.r, c.g, c.b)
  }
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + ((i * 7) % 3) * 0.35
    const h = 0.7 + ((i * 37) % 5) * 0.06
    const bw = 0.3
    const lean = 0.5
    const r0 = 0.08
    const quad: [number, number, number][] = [
      [-bw / 2, 0, r0],
      [bw / 2, 0, r0],
      [bw * 0.38, h * 0.55, r0 + lean * h * 0.4],
      [-bw * 0.38, h * 0.55, r0 + lean * h * 0.4],
      [0, h, r0 + lean * h],
    ]
    for (const t of [[0, 1, 2], [0, 2, 3], [3, 2, 4]]) for (const j of t) push(...quad[j], a, h)
  }
  // a dark underlay so a patch reads as one dense block of wild grass
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2
    const a1 = ((i + 1) / 6) * Math.PI * 2
    for (const [x, z] of [[0, 0], [Math.cos(a0) * 0.5, Math.sin(a0) * 0.5], [Math.cos(a1) * 0.5, Math.sin(a1) * 0.5]]) {
      pos.push(x, 0.02, z)
      col.push(0.2, 0.52, 0.22)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  // lit as if facing the sky: the toon ramp then shades a patch as one bright mass
  const nrm = new Float32Array(pos.length)
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.computeBoundingSphere()
  return g
}

/** Flat, upward-facing disc from a polar outline r(θ) (a fan around the centre). */
function disc(r: (a: number) => number, n: number, y: number) {
  const pos: number[] = []
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    pos.push(0, y, 0, Math.cos(a1) * r(a1), y, Math.sin(a1) * r(a1), Math.cos(a0) * r(a0), y, Math.sin(a0) * r(a0))
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

/**
 * One flower, sprite-like the way the games draw them: a flat five-petal head facing the
 * sky (tinted per instance) and, separately, an orange eye, a stem and two leaves.
 */
function flowerGeometry() {
  const petal = (a: number) => 0.13 * (0.55 + 0.45 * Math.abs(Math.cos(a * 2.5)))
  const head = colorize(disc(petal, 20, 0.36), (x, _y, z) => {
    const k = 0.78 + 0.22 * Math.min(1, Math.hypot(x, z) / 0.09) // a little darker toward the eye
    return new THREE.Color(k, k, k)
  })
  const eye = disc(() => 0.042, 8, 0.365)
  const stem = new THREE.CylinderGeometry(0.018, 0.024, 0.36, 4, 1, true)
  stem.translate(0, 0.18, 0)
  const leaf = (s: number) => disc((a) => 0.09 * Math.abs(Math.cos(a)) + 0.012, 8, 0.0).scale(1, 1, 0.45).translate(s * 0.08, 0.12, 0)
  const body = mergeGeometries([
    colorize(eye, () => new THREE.Color('#ff9f1c')),
    colorize(plain(stem), () => new THREE.Color('#3f9f3a')),
    colorize(leaf(1), () => new THREE.Color('#5cc24b')),
    colorize(leaf(-1), () => new THREE.Color('#5cc24b')),
  ])!
  return { head, body }
}

/** Round Let's-Go tree: a short trunk and three stacked puffs, darker toward each underside. */
function roundTree() {
  const trunk = new THREE.CylinderGeometry(0.32, 0.42, 2.0, 6, 1, true)
  trunk.translate(0, 1.0, 0)
  const tiers: [number, number, number][] = [
    [1.9, 2.9, 0.78],
    [1.45, 3.95, 0.8],
    [0.95, 4.8, 0.85],
  ]
  const parts = tiers.map(([r, y, sy], i) => {
    const s = new THREE.SphereGeometry(r, 10, 6)
    s.scale(1, sy, 1)
    s.translate(0, y, 0)
    const lift = 1 + i * 0.07
    return colorize(plain(s), (_x, _y, _z, ny) => {
      const k = ny < -0.35 ? 0.62 : ny < 0.1 ? 0.86 : 1.0
      return new THREE.Color(k * lift, k * lift, k * lift)
    })
  })
  return { trunk: plain(trunk), crown: mergeGeometries(parts)! }
}

/** Layered DPPt-style pine: three stacked cones, each rim shaded darker than its peak. */
function pineTree() {
  const trunk = new THREE.CylinderGeometry(0.28, 0.38, 1.6, 6, 1, true)
  trunk.translate(0, 0.8, 0)
  const tiers: [number, number, number][] = [
    [2.0, 2.3, 2.4],
    [1.55, 2.1, 3.7],
    [1.05, 1.9, 4.9],
  ]
  const parts = tiers.map(([r, h, y], i) => {
    const cone = new THREE.ConeGeometry(r, h, 9, 1, true)
    cone.translate(0, y, 0)
    const lift = 1 + i * 0.06
    return colorize(plain(cone), (_x, py, _z, ny) => {
      const t = THREE.MathUtils.clamp((py - (y - h / 2)) / h, 0, 1)
      const k = ny < -0.5 ? 0.5 : 0.66 + 0.4 * Math.min(1, t * 1.6)
      return new THREE.Color(k * lift, k * lift, k * lift)
    })
  })
  return { trunk: plain(trunk), crown: mergeGeometries(parts)! }
}

const TREE_GREENS = ['#46b04a', '#3ea54a', '#5cc04c', '#35994a', '#52b85a']
const PINE_GREENS = ['#2f9a56', '#2a8c50', '#38a65a']

/* ------------------------------------------------------------------ components */

export function PokeTrees({ trees, near }: { trees: Placements['trees']; near: Set<string> }) {
  const ramp = useToonRamp()
  const kit = useMemo(() => {
    const sway = { amp: 0.12, freq: 1.2, href: 5, exp: 2, phase: 0.35, rustle: false, fade: true }
    return {
      geo: [roundTree(), pineTree()],
      bark: withSway(new THREE.MeshToonMaterial({ color: '#94603a', gradientMap: ramp }), { ...sway, key: 'bark' }),
      leaf: withSway(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp }), { ...sway, key: 'leaf' }),
    }
  }, [ramp])
  const tiles = useMemo(() => byTile(trees, (p) => [p[0], p[1]], TREE_CELL), [trees])
  const place = (mesh: THREE.InstancedMesh | null, crown: boolean, pts: [number, number, number][]) => {
    if (!mesh) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const c = new THREE.Color()
    const up = new THREE.Vector3(0, 1, 0)
    pts.forEach(([x, z, kind], i) => {
      const k = hash2(x, z)
      const s = 0.85 + k * 0.45
      q.setFromAxisAngle(up, k * 6.28)
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * (0.95 + hash2(x, z, 2) * 0.15), s))
      mesh.setMatrixAt(i, m)
      if (crown) {
        const pal = kind ? PINE_GREENS : TREE_GREENS
        mesh.setColorAt(i, c.set(pal[Math.floor(hash2(x, z, 3) * pal.length)]))
      }
    })
    finishInstances(mesh)
  }
  return (
    <group>
      {[...tiles]
        .filter(([k]) => near.has(k))
        .map(([k, pts]) => (
          <group key={k}>
            {[0, 1].map((kind) => {
              const mine = pts.filter((p) => p[2] === kind)
              if (!mine.length) return null
              return (
                <group key={kind}>
                  <instancedMesh ref={(m) => place(m, false, mine)} args={[kit.geo[kind].trunk, kit.bark, mine.length]} castShadow />
                  <instancedMesh ref={(m) => place(m, true, mine)} args={[kit.geo[kind].crown, kit.leaf, mine.length]} castShadow />
                </group>
              )
            })}
          </group>
        ))}
    </group>
  )
}

export function TallGrass({ tufts, near }: { tufts: Placements['tufts']; near: Set<string> }) {
  const ramp = useToonRamp()
  const kit = useMemo(
    () => ({
      geo: tuftGeometry(),
      mat: withSway(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, side: THREE.DoubleSide }), {
        key: 'tallgrass',
        amp: 0.12,
        freq: 2.2,
        href: 0.9,
        exp: 1.6,
        phase: 1,
        rustle: true,
      }),
    }),
    [ramp],
  )
  const tiles = useMemo(() => byTile(tufts, (p) => [p[0], p[1]], SMALL_CELL), [tufts])
  return (
    <group>
      {[...tiles]
        .filter(([k]) => near.has(k))
        .map(([k, pts]) => (
          <instancedMesh
            key={k}
            args={[kit.geo, kit.mat, pts.length]}
            receiveShadow
            ref={(mesh) => {
              if (!mesh) return
              const m = new THREE.Matrix4()
              const q = new THREE.Quaternion()
              const up = new THREE.Vector3(0, 1, 0)
              pts.forEach(([x, z, r, s], i) => mesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(up, r), new THREE.Vector3(s, s, s))))
              finishInstances(mesh)
            }}
          />
        ))}
    </group>
  )
}

export function Flowers({ flowers, near }: { flowers: Placements['flowers']; near: Set<string> }) {
  const ramp = useToonRamp()
  const kit = useMemo(() => {
    const sway = { amp: 0.07, freq: 3.4, href: 0.4, exp: 1.5, phase: 0.06, rustle: true }
    return {
      ...flowerGeometry(),
      petal: withSway(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, side: THREE.DoubleSide }), { ...sway, key: 'petal' }),
      stem: withSway(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, side: THREE.DoubleSide }), { ...sway, key: 'fbody' }),
    }
  }, [ramp])
  const tiles = useMemo(() => byTile(flowers, (p) => [p[0], p[1]], SMALL_CELL), [flowers])
  const place = (mesh: THREE.InstancedMesh | null, pts: Placements['flowers'], tint: boolean) => {
    if (!mesh) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const c = new THREE.Color()
    const up = new THREE.Vector3(0, 1, 0)
    pts.forEach(([x, z, r, s, ci], i) => {
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(up, r), new THREE.Vector3(s, s, s)))
      if (tint) mesh.setColorAt(i, c.set(FLOWER_COLORS[ci]))
    })
    finishInstances(mesh)
  }
  return (
    <group>
      {[...tiles]
        .filter(([k]) => near.has(k))
        .map(([k, pts]) => (
          <group key={k}>
            <instancedMesh ref={(m) => place(m, pts, true)} args={[kit.head, kit.petal, pts.length]} />
            <instancedMesh ref={(m) => place(m, pts, false)} args={[kit.body, kit.stem, pts.length]} />
          </group>
        ))}
    </group>
  )
}

/** Butterfly wings: two rounded fans either side of the body line, facing +z. */
function wingGeometry() {
  const pos: number[] = []
  const col: number[] = []
  for (const side of [-1, 1]) {
    const rim: [number, number][] = [
      [0, 0.1],
      [0.14, 0.15],
      [0.2, 0.04],
      [0.12, -0.03],
      [0.15, -0.11],
      [0.05, -0.12],
      [0, -0.06],
    ]
    for (let i = 0; i < rim.length - 1; i++)
      for (const [x, z, k] of [
        [0, 0, 1],
        [rim[i][0], rim[i][1], 0.8],
        [rim[i + 1][0], rim[i + 1][1], 0.8],
      ]) {
        pos.push(x * side, 0, z)
        col.push(k, k, k)
      }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos.map((v) => v * 1.7), 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  return g
}

/**
 * Butterflies over some of the flower beds: wings flap and each one wanders a lazy
 * figure-eight around its bed, all in the vertex shader (one draw per tile, no CPU work).
 */
export function Butterflies({ flowers, near }: { flowers: Placements['flowers']; near: Set<string> }) {
  const kit = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = wind.uTime
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
#ifdef USE_INSTANCING
  vec3 org = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#else
  vec3 org = vec3(0.0);
#endif
  float ph = fract(sin(dot(org.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
  // flap: fold both wings up about the body line
  float fl = 0.15 + 1.1 * (0.5 + 0.5 * sin(uTime * 15.0 + ph));
  float wx = transformed.x;
  transformed.x = wx * cos(fl);
  transformed.y += abs(wx) * sin(fl);
  // wander: a figure-eight around the bed, bobbing with each wingbeat
  float t = uTime * 0.55 + ph;
  vec3 off = vec3(sin(t) * 1.7, 0.3 * sin(t * 2.3 + ph) + 0.12 * sin(uTime * 15.0 + ph + 1.5), sin(t * 2.0) * 1.0);
  vec2 vel = vec2(cos(t) * 1.7, 2.0 * cos(t * 2.0));
  float yaw = atan(vel.x, vel.y);
  float c = cos(yaw);
  float s = sin(yaw);
  transformed = vec3(c * transformed.x + s * transformed.z, transformed.y, -s * transformed.x + c * transformed.z) + off;
}`,
      )
    }
    mat.customProgramCacheKey = () => 'poke-butterfly'
    return { geo: wingGeometry(), mat }
  }, [])
  const tiles = useMemo(() => {
    const spots = flowers.filter(([x, z]) => hash2(x, z, 77) < 0.035)
    return byTile(spots, (p) => [p[0], p[1]], SMALL_CELL)
  }, [flowers])
  return (
    <group>
      {[...tiles]
        .filter(([k]) => near.has(k))
        .map(([k, pts]) => (
          <instancedMesh
            key={k}
            args={[kit.geo, kit.mat, pts.length]}
            frustumCulled={false}
            ref={(mesh) => {
              if (!mesh) return
              const m = new THREE.Matrix4()
              const c = new THREE.Color()
              pts.forEach(([x, z], i) => {
                mesh.setMatrixAt(i, m.makeTranslation(x, 0.9 + hash2(x, z, 78) * 0.6, z))
                mesh.setColorAt(i, c.set(BUTTERFLY_COLORS[Math.floor(hash2(x, z, 79) * BUTTERFLY_COLORS.length)]))
              })
              finishInstances(mesh)
            }}
          />
        ))}
    </group>
  )
}
const BUTTERFLY_COLORS = ['#ffffff', '#fff3a6', '#ffd0e6', '#bfe4ff']

/** Pokémon water: flat blue with drifting white wave lines and twinkling glints. */
export function waterMaterial() {
  const mat = new THREE.MeshLambertMaterial({ color: '#4fb6f2' })
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = wind.uTime
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(position, 1.0)).xz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vWP;')
      .replace(
        '#include <opaque_fragment>',
        `{
  vec2 p = vWP;
  float t = uTime;
  // rows of short wavy highlights drifting across the surface
  float row = p.y * 0.55 + sin(p.x * 0.45 + t * 1.3) * 0.5;
  float line = smoothstep(0.86, 0.97, sin(row * 3.14159 - t * 1.1));
  float dash = smoothstep(0.1, 0.6, sin(p.x * 0.9 + floor(row) * 1.7 + t * 0.8));
  // glints: a few cells light up briefly, out of step with each other
  vec2 cell = floor(p * 0.9);
  float h = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  vec2 fp = fract(p * 0.9) - 0.5;
  float glint = step(0.93, h) * smoothstep(0.18, 0.0, length(fp)) * max(0.0, sin(t * 2.5 + h * 40.0));
  outgoingLight = mix(outgoingLight, vec3(1.0), clamp(line * dash * 0.6 + glint, 0.0, 1.0));
  // a touch deeper in the troughs
  outgoingLight *= 0.94 + 0.06 * sin(p.x * 0.3 + p.y * 0.2 + t * 0.5);
}
#include <opaque_fragment>`,
      )
  }
  mat.customProgramCacheKey = () => 'poke-water'
  return mat
}

/**
 * Footpath material: sandy dirt whose edges crumble into the grass (a noisy discard
 * along the ribbon's edge, read from the `aEdge` attribute: 0 on the centre line,
 * ±1 at the edges).
 */
export function pathMaterial(map: THREE.Texture, color: string, crumble: number, key: string) {
  const mat = new THREE.MeshLambertMaterial({ map, color, polygonOffset: true })
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEdge;\nvarying float vEdge;\nvarying vec2 vPW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge;\nvPW = (modelMatrix * vec4(position, 1.0)).xz;')
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vEdge;
varying vec2 vPW;
float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), f.x), mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
  {
    float n = pNoise(vPW * 1.1) * 0.65 + pNoise(vPW * 3.1) * 0.35;
    if (abs(vEdge) > 1.0 - ${f(crumble)} * n) discard;
  }`,
      )
  }
  mat.customProgramCacheKey = () => `poke-path-${key}`
  return mat
}
