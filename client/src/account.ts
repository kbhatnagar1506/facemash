// Your account, as the server sees it (/api/me): who you are, your saved name/colour/bean
// for this event, and where you were when you last played. Sign-in is Google only, and
// always optional: with no client ID configured, or offline, everyone plays as a guest.

export interface Me {
  googleClientId: string
  tenant?: string
  user: { name: string; given: string; email: string; picture: string } | null
  profile?: { name: string; color: string; look: string }
  progress?: { room: 'campus' | 'hackgt'; x: number; z: number; y: number; r: number; at: string } | null
  /** the voice guide is on (for people without a Muse) */
  voice?: boolean
  /** identifies you to the game socket, which lives on another host */
  ticket?: string
}

const GUEST: Me = { googleClientId: '', user: null }

let cached: Promise<Me> | null = null

/** One /api/me per page (refreshed after signing in or out). Never rejects. */
export function fetchMe(fresh = false): Promise<Me> {
  if (!cached || fresh) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 4000)
    cached = fetch('/api/me', { credentials: 'same-origin', signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : GUEST))
      .catch(() => GUEST)
      .finally(() => clearTimeout(t))
  }
  return cached
}

/** Trade a Google ID token for our session cookie. */
export async function signInWithGoogle(credential: string): Promise<Me> {
  const r = await fetch('/api/auth/google', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Sign-in failed')
  return fetchMe(true)
}

/** Signed in: save your name/bean to your account now (the game also saves them when you join). */
export function saveProfile(p: { name?: string; color?: string; look?: string }) {
  return fetch('/api/profile', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
    keepalive: true,
  }).catch(() => {})
}

export async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
  google()?.accounts.id.disableAutoSelect()
  await fetchMe(true)
}

// ---------- Google Identity Services ----------

interface GoogleId {
  accounts: {
    id: {
      initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup'; auto_select?: boolean; itp_support?: boolean; use_fedcm_for_button?: boolean }): void
      renderButton(el: HTMLElement, o: Record<string, unknown>): void
      disableAutoSelect(): void
    }
  }
}
const google = () => (window as unknown as { google?: GoogleId }).google

let gis: Promise<GoogleId> | null = null
/** Load Google's sign-in script once (it's only needed when someone is about to sign in). */
export function loadGoogle(): Promise<GoogleId> {
  if (!gis) {
    gis = new Promise((resolve, reject) => {
      if (google()) return resolve(google()!)
      const s = document.createElement('script')
      s.src = 'https://accounts.google.com/gsi/client'
      s.async = true
      s.onload = () => (google() ? resolve(google()!) : reject(new Error('Google sign-in unavailable')))
      s.onerror = () => {
        gis = null
        reject(new Error('Google sign-in unavailable'))
      }
      document.head.appendChild(s)
    })
  }
  return gis
}
