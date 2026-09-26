import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Html } from '@react-three/drei'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Collider, type Campus, type Pt } from './map'
import { withCutaway } from './cutaway'
import { asphaltTexture, detailTexture, grassTexture, paverTexture, worldUV } from './campusTextures'

const WALL = new THREE.Color('#f4ead2')
const WALL_EVENT = new THREE.Color('#fff4c9')

const AREA_COLOR: Record<string, string> = {
  pitch: '#6cc56b', stadium: '#6cc56b', track: '#c9674a', sports_centre: '#8fd07a',
  park: '#7fd06a', garden: '#88d470', grass: '#86cf6a', recreation_ground: '#86cf6a',
  wood: '#4fa653', forest: '#4fa653', scrub: '#6bb85a', grassland: '#8fd36f',
  meadow: '#8fd36f', water: '#5fb4ea', sand: '#ecd89a', parking: '#b8bcc4',
  fitness_centre: '#8fd07a',
}
// Draw order (lower first) so e.g. a pitch sits on top of the park around it.
const AREA_LAYER: Record<string, number> = { parking: 1, pitch: 3, track: 2, water: 4, sand: 4 }

/** Toon shading ramp: 3 hard bands give the cel-shaded Pokémon look. */
function useToonRamp() {
  return useMemo(() => {
    const tex = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat)
    tex.minFilter = tex.magFilter = THREE.NearestFilter
    tex.needsUpdate = true
    return tex
  }, [])
}

function shape(pts: Pt[]) {
  // Shapes live in the XY plane; we rotate them flat, so shape y = -world z.
  return new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)))
}

function paint(geo: THREE.BufferGeometry, fn: (ny: number) => THREE.Color) {
  const n = geo.getAttribute('normal')
  const colors = new Float32Array(n.count * 3)
  for (let i = 0; i < n.count; i++) fn(n.getY(i)).toArray(colors, i * 3)
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/**
 * Streaming campus: the map is cut into TILE-metre tiles, and only the tiles near
 * you are built and drawn (buildings, trees, lamps, benches). Far tiles don't exist
 * at all until you walk toward them, so startup is quick and the GPU only ever
 * works on the neighbourhood you're in. Each tile also has tight bounds, so the
 * ones behind the camera are skipped too.
 */
const TILE = 240
const LOAD_RADIUS = 420 // metres around you that exist
const tileKey = (x: number, z: number) => `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`
function byTile<T>(items: T[], at: (t: T) => [number, number]) {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const [x, z] = at(it)
    const k = tileKey(x, z)
    const list = m.get(k)
    if (list) list.push(it)
    else m.set(k, [it])
  }
  return m
}
/** Tile keys within LOAD_RADIUS of the player, re-checked twice a second. */
function useNearTiles(focus: React.MutableRefObject<{ x: number; z: number }>, active: boolean) {
  const calc = () => {
    const out: string[] = []
    const { x, z } = focus.current
    const r = Math.ceil(LOAD_RADIUS / TILE) + 1
    const cx = Math.floor(x / TILE)
    const cz = Math.floor(z / TILE)
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const tx = (cx + i + 0.5) * TILE
        const tz = (cz + j + 0.5) * TILE
        if (Math.hypot(tx - x, tz - z) < LOAD_RADIUS + TILE * 0.71) out.push(`${cx + i},${cz + j}`)
      }
    return out.sort().join('|')
  }
  const [keys, setKeys] = useState(calc)
  const acc = useRef(0)
  useFrame((_, dt) => {
    // frozen while you're inside Klaus: the hall uses its own coordinates, and building
    // campus tiles there would steal frames from the entrance cinematic
    if (!active) return
    acc.current += dt
    if (acc.current < 0.5) return
    acc.current = 0
    const k = calc()
    if (k !== keys) setKeys(k)
  })
  return useMemo(() => new Set(keys.split('|')), [keys])
}
function finishInstances(mesh: THREE.InstancedMesh) {
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
}

