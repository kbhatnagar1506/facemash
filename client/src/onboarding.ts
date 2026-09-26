import type { Me } from './account'

// Getting in: Enter → Sign in with Google → Connect your Muse → Make your bean → play.
// Guests skip the Muse step (it needs an account); anyone who already has a bean goes
// straight in (signed in: back where they left off).

export const MUSE_STEP = '/muse?onboard'
export const BEAN_STEP = '/avatar?onboard'

function hasLocalBean() {
  try {
    return !!localStorage.getItem('gt.look')
  } catch {
    return false
  }
}

/** After signing in (or on Enter while signed in). */
export function nextForMember(me: Me): string {
  return me.profile?.look || me.profile?.name ? '/play' : MUSE_STEP
}

/** Continuing without an account. */
export function nextForGuest(): string {
  return hasLocalBean() ? '/play' : BEAN_STEP
}
