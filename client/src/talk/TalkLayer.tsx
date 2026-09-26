// Agent talk in the game: the HUD switch ("Let my agent talk to people nearby") and, when a
// talk arrives over the game socket, the full-screen overlay (its own lazy chunk).

import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Net } from '../net'
import { TalkStore, getOptIn, setOptIn, type OptIn } from './talkState'

const TalkOverlay = lazy(() => import('./TalkOverlay'))

export function TalkLayer({ net, myLook }: { net: Net; myLook: string }) {
  const [store, setStore] = useState<TalkStore | null>(null)
  useEffect(() => {
    const s = new TalkStore(net)
    setStore(s)
    return () => s.close()
  }, [net])
  const talks = useSyncExternalStore(store?.subscribe ?? noSub, store?.snapshot ?? noSnap)
  const [opt, setOpt] = useState<OptIn | null>(null)
  // refresh the "left today" count after each talk ends
  const ended = talks.filter((t) => t.phase !== 'talking').length
  useEffect(() => {
    let dead = false
    getOptIn().then((o) => !dead && o && setOpt(o))
    return () => {
      dead = true
    }
  }, [ended])

  return (
    <>
      {opt && opt.live && <TalkSwitch opt={opt} onChange={setOpt} />}
      {store &&
        talks.length > 0 &&
        createPortal(
          <Suspense fallback={null}>
            <TalkOverlay store={store} talk={talks[0]} myLook={myLook} />
          </Suspense>,
          document.body,
        )}
    </>
  )
}

const noTalks: never[] = []
const noSnap = () => noTalks
const noSub = () => () => {}

function TalkSwitch({ opt, onChange }: { opt: OptIn; onChange: (o: OptIn) => void }) {
  const [busy, setBusy] = useState(false)
  const flip = async () => {
    if (busy) return
    setBusy(true)
    const o = await setOptIn(!opt.on)
    setBusy(false)
    if (o) onChange(o)
  }
  const left = opt.limit ? `${opt.left ?? 0} agent talk${opt.left === 1 ? '' : 's'} left today` : ''
  return (
    <button type="button" className={opt.on ? 'talk-switch on' : 'talk-switch'} role="switch" aria-checked={opt.on} onClick={flip} disabled={busy}>
      <span className="talk-knob" aria-hidden />
      <span className="talk-label">
        Let my agent talk to people nearby
        {opt.on && left && <small>{left}</small>}
      </span>
    </button>
  )
}
