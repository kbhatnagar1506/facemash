import { Architecture } from './hall/Architecture'
import { Atmosphere } from './hall/Atmosphere'
import { Decor } from './hall/Decor'

// The HackGT hall is its own multiplayer room: the Klaus atrium, rebuilt from
// on-site photos. It is drawn instead of the campus, centred on the origin.
export { CALIBRATION_SPOTS, HALL, HALL_BOUNDS, HALL_EXIT, HALL_SPAWN, HALL_YAW, HallCollider, PERSON_SCALE, cameraCeiling, nearestSpot, nearestTable, type Spot, type Table } from './hall/layout'
export { PHOTO_EVENT } from './hall/Decor'

// Stays mounted while on campus (hidden) so its drei <Html> labels are never unmounted.
export function HackGTHall({ active }: { active: boolean }) {
  return (
    <group visible={active}>
      {/* warm indoor light from the ceiling downlights */}
      <pointLight position={[0, 17, -4]} intensity={active ? 120 : 0} distance={60} decay={1.6} color="#fff1d6" />
      <pointLight position={[-14, 4.2, -6]} intensity={active ? 25 : 0} distance={18} decay={1.6} color="#fff4e0" />
      <pointLight position={[0, 4.2, 24]} intensity={active ? 25 : 0} distance={16} decay={1.6} color="#fff4e0" />
      <Architecture />
      {active && <Atmosphere />}
      <Decor active={active} />
    </group>
  )
}