function BuildingTile({ buildings, mats }: { buildings: Campus['buildings']; mats: { body: THREE.Material; line: THREE.Material } }) {
  const { geo, edges } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = []
    for (const b of buildings) {
      const g = new THREE.ExtrudeGeometry(shape(b.pts), { depth: b.h, bevelEnabled: false })
      g.rotateX(-Math.PI / 2)
      const roof = new THREE.Color(b.roof)
      const wall = b.event ? WALL_EVENT : WALL
      paint(g, (ny) => (ny > 0.5 ? roof : wall))
      g.deleteAttribute('uv')
      parts.push(g)
      // Darker roof band on top of the walls for a chunky toy-town silhouette.
      const s = new THREE.ExtrudeGeometry(shape(b.pts), { depth: 1.2, bevelEnabled: false })
      s.rotateX(-Math.PI / 2)
      s.translate(0, b.h, 0)
      const band = roof.clone().multiplyScalar(0.78)
      paint(s, (ny) => (ny > 0.5 ? roof : band))
      s.deleteAttribute('uv')
      parts.push(s)
    }
    const geo = mergeGeometries(parts)!
    parts.forEach((p) => p.dispose())
    geo.computeBoundingSphere()
    const edges = new THREE.EdgesGeometry(geo, 35)
    return { geo, edges }
  }, [buildings])
  useEffect(() => () => {
    geo.dispose()
    edges.dispose()
  }, [geo, edges])
  return (
    <group>
      <mesh geometry={geo} material={mats.body} castShadow receiveShadow />
      <lineSegments geometry={edges} material={mats.line} />
    </group>
  )
}

function Buildings({ campus, near }: { campus: Campus; near: Set<string> }) {
  const ramp = useToonRamp()
  const mats = useMemo(
    () => ({
      body: withCutaway(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp }), { windows: [WALL, WALL_EVENT] }),
      line: new THREE.LineBasicMaterial({ color: '#2b2a33' }), // (outlines have no normals, so no shader patch)
    }),
    [ramp],
  )
  const tiles = useMemo(() => byTile(campus.buildings, (b) => b.pts[0]), [campus])
  return (
    <group>
      {[...tiles].filter(([k]) => near.has(k)).map(([k, bs]) => (
        <BuildingTile key={k} buildings={bs} mats={mats} />
      ))}
    </group>
  )
}

function ribbon(pts: Pt[], w: number, y: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]
    const [bx, bz] = pts[i + 1]
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 0.01) continue
    const g = new THREE.PlaneGeometry(len + w * 0.5, w)
    g.rotateX(-Math.PI / 2)
    g.rotateY(-Math.atan2(bz - az, bx - ax))
    g.translate((ax + bx) / 2, y, (az + bz) / 2)
    g.deleteAttribute('uv')
    out.push(g)
    // Round joint so bends don't show gaps.
    const c = new THREE.CircleGeometry(w / 2, 10)
    c.rotateX(-Math.PI / 2)
    c.translate(bx, y, bz)
    c.deleteAttribute('uv')
    out.push(c)
  }
  return out
}

