import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Html } from '@react-three/drei'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Collider, type Campus, type Pt } from './map'
import { withCutaway } from './cutaway'
import { asphaltTexture, detailTexture, dirtTexture, grassTexture, worldUV } from './campusTextures'
import { TILE, byTile, finishInstances, roadClearance, tileKey, useNearTiles, useToonRamp } from './campusKit'
import { Butterflies, Flowers, PokeTrees, SMALL_CELL, SMALL_RADIUS, TallGrass, TREE_CELL, TREE_RADIUS, WindClock, pathMaterial, usePlacements, waterMaterial } from './overworld'

const WALL = new THREE.Color('#f4ead2')
const WALL_EVENT = new THREE.Color('#fff4c9')

// Pokémon-route palette. Lawns (grass, parks, gardens...) aren't listed: they're left to
// the tiled grass underneath so every lawn shares the same bright checker.
const AREA_COLOR: Record<string, string> = {
  pitch: '#93e274', stadium: '#93e274', track: '#ec8a5e', sports_centre: '#a2e585',
  wood: '#3f9e4c', forest: '#3f9e4c', scrub: '#5fbd52', water: '#4fb6f2', sand: '#f3e0a4', parking: '#d3d6dd',
  fitness_centre: '#a2e585',
}
// Draw order (lower first) so e.g. a pitch sits on top of the park around it.
const AREA_LAYER: Record<string, number> = { parking: 1, pitch: 3, track: 2, water: 4, sand: 4 }

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

/**
 * A flat strip along a polyline (with round joints), carrying `aEdge`: 0 on the centre
 * line, ±1 at the edges, which the path material uses to crumble its edges into the grass.
 */
function ribbon(pts: Pt[], w: number, y: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []
  const edged = (g: THREE.BufferGeometry, fn: (u: number, v: number) => number) => {
    const uv = g.getAttribute('uv')
    const e = new Float32Array(uv.count)
    for (let i = 0; i < uv.count; i++) e[i] = fn(uv.getX(i), uv.getY(i))
    g.setAttribute('aEdge', new THREE.BufferAttribute(e, 1))
    g.deleteAttribute('uv')
    return g
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]
    const [bx, bz] = pts[i + 1]
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 0.01) continue
    const g = new THREE.PlaneGeometry(len + w * 0.5, w)
    g.rotateX(-Math.PI / 2)
    g.rotateY(-Math.atan2(bz - az, bx - ax))
    g.translate((ax + bx) / 2, y, (az + bz) / 2)
    out.push(edged(g, (_u, v) => v * 2 - 1))
    // Round joint so bends don't show gaps.
    const c = new THREE.CircleGeometry(w / 2, 8)
    c.rotateX(-Math.PI / 2)
    c.translate(bx, y, bz)
    out.push(edged(c, (u, v) => Math.hypot(u * 2 - 1, v * 2 - 1)))
  }
  return out
}

// The ground is streamed like everything else: parks, roads and paths are cut into tiles and
// only the ones within GROUND_RADIUS of you are built and drawn (the whole map is ~400k
// vertices; the overworld camera never sees past ~150 m). Areas bigger than a couple of
// tiles are drawn always, so a big park never vanishes at the edge of the range.
const GROUND_RADIUS = 280

type GroundArea = { a: Campus['areas'][number]; i: number }
type GroundSeg = { a: Pt; b: Pt; w: number; foot: boolean }
type GroundMats = ReturnType<typeof groundMaterials>

