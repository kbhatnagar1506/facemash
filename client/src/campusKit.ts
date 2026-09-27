import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Campus } from './map'

// Shared helpers for the streamed campus: the tile grid, the "which tiles are near you"
// hook, the toon ramp and a few placement tests. Used by World.tsx and overworld.tsx.

/**
 * Streaming campus: the map is cut into TILE-metre tiles, and only the tiles near
 * you are built and drawn (buildings, trees, lamps, benches, grass, flowers). Far tiles
 * don't exist at all until you walk toward them, so startup is quick and the GPU only
 * ever works on the neighbourhood you're in.
 */
export const TILE = 240
const LOAD_RADIUS = 420 // metres around you that exist
export const tileKey = (x: number, z: number, cell = TILE) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`
/** Group items by tile (or by a smaller `cell`, for small things streamed on a tighter radius). */
export function byTile<T>(items: T[], at: (t: T) => [number, number], cell = TILE) {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const [x, z] = at(it)
    const k = tileKey(x, z, cell)
    const list = m.get(k)
    if (list) list.push(it)
    else m.set(k, [it])
  }
  return m
}

/**
 * Tile keys within `radius` of the player, re-checked twice a second. Small things
 * (grass, flowers) pass a smaller `cell` and `radius`: the overworld camera only ever
 * sees ~130 m around you, so there's no point drawing tufts further out.
 */
export function useNearTiles(focus: React.MutableRefObject<{ x: number; z: number }>, active: boolean, cell = TILE, radius = LOAD_RADIUS) {
  const calc = () => {
    const out: string[] = []
    const { x, z } = focus.current
    const r = Math.ceil(radius / cell) + 1
    const cx = Math.floor(x / cell)
    const cz = Math.floor(z / cell)
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const tx = (cx + i + 0.5) * cell
        const tz = (cz + j + 0.5) * cell
        if (Math.hypot(tx - x, tz - z) < radius + cell * 0.71) out.push(`${cx + i},${cz + j}`)
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

export function finishInstances(mesh: THREE.InstancedMesh) {
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
}

/** Toon shading ramp: 3 hard bands give the cel-shaded Pokémon look. */
export function useToonRamp() {
  return useMemo(() => {
    const tex = new THREE.DataTexture(new Uint8Array([120, 200, 255]), 3, 1, THREE.RedFormat)
    tex.minFilter = tex.magFilter = THREE.NearestFilter
    tex.needsUpdate = true
    return tex
  }, [])
}

/** Deterministic 0..1 hash of a position (same spot, same answer, every run). */
export function hash2(x: number, z: number, salt = 0) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453
  return s - Math.floor(s)
}

/** A fast "is (x, z) at least `pad` metres clear of every road and path edge" test. */
export function roadClearance(campus: Campus) {
  // coarse grid of road/path samples for "too close to a road" checks
  const CELL = 8
  const key = (gx: number, gz: number) => (gx + 32768) * 65536 + (gz + 32768) // numeric keys: no string garbage
  const grid = new Map<number, [number, number, number][]>()
  for (const r of campus.roads)
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, az] = r.pts[i - 1]
      const [bx, bz] = r.pts[i]
      const L = Math.hypot(bx - ax, bz - az)
      for (let t = 0; t <= L; t += 2) {
        const x = ax + ((bx - ax) * t) / L
        const z = az + ((bz - az) * t) / L
        const k = key(Math.floor(x / CELL), Math.floor(z / CELL))
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
        for (const [rx, rz, hw] of grid.get(key(gx + i, gz + j)) ?? []) {
          const r = hw + pad
          if ((x - rx) ** 2 + (z - rz) ** 2 < r * r) return false
        }
    return true
  }
  return clearOfRoads
}

/** Spatial hash of points for quick "anything within d metres?" checks. */
export class PointGrid {
  private cell: number
  private m = new Map<number, [number, number][]>()
  constructor(cell = 8) {
    this.cell = cell
  }
  add(x: number, z: number) {
    const k = (Math.floor(x / this.cell) + 32768) * 65536 + Math.floor(z / this.cell) + 32768
    const l = this.m.get(k)
    if (l) l.push([x, z])
    else this.m.set(k, [[x, z]])
  }
  near(x: number, z: number, d: number) {
    const r = Math.ceil(d / this.cell)
    const gx = Math.floor(x / this.cell)
    const gz = Math.floor(z / this.cell)
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++)
        for (const [px, pz] of this.m.get((gx + i + 32768) * 65536 + gz + j + 32768) ?? []) if ((px - x) ** 2 + (pz - z) ** 2 < d * d) return true
    return false
  }
}