function Ground({ campus }: { campus: Campus }) {
  const { areas, roads, paths } = useMemo(() => {
    const sorted = [...campus.areas].sort(
      (a, b) => (AREA_LAYER[a.kind] ?? 0) - (AREA_LAYER[b.kind] ?? 0),
    )
    const areaParts = sorted.flatMap((a, i) => {
      const color = AREA_COLOR[a.kind]
      if (!color) return []
      const g = new THREE.ShapeGeometry(shape(a.pts))
      g.rotateX(-Math.PI / 2)
      g.translate(0, 0.02 + i * 0.00005, 0)
      paint(g, () => new THREE.Color(color))
      g.deleteAttribute('uv')
      return [g]
    })
    const roadParts = campus.roads.filter((r) => !r.foot).flatMap((r) => ribbon(r.pts, r.w, 0.06))
    const pathParts = campus.roads.filter((r) => r.foot).flatMap((r) => ribbon(r.pts, r.w, 0.08))
    return {
      areas: worldUV(mergeGeometries(areaParts)!, 6),
      roads: worldUV(mergeGeometries(roadParts)!, 5),
      paths: worldUV(mergeGeometries(pathParts)!, 2.4),
    }
  }, [campus])
  const tex = useMemo(() => {
    const grass = grassTexture()
    const [x0, z0, x1, z1] = campus.bounds
    grass.repeat.set((x1 - x0 + 800) / 5, (z1 - z0 + 800) / 5) // 5 m tiles
    return { grass, detail: detailTexture(), asphalt: asphaltTexture(), pavers: paverTexture() }
  }, [campus])

  const [x0, z0, x1, z1] = campus.bounds
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} receiveShadow>
        <planeGeometry args={[x1 - x0 + 800, z1 - z0 + 800]} />
        <meshLambertMaterial map={tex.grass} />
      </mesh>
      <mesh geometry={areas} receiveShadow>
        <meshLambertMaterial vertexColors map={tex.detail} />
      </mesh>
      <mesh geometry={roads} receiveShadow>
        <meshLambertMaterial color="#b9bdc8" map={tex.asphalt} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      <mesh geometry={paths} receiveShadow>
        <meshLambertMaterial map={tex.pavers} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
    </group>
  )
}

