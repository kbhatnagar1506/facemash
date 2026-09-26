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
      <Architecture />
      {active && <Atmosphere />}
      <Decor active={active} />
    </group>
  )
}
