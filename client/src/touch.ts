// The on-screen thumbstick (phones): where it's pushed, in screen space (x right, z down),
// each axis -1..1. The HUD writes it, the player reads it every frame like the WASD keys.
export const stick = { x: 0, z: 0, run: false }

/** A phone or tablet: touch is the main pointer and there's no hover. */
export const touchFirst = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (hover: none)').matches

/** A phone (touch first, small screen): fill rate and memory are what run out first. */
export const phone = () => touchFirst() && Math.min(screen.width, screen.height) < 600
