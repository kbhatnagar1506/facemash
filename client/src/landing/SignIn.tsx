import { useEffect, useRef, useState } from 'react'
import { loadGoogle, signInWithGoogle, type Me } from '../account'

// The door into the game: sign in with Google (which also creates your account the first
// time). There is no guest mode; signing in is what saves your bean and where you were.

/** `next` is where to go once signed in (it can depend on the account). `title`/`sub` let a
 *  page other than the landing say why it's asking (e.g. /muse). */
export function SignInSheet({
  clientId,
  next,
  onClose,
  title = 'Enter HackGT 13',
  sub = 'Sign in to keep your bean and pick up where you left off.',
}: {
  clientId: string
  next: string | ((me: Me) => string)
  onClose: () => void
  title?: string
  sub?: string
}) {
  const button = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    loadGoogle()
      .then((g) => {
        if (!live || !button.current) return
        g.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          itp_support: true,
          use_fedcm_for_button: true,
          callback: ({ credential }) => {
            setState('busy')
            signInWithGoogle(credential).then(
              (me) => (location.href = typeof next === 'string' ? next : next(me)),
              (e: Error) => {
                setError(e.message)
                setState('error')
              },
            )
          },
        })
        const width = Math.min(320, Math.round(button.current.clientWidth || 320))
        g.accounts.id.renderButton(button.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'center', width })
        setState('ready')
      })
      .catch((e: Error) => {
        if (!live) return
        setError(e.message)
        setState('error')
      })
    return () => {
      live = false
    }
  }, [clientId, next])

  // Esc closes; focus starts inside the dialog and returns where it was
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [onClose])

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabIndex={-1} ref={panel}>
        <button className="sheet-close" type="button" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3.5 3.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <h2 id="sheet-title">{title}</h2>
        <p className="sheet-sub">{sub}</p>
        <div className={state === 'busy' ? 'gbtn busy' : 'gbtn'} ref={button} aria-busy={state === 'loading' || state === 'busy'} />
        {state === 'error' && (
          <p className="sheet-error" role="alert">
            {error || 'Sign-in failed'}. Please try again.
          </p>
        )}
        <p className="sheet-legal">
          By continuing you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy{'\u00a0'}Policy</a>.
        </p>
      </div>
    </div>
  )
}