function groundMaterials(campus: Campus) {
  const grass = grassTexture()
  const [x0, z0, x1, z1] = campus.bounds
  grass.repeat.set((x1 - x0 + 800) / 4, (z1 - z0 + 800) / 4) // 2 m tiles, 2 x 2 per texture
  const dirt = dirtTexture()
  const rim = pathMaterial(dirt, '#d9b87e', 0.4, 'rim')
  rim.polygonOffsetFactor = rim.polygonOffsetUnits = -3
  const path = pathMaterial(dirt, '#ffffff', 0.18, 'path')
  path.polygonOffsetFactor = path.polygonOffsetUnits = -4
  return {
    grass,
    rim,
    path,
    water: waterMaterial(),
    areas: new THREE.MeshLambertMaterial({ vertexColors: true, map: detailTexture() }),
    curbs: new THREE.MeshLambertMaterial({ color: '#eef0f2', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    roads: new THREE.MeshLambertMaterial({ color: '#d2d5dc', map: asphaltTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  }
}

/** One tile's worth of ground (or the always-drawn big areas). */
function GroundPiece({ areas, segs, mats }: { areas: GroundArea[]; segs: GroundSeg[]; mats: GroundMats }) {
  const geo = useMemo(() => {
    const flat = (kinds: (k: string) => boolean) =>
      areas.flatMap(({ a, i }) => {
        const color = AREA_COLOR[a.kind]
        if (!color || !kinds(a.kind)) return []
        const g = new THREE.ShapeGeometry(shape(a.pts))
        g.rotateX(-Math.PI / 2)
        g.translate(0, 0.02 + i * 0.00005, 0)
        paint(g, () => new THREE.Color(color))
        g.deleteAttribute('uv')
        return [g]
      })
    const merge = (parts: THREE.BufferGeometry[]) => (parts.length ? mergeGeometries(parts) : null)
    const cars = segs.filter((r) => !r.foot)
    const foot = segs.filter((r) => r.foot)
    const lay = (list: GroundSeg[], extra: number, y: number) => list.flatMap((r) => ribbon([r.a, r.b], r.w + extra, y))
    const uv = (g: THREE.BufferGeometry | null, size: number) => g && worldUV(g, size)
    return {
      areas: uv(merge(flat((k) => k !== 'water')), 6),
      water: merge(flat((k) => k === 'water')),
      // light kerb under every road, then the road; a darker sandy rim under every
      // footpath, then the path (drawn in that order so crossings stay clean)
      curbs: merge(lay(cars, 0.9, 0.05)),
      roads: uv(merge(lay(cars, 0, 0.06)), 5),
      rims: uv(merge(lay(foot, 0.7, 0.07)), 4),
      paths: uv(merge(lay(foot, 0, 0.08)), 4),
    }
  }, [areas, segs])
  useEffect(
    () => () => {
      for (const g of Object.values(geo)) g?.dispose()
    },
    [geo],
  )
  return (
    <group>
      {geo.areas && <mesh geometry={geo.areas} material={mats.areas} receiveShadow />}
      {geo.water && <mesh geometry={geo.water} material={mats.water} receiveShadow />}
      {geo.curbs && <mesh geometry={geo.curbs} material={mats.curbs} receiveShadow />}
      {geo.roads && <mesh geometry={geo.roads} material={mats.roads} receiveShadow />}
      {geo.rims && <mesh geometry={geo.rims} material={mats.rim} receiveShadow />}
      {geo.paths && <mesh geometry={geo.paths} material={mats.path} receiveShadow />}
    </group>
  )
}

function Ground({ campus, near }: { campus: Campus; near: Set<string> }) {
  const tiles = useMemo(() => {
    const sorted = [...campus.areas].sort((a, b) => (AREA_LAYER[a.kind] ?? 0) - (AREA_LAYER[b.kind] ?? 0))
    const big: GroundArea[] = []
    const areas = new Map<string, GroundArea[]>()
    const segs = new Map<string, GroundSeg[]>()
    const add = <T,>(m: Map<string, T[]>, k: string, v: T) => {
      const list = m.get(k)
      if (list) list.push(v)
      else m.set(k, [v])
    }
    sorted.forEach((a, i) => {
      if (!AREA_COLOR[a.kind]) return
      const xs = a.pts.map((p) => p[0])
      const zs = a.pts.map((p) => p[1])
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
      if (x1 - x0 > TILE * 2 || z1 - z0 > TILE * 2) big.push({ a, i })
      else add(areas, tileKey((x0 + x1) / 2, (z0 + z1) / 2), { a, i })
    })
    for (const r of campus.roads)
      for (let k = 1; k < r.pts.length; k++) {
        const a = r.pts[k - 1]
        const b = r.pts[k]
        add(segs, tileKey((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), { a, b, w: r.w, foot: r.foot })
      }
    return { big, areas, segs, keys: [...new Set([...areas.keys(), ...segs.keys()])] }
  }, [campus])
  const mats = useMemo(() => groundMaterials(campus), [campus])
  const none: never[] = []
  const [x0, z0, x1, z1] = campus.bounds
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} receiveShadow>
        <planeGeometry args={[x1 - x0 + 800, z1 - z0 + 800]} />
        <meshLambertMaterial map={mats.grass} />
      </mesh>
      {tiles.big.length > 0 && <GroundPiece areas={tiles.big} segs={none} mats={mats} />}
      {tiles.keys
        .filter((k) => near.has(k))
        .map((k) => (
          <GroundPiece key={k} areas={tiles.areas.get(k) ?? none} segs={tiles.segs.get(k) ?? none} mats={mats} />
        ))}
    </group>
  )
}

/** Park benches and warm lamp posts along the footpaths (instanced: one draw each), streamed like the trees. */
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
  const lampTiles = useMemo(() => byTile(spots.lamps, (p) => p, TREE_CELL), [spots])
  const benchTiles = useMemo(() => byTile(spots.benches, (p) => [p[0], p[1]], TREE_CELL), [spots])
  return (
    <group>
      {[...lampTiles].filter(([k]) => near.has(k)).map(([k, pts]) => (
        <group key={`l${k}`}>
          {[kit.post, kit.globe].map((g, gi) => (
            <instancedMesh
              key={gi}
              args={[g, gi ? kit.glow : kit.dark, pts.length]}
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

/** Golden light pillar + floating sign over Klaus, visible across campus. */
function EventBeacon({ campus, onOpen, active }: { campus: Campus; onOpen: () => void; active: boolean }) {
  const ev = campus.event
  const sign = useRef<THREE.Group>(null!)
  useFrame(({ clock }) => {
    if (!active) return // inside Klaus: the campus is hidden, nothing to animate
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
          <Html center distanceFactor={60} zIndexRange={[10, 0]} style={{ display: active ? undefined : 'none' }}>
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
  const near = useNearTiles(focus, active, TILE, GROUND_RADIUS)
  const nearTrees = useNearTiles(focus, active, TREE_CELL, TREE_RADIUS)
  const nearSmall = useNearTiles(focus, active, SMALL_CELL, SMALL_RADIUS)
  const place = usePlacements(campus)
  return (
    <group>
      <WindClock active={active} />
      <Ground campus={campus} near={near} />
      <Buildings campus={campus} near={near} />
      <PokeTrees trees={place.trees} near={nearTrees} />
      <TallGrass tufts={place.tufts} near={nearSmall} />
      <Flowers flowers={place.flowers} near={nearSmall} />
      <Butterflies flowers={place.flowers} near={nearSmall} />
      <StreetFurniture campus={campus} near={nearTrees} />
      <EventBeacon campus={campus} onOpen={onOpenEvent} active={active} />
    </group>
  )
}
