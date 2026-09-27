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
  const open = talks.length > 0
  useEffect(() => {
    dispatchEvent(new CustomEvent('talk-open', { detail: open }))
  }, [open])
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

  // everyone's agent talks: opted in automatically, no switch
  useEffect(() => {
    if (opt && opt.live && !opt.on) void setOptIn(true).then((o) => o && setOpt(o))
  }, [opt])

  return (
    <>
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
