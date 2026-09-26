import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Html } from '@react-three/drei'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Campus, Pt } from './map'
import { withCutaway } from './cutaway'
import { detailTexture, worldUV } from './campusTextures'
import { dataMap, detailMap } from './realTextures'

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

function Buildings({ campus }: { campus: Campus }) {
  const ramp = useToonRamp()
  const mats = useMemo(
    () => ({
      body: withCutaway(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp }), { windows: [WALL, WALL_EVENT] }),
      line: new THREE.LineBasicMaterial({ color: '#2b2a33' }), // (outlines have no normals, so no shader patch)
    }),
    [ramp],
  )
  const { geo, edges } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = []
    for (const b of campus.buildings) {
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
    const edges = new THREE.EdgesGeometry(geo, 35)
    return { geo, edges }
  }, [campus])

  return (
    <group>
      <mesh geometry={geo} material={mats.body} castShadow receiveShadow />
      <lineSegments geometry={edges} material={mats.line} />
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
    // real photographed surfaces (Poly Haven), used as detail over the campus palette
    const [x0, z0, x1, z1] = campus.bounds
    const gx = (x1 - x0 + 800) / 4 // 4 m grass tiles
    const gz = (z1 - z0 + 800) / 4
    return {
      grass: detailMap('leafy_grass_diff_1k', gx, gz, 0.55, 0.92),
      grassN: dataMap('leafy_grass_nor_gl_1k', gx, gz),
      detail: detailTexture(),
      asphalt: detailMap('asphalt_02_diff_1k', 1, 1, 0.6, 0.9),
      asphaltN: dataMap('asphalt_02_nor_gl_1k', 1, 1),
      pavers: detailMap('brick_pavement_02_diff_1k', 1, 1, 0.55, 0.92),
      paversN: dataMap('brick_pavement_02_nor_gl_1k', 1, 1),
    }
  }, [campus])

  const [x0, z0, x1, z1] = campus.bounds
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} receiveShadow>
        <planeGeometry args={[x1 - x0 + 800, z1 - z0 + 800]} />
        <meshLambertMaterial color="#8fd06f" map={tex.grass} normalMap={tex.grassN} normalScale={[0.8, 0.8]} />
      </mesh>
      <mesh geometry={areas} receiveShadow>
        <meshLambertMaterial vertexColors map={tex.detail} />
      </mesh>
      <mesh geometry={roads} receiveShadow>
        <meshLambertMaterial color="#aab0bb" map={tex.asphalt} normalMap={tex.asphaltN} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      <mesh geometry={paths} receiveShadow>
        <meshLambertMaterial color="#e8d2a6" map={tex.pavers} normalMap={tex.paversN} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
    </group>
  )
}

function Trees({ campus }: { campus: Campus }) {
  const ramp = useToonRamp()
  const n = campus.trees.length

  const place = (mesh: THREE.InstancedMesh | null, top: boolean) => {
    if (!mesh) return
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    campus.trees.forEach(([x, z], i) => {
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
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  return (
    <group>
      <instancedMesh
        ref={(m) => place(m, false)}
        args={[undefined, undefined, n]}
        castShadow
      >
        <cylinderGeometry args={[0.35, 0.45, 2.2, 6]} />
        <meshToonMaterial color="#8a5a3b" gradientMap={ramp} />
      </instancedMesh>
      <instancedMesh
        ref={(m) => place(m, true)}
        args={[undefined, undefined, n]}
        castShadow
      >
        <icosahedronGeometry args={[1, 0]} />
        <meshToonMaterial gradientMap={ramp} />
      </instancedMesh>
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

export function World({ campus, onOpenEvent }: { campus: Campus; onOpenEvent: () => void }) {
  return (
    <group>
      <Ground campus={campus} />
      <Buildings campus={campus} />
      <Trees campus={campus} />
      <EventBeacon campus={campus} onOpen={onOpenEvent} />
    </group>
  )
}