/** A fast "is (x, z) at least `pad` metres clear of every road and path edge" test. */
function roadClearance(campus: Campus) {
  // coarse grid of road/path samples for "too close to a road" checks
  const CELL = 8
  const grid = new Map<string, [number, number, number][]>()
  for (const r of campus.roads)
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, az] = r.pts[i - 1]
      const [bx, bz] = r.pts[i]
      const L = Math.hypot(bx - ax, bz - az)
      for (let t = 0; t <= L; t += 2) {
        const x = ax + ((bx - ax) * t) / L
        const z = az + ((bz - az) * t) / L
        const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`
        const list = grid.get(k) ?? []
        list.push([x, z, r.w / 2])
        grid.set(k, list)
      }
    }
  const clearOfRoads = (x: number, z: number, pad: number) => {
    const gx = Math.floor(x / CELL)
    const gz = Math.floor(z / CELL)
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const [rx, rz, hw] of grid.get(`${gx + i},${gz + j}`) ?? []) if (Math.hypot(x - rx, z - rz) < hw + pad) return false
    return true
  }
  return clearOfRoads
}

/**
 * Street trees: the OSM trees plus a row along the footpaths every ~16 m (alternating
 * sides), kept clear of buildings, roads, paths and the HackGT entrance shells.
 */
function useTreePoints(campus: Campus) {
  return useMemo(() => {
    const pts: [number, number][] = campus.trees.map(([x, z]) => [x, z])
    const coll = new Collider(campus)
    const clearOfRoads = roadClearance(campus)
    const shells = campus.event?.entrances ?? []
    const taken = (x: number, z: number) => pts.some(([px, pz]) => Math.abs(px - x) < 6 && Math.abs(pz - z) < 6)
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
          if (coll.blocked(x, z, 2.5) || !clearOfRoads(x, z, 1.8)) continue
          if (shells.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 9) || taken(x, z)) continue
          pts.push([x, z])
        }
      }
    }
    return pts
  }, [campus])
}

/** Park benches and warm lamp posts along the footpaths (instanced: one draw each). */
function StreetFurniture({ campus, near }: { campus: Campus; near: Set<string> }) {
  const ramp = useToonRamp()
  const spots = useMemo(() => {
    const coll = new Collider(campus)
    const clear = roadClearance(campus)
    const shells = campus.event?.entrances ?? []
    const lamps: [number, number][] = []
    const benches: [number, number, number][] = []
    const near = (list: [number, number, ...number[]][], x: number, z: number, d: number) => list.some(([px, pz]) => Math.hypot(px - x, pz - z) < d)
    for (const r of campus.roads) {
      if (!r.foot) continue
      for (let i = 1; i < r.pts.length; i++) {
        const [ax, az] = r.pts[i - 1]
        const [bx, bz] = r.pts[i]
        const L = Math.hypot(bx - ax, bz - az)
        if (L < 6) continue
        const nx = -(bz - az) / L
        const nz = (bx - ax) / L
        for (let t = 4; t < L; t += 30) {
          const side = (Math.floor(t / 30) + i) % 2 ? 1 : -1
          const px = ax + ((bx - ax) * t) / L
          const pz = az + ((bz - az) * t) / L
          // a lamp right at the path edge
          const lx = px + nx * (r.w / 2 + 0.7) * side
          const lz = pz + nz * (r.w / 2 + 0.7) * side
          if (!coll.blocked(lx, lz, 1) && clear(lx, lz, 0.5) && !near(lamps, lx, lz, 12) && !shells.some(([sx, sz]) => Math.hypot(lx - sx, lz - sz) < 6)) lamps.push([lx, lz])
          // every other stop, a bench on the other side, facing the path
          const bt = t + 11
          if (bt >= L || (Math.floor(t / 30) % 2)) continue
          const qx = ax + ((bx - ax) * bt) / L - nx * (r.w / 2 + 1.1) * side
          const qz = az + ((bz - az) * bt) / L - nz * (r.w / 2 + 1.1) * side
          if (!coll.blocked(qx, qz, 1.4) && clear(qx, qz, 0.7) && !near(benches, qx, qz, 18) && !shells.some(([sx, sz]) => Math.hypot(qx - sx, qz - sz) < 7))
            benches.push([qx, qz, Math.atan2(nx * side, nz * side)])
        }
      }
    }
    return { lamps, benches }
  }, [campus])

  const kit = useMemo(() => {
    const parts: THREE.BufferGeometry[] = []
    const box = (sz: THREE.Vector3Tuple, p: THREE.Vector3Tuple) => {
      const g = new THREE.BoxGeometry(...sz)
      g.translate(...p)
      parts.push(g.toNonIndexed())
    }
    for (const x of [-0.7, 0.7]) {
      box([0.08, 0.45, 0.5], [x, 0.225, 0])
      box([0.08, 0.5, 0.06], [x, 0.7, -0.24])
    }
    for (const z of [-0.18, 0, 0.18]) box([1.8, 0.05, 0.14], [0, 0.47, z])
    for (const y of [0.65, 0.85]) box([1.8, 0.1, 0.04], [0, y, -0.26])
    // one lamp = pole + shade + glowing globe, pre-merged per material (low poly)
    const pole = new THREE.CylinderGeometry(0.07, 0.1, 3.8, 6)
    pole.translate(0, 1.9, 0)
    const shade = new THREE.CylinderGeometry(0.32, 0.22, 0.1, 8)
    shade.translate(0, 3.72, 0)
    const globe = new THREE.SphereGeometry(0.28, 8, 6)
    globe.translate(0, 3.95, 0)
    return {
      bench: mergeGeometries(parts)!,
      post: mergeGeometries([pole.toNonIndexed(), shade.toNonIndexed()])!,
      globe,
      dark: new THREE.MeshToonMaterial({ color: '#2c3a4a', gradientMap: ramp }),
      glow: new THREE.MeshBasicMaterial({ color: '#ffe7a8', toneMapped: false }),
      wood: new THREE.MeshToonMaterial({ color: '#a86f3e', gradientMap: ramp }),
    }
  }, [ramp])
  const lampTiles = useMemo(() => byTile(spots.lamps, (p) => p), [spots])
  const benchTiles = useMemo(() => byTile(spots.benches, (p) => [p[0], p[1]]), [spots])
  return (
    <group>
      {[...lampTiles].filter(([k]) => near.has(k)).map(([k, pts]) => (
        <group key={`l${k}`}>
          {[kit.post, kit.globe].map((g, gi) => (
            <instancedMesh
              key={gi}
              args={[g, gi ? kit.glow : kit.dark, pts.length]}
              castShadow={gi === 0}
              ref={(mesh) => {
                if (!mesh) return
                const m = new THREE.Matrix4()
                pts.forEach(([x, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, 0, z)))
                finishInstances(mesh)
              }}
            />
          ))}
        </group>
      ))}
      {[...benchTiles].filter(([k]) => near.has(k)).map(([k, pts]) => (
        <instancedMesh
          key={`b${k}`}
          args={[kit.bench, kit.wood, pts.length]}
          castShadow
          receiveShadow
          ref={(mesh) => {
            if (!mesh) return
            const m = new THREE.Matrix4()
            pts.forEach(([x, z, r], i) => mesh.setMatrixAt(i, m.makeRotationY(r).setPosition(x, 0, z)))
            finishInstances(mesh)
          }}
        />
      ))}
    </group>
  )
}

function Trees({ campus, near }: { campus: Campus; near: Set<string> }) {
  const ramp = useToonRamp()
  const trees = useTreePoints(campus)
  const kit = useMemo(() => {
    const trunk = new THREE.CylinderGeometry(0.35, 0.45, 2.2, 6)
    const top = new THREE.IcosahedronGeometry(1, 0)
    return { trunk, top, bark: new THREE.MeshToonMaterial({ color: '#8a5a3b', gradientMap: ramp }), leaf: new THREE.MeshToonMaterial({ gradientMap: ramp }) }
  }, [ramp])
  const tiles = useMemo(() => byTile(trees, (p) => p), [trees])
  const place = (mesh: THREE.InstancedMesh | null, top: boolean, pts: [number, number][]) => {
    if (!mesh) return
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    pts.forEach(([x, z], i) => {
      // Deterministic per-tree size/tint from its position.
      const k = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1
      const s = 0.8 + k * 0.6
      if (top) {
        m.makeScale(s * 2.6, s * 2.9, s * 2.6).setPosition(x, 3.4 * s + 1.2, z)
        mesh.setColorAt(i, c.setHSL(0.3 + k * 0.06, 0.55, 0.36 + k * 0.1))
      } else {
        m.makeScale(s, s, s).setPosition(x, 1.1 * s, z)
      }
      mesh.setMatrixAt(i, m)
    })
    finishInstances(mesh)
  }
  return (
    <group>
      {[...tiles].filter(([k]) => near.has(k)).map(([k, pts]) => (
        <group key={k}>
          <instancedMesh ref={(m) => place(m, false, pts)} args={[kit.trunk, kit.bark, pts.length]} castShadow />
          <instancedMesh ref={(m) => place(m, true, pts)} args={[kit.top, kit.leaf, pts.length]} castShadow />
        </group>
      ))}
    </group>
  )
}

/** Golden light pillar + floating sign over Klaus, visible across campus. */
function EventBeacon({ campus, onOpen }: { campus: Campus; onOpen: () => void }) {
  const ev = campus.event
  const sign = useRef<THREE.Group>(null!)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (sign.current) sign.current.position.y = ev!.h + 16 + Math.sin(t * 1.6) * 1.2
  })
  if (!ev) return null
  const [cx, cz] = ev.center
  return (
    <group position={[cx, 0, cz]}>
      <mesh position={[0, 120, 0]}>
        <cylinderGeometry args={[3, 3, 240, 16, 1, true]} />
        <meshBasicMaterial color="#ffd23f" transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <group ref={sign}>
        <Billboard>
          <Html center distanceFactor={60} zIndexRange={[10, 0]}>
            <button className="event-sign" onClick={onOpen}>
              <span className="event-sign-title">HackGT</span>
              <span className="event-sign-sub">@ Klaus</span>
            </button>
          </Html>
        </Billboard>
      </group>
    </group>
  )
}

export function World({ campus, onOpenEvent, focus, active = true }: { campus: Campus; onOpenEvent: () => void; focus: React.MutableRefObject<{ x: number; z: number }>; active?: boolean }) {
  const near = useNearTiles(focus, active)
  return (
    <group>
      <Ground campus={campus} />
      <Buildings campus={campus} near={near} />
      <Trees campus={campus} near={near} />
      <StreetFurniture campus={campus} near={near} />
      <EventBeacon campus={campus} onOpen={onOpenEvent} />
    </group>
  )
}
