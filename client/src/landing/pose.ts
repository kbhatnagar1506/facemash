import type { AvatarState } from '../Avatar'

/** What the scene asks of a bean each frame. */
export interface Pose {
  /** ground speed in world units per second */
  speed: number
  wave: boolean
  sit: boolean
  /** put the held item away (the phone goes in the pocket) */
  pocket: boolean
  /** reduced motion: a smaller cheer jump */
  calm: boolean
  /** shared with BeanBody: set av.cheer = performance.now() to start a cheer */
  av: AvatarState
}
export const makePose = (): Pose => ({ speed: 0, wave: false, sit: false, pocket: false, calm: false, av: { moving: false } })
