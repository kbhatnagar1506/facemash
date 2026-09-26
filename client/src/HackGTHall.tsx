import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { Architecture } from './hall/Architecture'
import { detailEverything } from './hall/detail'
import { batchStatic, snapshot } from './hall/batch'
import { Atmosphere } from './hall/Atmosphere'
import { Decor } from './hall/Decor'
import { WestWall } from './hall/WestWall'
import { EastGlass } from './hall/EastGlass'
import { SponsorBeans } from './hall/SponsorBeans'

// The HackGT hall is its own multiplayer room: the Klaus atrium, rebuilt from
// on-site photos. It is drawn instead of the campus, centred on the origin.
export { CALIBRATION_SPOTS, HALL, HALL_BOUNDS, HALL_EXIT, HALL_SPAWN, HALL_YAW, HallCollider, PERSON_SCALE, cameraCeiling, nearestSpot, nearestTable, type Spot, type Table } from './hall/layout'
export { PHOTO_EVENT } from './hall/Decor'

// Stays mounted while on campus (hidden) so its drei <Html> labels are never unmounted.
export function HackGTHall({ active }: { active: boolean }) {
  // Give every surface real-scale texture (grain, fabric weave) and compile all the
  // atrium's shaders up front while you're still on campus, so walking in (and the
  // cinematic) never stutters on shader compiles.
  const root = useRef<THREE.Group>(null!)
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    const prep = () => {
      if (!root.current) return
      detailEverything(root.current)
      const was = root.current.visible
      root.current.visible = true
      gl.compile(scene, camera)
      root.current.visible = was
    }
    // Then fold everything that stayed put into a few big batches (far fewer draw calls).
    let snap: ReturnType<typeof snapshot> | null = null
    const a = setTimeout(prep, 500)
    const b = setTimeout(prep, 2500) // pick up late-loading textures/props
    const c = setTimeout(() => root.current && (snap = snapshot(root.current)), 3000)
    const d = setTimeout(() => {
      if (!root.current || !snap || location.search.includes('nobatch')) return
      const r = batchStatic(root.current, snap)
      console.info(`[hall] batched ${r.folded} static meshes into ${r.batches} draws`)
    }, 3800)
    return () => {
      ;[a, b, c, d].forEach(clearTimeout)
    }
  }, [gl, scene, camera])
  return (
    <group ref={root} visible={active}>
      <Architecture />
      {active && <Atmosphere />}
      <Decor active={active} />
      <WestWall />
      <EastGlass />
      {active && <SponsorBeans />}
    </group>
  )
}
