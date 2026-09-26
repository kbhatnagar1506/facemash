import { useEffect, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Architecture } from './hall/Architecture'
import { detailEverything } from './hall/detail'
import { batchStatic, snapshot } from './hall/batch'
import { compileHall, warmFrame, type Composer } from './hall/warm'
import { Atmosphere } from './hall/Atmosphere'
import { Decor } from './hall/Decor'
import { WestWall } from './hall/WestWall'
import { EastGlass } from './hall/EastGlass'
import { SponsorBeans } from './hall/SponsorBeans'

// The HackGT hall is its own multiplayer room: the Klaus atrium, rebuilt from
// on-site photos. It is drawn instead of the campus, centred on the origin.
export { CALIBRATION_SPOTS, HALL, HALL_BOUNDS, HALL_EXIT, HALL_SPAWN, HALL_YAW, HallCollider, PERSON_SCALE, cameraCeiling, nearestSpot, nearestTable, type Spot, type Table } from './hall/layout'
export { PHOTO_EVENT } from './hall/Decor'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Stays mounted while on campus (hidden) so its drei <Html> labels are never unmounted,
 * and so it can get ready to be walked into: `fx` is the hall's post-processing (mounted,
 * idle, while you're outside), `campus` the campus world, and `soon` is true while the
 * welcome stall (the way in) is open.
 */
export function HackGTHall({ active, fx, campus, soon }: { active: boolean; fx: RefObject<Composer | null>; campus: RefObject<THREE.Object3D | null>; soon: boolean }) {
  const root = useRef<THREE.Group>(null!)
  const { gl, scene, camera } = useThree()
  // the hidden warm-up frame: 'wait' until the shaders are in, then drawn once the stall opens
  const warm = useRef<{ state: 'wait' | 'want' | 'done'; composer: Composer | null }>({ state: 'wait', composer: null })
  useEffect(() => {
    // Give every surface real-scale texture (grain, fabric weave), then compile the atrium's
    // shaders and upload its textures in idle time while you're still on campus (see
    // hall/warm.ts), then fold everything that stayed put into a few big batches.
    let alive = true
    const live = () => alive
    const nowarm = location.search.includes('nowarm')
    const t0 = performance.now()
    const at = (ms: number) => sleep(Math.max(0, ms - (performance.now() - t0)))
    // never merge in the middle of the entrance cinematic (it's a one-off ~100 ms job)
    let cine = false
    const onCine = (e: Event) => (cine = !!(e as CustomEvent).detail)
    window.addEventListener('cinematic', onCine)
    const prep = async () => {
      if (!root.current) return false
      detailEverything(root.current)
      return nowarm || compileHall(gl, scene, camera, root.current, campus.current, live)
    }
    ;(async () => {
      await at(500)
      if (!alive || !(await prep())) return
      await at(2500) // pick up late-loading textures/props
      if (!alive || !(await prep())) return
      await at(3000)
      if (!alive || !root.current) return
      const snap = snapshot(root.current)
      await at(3800)
      while (alive && cine) await sleep(1000)
      if (!alive || !root.current) return
      if (!location.search.includes('nobatch')) {
        const r = batchStatic(root.current, snap)
        console.info(`[hall] batched ${r.folded} static meshes into ${r.batches} draws`)
      }
      if (!nowarm && (await prep())) warm.current.state = 'want'
    })()
    return () => {
      alive = false
      window.removeEventListener('cinematic', onCine)
    }
  }, [gl, scene, camera, campus])
  // Priority 0.5: after the scene updates, before the campus composer (priority 1) draws
  // the real frame over it.
  useFrame((_, dt) => {
    const w = warm.current
    const c = fx.current
    if (!c || active || !root.current) return
    // the post-processing was rebuilt (quality changed) since the warm-up: do it again
    if (w.state === 'done' && c !== w.composer) w.state = 'want'
    if (w.state !== 'want' || !soon) return
    w.state = 'done'
    w.composer = c
    warmFrame(camera, root.current, campus.current, c, gl, dt)
  }, 0.5)
  return (
    <group ref={root} visible={active}>
      {/* the mezzanine's downlights, as a soft shadowless top light so the lobby under the
          low ceiling isn't left dim when the sun can't reach it (hall only) */}
      <directionalLight position={[-6, 30, 30]} intensity={0.55} color="#fff3e2" />
      <Architecture />
      <Atmosphere />
      <Decor active={active} />
      <WestWall />
      <EastGlass />
      {active && <SponsorBeans />}
    </group>
  )
}
